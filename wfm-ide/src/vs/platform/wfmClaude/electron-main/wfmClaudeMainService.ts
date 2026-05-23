/*---------------------------------------------------------------------------------------------
 *  WFM Studio — Claude Code CLI bridge service (main-process implementation).
 *
 *  Spawns the `claude` CLI with stream-json output, parses its NDJSON line by
 *  line, and re-emits normalised events through {@link IWfmClaudeService.onEvent}.
 *  See docs/ARCH_CHAT_CLAUDE_BRIDGE.md (TODO) for the protocol mapping.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import {
	IWfmClaudeEvent,
	IWfmClaudeRunOptions,
	IWfmClaudeService,
} from '../common/wfmClaude.js';

interface IActiveTurn {
	readonly turnId: string;
	readonly process: ChildProcess;
	stopped: boolean;
}

/** Claude Code stream-json system prompt. Kept minimal; CAD/DOCX guidance lives in MCP tool descriptions. */
const SYSTEM_PROMPT = [
	"You are WFM Studio's AI assistant. You have access to WFM-specific MCP tools",
	"(prefixed with mcp__wfm__) for reading/writing workspace files and inspecting CAD",
	"drawings (DXF/DWG).",
	'',
	"Always respond in the same language the user writes in (Chinese or English).",
].join('\n');

export class WfmClaudeMainService extends Disposable implements IWfmClaudeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onEvent = this._register(new Emitter<IWfmClaudeEvent>());
	readonly onEvent: Event<IWfmClaudeEvent> = this._onEvent.event;

	private readonly _turns = new Map<string, IActiveTurn>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
	) {
		super();
		this._register(toDisposable(() => this._killAll()));
	}

	async runTurn(options: IWfmClaudeRunOptions): Promise<void> {
		const { turnId, prompt, workspaceRoot } = options;

		if (this._turns.has(turnId)) {
			throw new Error(`[wfm-claude] turnId already active: ${turnId}`);
		}

		if (!fs.existsSync(workspaceRoot)) {
			throw new Error(`[wfm-claude] workspaceRoot does not exist: ${workspaceRoot}`);
		}

		const model = options.model || process.env.WFM_CLAUDE_MODEL || 'sonnet';
		const mcpConfigJson = this._buildMcpConfigJson(workspaceRoot, options.cadSourceUri);

		const args = [
			'-p', prompt,
			'--output-format', 'stream-json',
			'--verbose',
			'--system-prompt', SYSTEM_PROMPT,
			'--mcp-config', mcpConfigJson,
			'--permission-mode', 'bypassPermissions',
			'--model', model,
		];
		if (options.sessionId) {
			args.push('--resume', options.sessionId);
		}

		this.logService.info(
			`[wfm-claude] spawning claude (turnId=${turnId}, model=${model}, ` +
			`resume=${options.sessionId ?? '-'}, cwd=${workspaceRoot})`,
		);

		let child: ChildProcess;
		try {
			child = spawn('claude', args, {
				cwd: workspaceRoot,
				env: { ...process.env },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			throw new Error(`[wfm-claude] failed to spawn 'claude' (is it on PATH?): ${(err as Error).message}`);
		}

		const turn: IActiveTurn = { turnId, process: child, stopped: false };
		this._turns.set(turnId, turn);

		this._wireStdout(turn, options.cadSourceUri);
		this._wireStderr(turn);
		this._wireExit(turn);
	}

	async cancelTurn(turnId: string): Promise<void> {
		const turn = this._turns.get(turnId);
		if (!turn) {
			return;
		}
		this.logService.info(`[wfm-claude] cancelling turn ${turnId}`);
		turn.stopped = true;
		try {
			turn.process.kill('SIGTERM');
		} catch (err) {
			this.logService.warn(`[wfm-claude] SIGTERM failed: ${(err as Error).message}`);
		}
		// Hard-kill if it didn't die within 3s
		setTimeout(() => {
			if (turn.process.exitCode === null) {
				try { turn.process.kill('SIGKILL'); } catch { /* ignore */ }
			}
		}, 3000);
	}

	// ── private helpers ─────────────────────────────────────────────────

	private _buildMcpConfigJson(workspaceRoot: string, cadSourceUri: string | undefined): string {
		const env: Record<string, string> = { WFM_WORKSPACE_ROOT: workspaceRoot };
		if (cadSourceUri) {
			env.WFM_CAD_SOURCE_URI = cadSourceUri;
		}

		const moduleSearchRoot = this._resolveAgentsRoot();
		const pythonExe = this._resolvePythonExe(moduleSearchRoot);

		return JSON.stringify({
			mcpServers: {
				wfm: {
					command: pythonExe,
					args: ['-m', 'wfm_agents.agent_v2.wfm_mcp_server'],
					type: 'stdio',
					env: {
						...env,
						PYTHONPATH: moduleSearchRoot,
					},
				},
			},
		});
	}

	private _resolvePythonExe(agentsRoot: string): string {
		// Override wins.
		const override = process.env.WFM_PYTHON;
		if (override && fs.existsSync(override)) {
			return override;
		}
		// In dev we expect a uv-managed venv at <agentsRoot>/.venv.
		const venvPython = path.join(agentsRoot, '.venv', 'bin', 'python3');
		if (fs.existsSync(venvPython)) {
			return venvPython;
		}
		// Packaged builds ship a python under <agentsRoot>/python/bin/python3.
		const packagedPython = path.join(agentsRoot, 'python', 'bin', 'python3');
		if (fs.existsSync(packagedPython)) {
			return packagedPython;
		}
		// Last resort: rely on PATH.
		return 'python3';
	}

	private _resolveAgentsRoot(): string {
		// appRoot in dev is the wfm-ide/ checkout (or its out/) — siblings to
		// wfm-agents/. In packaged builds we ship wfm-backend/ inside the .app
		// next to the IDE bundle.
		// Override via env WFM_AGENTS_ROOT for tests / atypical layouts.
		const override = process.env.WFM_AGENTS_ROOT;
		if (override && fs.existsSync(override)) {
			return override;
		}

		const appRoot = this.environmentMainService.appRoot;
		const candidates = [
			path.resolve(appRoot, '..', 'wfm-agents'),         // dev: appRoot = .../wfm-ide
			path.resolve(appRoot, '..', '..', 'wfm-agents'),   // dev: appRoot = .../wfm-ide/out
			path.resolve(appRoot, '..', 'wfm-backend'),        // packaged: Resources/app/.. layout
			path.resolve(appRoot, 'wfm-backend'),              // packaged alt
		];
		for (const c of candidates) {
			if (fs.existsSync(path.join(c, 'wfm_agents', 'agent_v2', 'wfm_mcp_server.py'))) {
				return c;
			}
		}
		// Best-effort fallback so the spawn error surfaces a useful path.
		return candidates[0];
	}

	private _wireStdout(turn: IActiveTurn, cadSourceUri: string | undefined): void {
		// Claude can emit very large NDJSON events (tool results containing
		// entire DXF text). 'data' chunks may carry partial lines, so we buffer
		// ourselves rather than using readline (which has a 64 KiB hard limit).
		let buf = '';
		const pendingToolNames = new Map<string, string>();

		turn.process.stdout?.on('data', (data: Buffer) => {
			buf += data.toString('utf8');
			let nl: number;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) {
					continue;
				}
				try {
					this._handleNdjsonLine(turn.turnId, line, pendingToolNames, cadSourceUri);
				} catch (err) {
					this.logService.warn(`[wfm-claude] ndjson parse error: ${(err as Error).message}`);
				}
			}
		});
	}

	private _handleNdjsonLine(
		turnId: string,
		line: string,
		pendingToolNames: Map<string, string>,
		_cadSourceUri: string | undefined,
	): void {
		const event = JSON.parse(line);
		const etype = event.type;

		if (etype === 'system' && event.subtype === 'init' && event.session_id) {
			this._onEvent.fire({ turnId, kind: 'session', sessionId: event.session_id });
			return;
		}

		if (etype === 'assistant') {
			const blocks = event.message?.content ?? [];
			for (const block of blocks) {
				if (block.type === 'thinking') {
					this._onEvent.fire({ turnId, kind: 'thinking_delta', delta: block.thinking ?? '' });
				} else if (block.type === 'text') {
					this._onEvent.fire({ turnId, kind: 'text_delta', delta: block.text ?? '' });
				} else if (block.type === 'tool_use') {
					const toolName = this._stripMcpPrefix(block.name ?? '');
					pendingToolNames.set(block.id, toolName);
					this._onEvent.fire({
						turnId,
						kind: 'tool_started',
						toolCallId: block.id,
						toolName,
						toolInput: JSON.stringify(block.input ?? {}),
					});
				}
			}
			return;
		}

		if (etype === 'user') {
			const blocks = event.message?.content ?? [];
			for (const block of blocks) {
				if (block.type === 'tool_result') {
					const toolCallId = block.tool_use_id ?? '';
					const summary = this._summariseToolOutput(block.content);
					this._onEvent.fire({
						turnId,
						kind: 'tool_done',
						toolCallId,
						outputSummary: summary,
					});
					pendingToolNames.delete(toolCallId);
				}
			}
			return;
		}

		if (etype === 'result') {
			if (event.is_error) {
				this._onEvent.fire({
					turnId,
					kind: 'error',
					message: typeof event.result === 'string' ? event.result : 'Unknown error',
				});
			} else {
				this._onEvent.fire({
					turnId,
					kind: 'done',
					sessionId: event.session_id,
					finalText: typeof event.result === 'string' ? event.result : '',
				});
			}
			return;
		}
	}

	private _stripMcpPrefix(name: string): string {
		const p = 'mcp__wfm__';
		return name.startsWith(p) ? name.slice(p.length) : name;
	}

	private _summariseToolOutput(content: unknown): string {
		if (content === null || content === undefined) {
			return '';
		}
		const text = typeof content === 'string' ? content : JSON.stringify(content);
		return text.length > 200 ? text.slice(0, 197) + '...' : text;
	}

	private _wireStderr(turn: IActiveTurn): void {
		turn.process.stderr?.on('data', (data: Buffer) => {
			const msg = data.toString('utf8').trimEnd();
			if (!msg) { return; }
			this.logService.warn(`[wfm-claude:stderr ${turn.turnId}] ${msg}`);
		});
	}

	private _wireExit(turn: IActiveTurn): void {
		turn.process.on('exit', (code, signal) => {
			this._turns.delete(turn.turnId);
			this.logService.info(
				`[wfm-claude] turn ${turn.turnId} exited (code=${code}, signal=${signal})`,
			);
			if (!turn.stopped && (code ?? 0) !== 0) {
				this._onEvent.fire({
					turnId: turn.turnId,
					kind: 'error',
					message: `claude exited with code=${code} signal=${signal}`,
				});
			}
		});

		turn.process.on('error', (err) => {
			this._turns.delete(turn.turnId);
			this.logService.error(`[wfm-claude] turn ${turn.turnId} spawn error: ${err.message}`);
			this._onEvent.fire({
				turnId: turn.turnId,
				kind: 'error',
				message: `spawn error: ${err.message}`,
			});
		});
	}

	private _killAll(): void {
		for (const turn of this._turns.values()) {
			try {
				turn.process.kill('SIGTERM');
			} catch {
				/* ignore */
			}
		}
		this._turns.clear();
	}
}
