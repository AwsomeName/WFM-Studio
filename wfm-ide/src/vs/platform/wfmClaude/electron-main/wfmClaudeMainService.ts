/*---------------------------------------------------------------------------------------------
 *  WFM Studio — Claude Code CLI bridge service (main-process implementation).
 *
 *  Spawns the `claude` CLI with stream-json output, parses its NDJSON line by
 *  line, and re-emits normalised events through {@link IWfmClaudeService.onEvent}.
 *  See docs/ARCH_CHAT_CLAUDE_BRIDGE.md (TODO) for the protocol mapping.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import {
	IWfmClaudeEvent,
	IWfmClaudeImageAttachment,
	IWfmClaudeRunOptions,
	IWfmClaudeService,
} from '../common/wfmClaude.js';
import { IPCServer } from '../../../base/parts/ipc/common/ipc.js';
import { BrowserApiServer } from './browserApiServer.js';

interface IActiveTurn {
	readonly turnId: string;
	readonly process: ChildProcess;
	/** Per-turn temp dir holding materialised image attachments. Removed on exit. */
	readonly tempDir?: string;
	stopped: boolean;
}

/** Claude Code stream-json system prompt. Kept minimal; CAD/DOCX guidance lives in MCP tool descriptions. */
const SYSTEM_PROMPT = [
	"You are WFM Studio's AI assistant. You have access to WFM-specific MCP tools",
	"(prefixed with mcp__wfm__) for reading/writing workspace files, inspecting CAD",
	"drawings (DXF/DWG), and interacting with web pages through the integrated browser.",
	'',
	"Browser tools (mcp__wfm__browser_*) let you open URLs, read page content, click",
	"elements, type text, take screenshots, and navigate. Use them when users ask you",
	"to interact with websites.",
	'',
	"Always respond in the same language the user writes in (Chinese or English).",
].join('\n');

export class WfmClaudeMainService extends Disposable implements IWfmClaudeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onEvent = this._register(new Emitter<IWfmClaudeEvent>());
	readonly onEvent: Event<IWfmClaudeEvent> = this._onEvent.event;

	private readonly _turns = new Map<string, IActiveTurn>();
	private readonly _browserApiServer: BrowserApiServer;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
	) {
		super();
		this._browserApiServer = this._register(new BrowserApiServer(logService));
		this._browserApiServer.start().catch(err =>
			this.logService.warn(`[wfm-claude] browser API server failed to start: ${(err as Error).message}`)
		);
		this._register(toDisposable(() => this._killAll()));
	}

	/**
	 * Wire the browser API server up to the renderer-side `BrowserBridgeService`
	 * via the main process IPC server. Called once from `app.ts` after the
	 * main IPC server is constructed.
	 */
	attachIpcServer(ipcServer: IPCServer<string>): void {
		this._browserApiServer.attachIpcServer(ipcServer);
	}

	async runTurn(options: IWfmClaudeRunOptions): Promise<void> {
		const { turnId, workspaceRoot } = options;

		if (this._turns.has(turnId)) {
			throw new Error(`[wfm-claude] turnId already active: ${turnId}`);
		}

		if (!fs.existsSync(workspaceRoot)) {
			throw new Error(`[wfm-claude] workspaceRoot does not exist: ${workspaceRoot}`);
		}

		// Materialise inline image attachments to a per-turn temp dir and
		// prepend `@<path>` refs so claude actually sees them. Without this,
		// pasted images are silently dropped (the IChatRequestVariableEntry
		// of kind 'image' carries raw bytes that can't go through the CLI).
		const { prompt, tempDir } = this._stitchInlineImages(turnId, options.prompt, options.images);

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
			`resume=${options.sessionId ?? '-'}, cwd=${workspaceRoot}, ` +
			`images=${options.images?.length ?? 0})`,
		);

		let child: ChildProcess;
		try {
			const claudeBin = this._resolveClaudeBin();
			this.logService.info(`[wfm-claude] using binary: ${claudeBin}`);
			child = spawn(claudeBin, args, {
				cwd: workspaceRoot,
				env: { ...process.env },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			if (tempDir) {
				this._removeTempDir(tempDir);
			}
			throw new Error(`[wfm-claude] failed to spawn claude: ${(err as Error).message}`);
		}

		const turn: IActiveTurn = { turnId, process: child, tempDir, stopped: false };
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

	/**
	 * Write each inline image to `<os.tmpdir()>/wfm-claude/<turnId>/img-N.<ext>`
	 * and return a new prompt with `@<abs-path>` refs prepended. Returns the
	 * original prompt (and no tempDir) if there are no images.
	 *
	 * We do NOT delete the temp files inline — claude needs them at least until
	 * the model has read them. Cleanup happens on process exit (see _wireExit).
	 */
	private _stitchInlineImages(
		turnId: string,
		prompt: string,
		images: ReadonlyArray<IWfmClaudeImageAttachment> | undefined,
	): { prompt: string; tempDir: string | undefined } {
		if (!images || images.length === 0) {
			return { prompt, tempDir: undefined };
		}

		const tempDir = path.join(os.tmpdir(), 'wfm-claude', turnId);
		try {
			fs.mkdirSync(tempDir, { recursive: true });
		} catch (err) {
			this.logService.warn(`[wfm-claude] mkdir temp dir failed (${tempDir}): ${(err as Error).message}`);
			return { prompt, tempDir: undefined };
		}

		const refs: string[] = [];
		images.forEach((img, idx) => {
			const bytes = this._decodeImageBytes(img);
			if (!bytes) {
				this.logService.warn(`[wfm-claude] image attachment ${idx} has no usable bytes (dataBase64 length=${img.dataBase64?.length ?? 0})`);
				return;
			}
			const ext = this._extensionForImage(img, bytes);
			const filename = `img-${idx + 1}${ext}`;
			const absPath = path.join(tempDir, filename);
			try {
				fs.writeFileSync(absPath, bytes);
				const quoted = /\s/.test(absPath) ? `"${absPath}"` : absPath;
				refs.push(`@${quoted}`);
			} catch (err) {
				this.logService.warn(`[wfm-claude] failed to write image attachment ${idx}: ${(err as Error).message}`);
			}
		});

		if (refs.length === 0) {
			this._removeTempDir(tempDir);
			return { prompt, tempDir: undefined };
		}

		const head = refs.join(' ');
		return { prompt: prompt.length ? `${head}\n\n${prompt}` : head, tempDir };
	}

	/**
	 * Decode the base64 payload that crossed IPC back into raw bytes.
	 *
	 * Returns `undefined` when the payload is missing or malformed so the
	 * caller can skip the attachment instead of crashing the whole turn.
	 */
	private _decodeImageBytes(img: IWfmClaudeImageAttachment): Buffer | undefined {
		if (!img.dataBase64 || typeof img.dataBase64 !== 'string') {
			return undefined;
		}
		try {
			const buf = Buffer.from(img.dataBase64, 'base64');
			return buf.length > 0 ? buf : undefined;
		} catch {
			return undefined;
		}
	}

	private _extensionForImage(img: IWfmClaudeImageAttachment, bytes: Buffer): string {
		const mime = (img.mimeType ?? '').toLowerCase();
		switch (mime) {
			case 'image/png': return '.png';
			case 'image/jpeg':
			case 'image/jpg': return '.jpg';
			case 'image/gif': return '.gif';
			case 'image/webp': return '.webp';
			case 'image/bmp': return '.bmp';
			case 'image/svg+xml': return '.svg';
		}
		// Fall back to detecting from the byte magic number (covers pastes
		// where the upstream attachment didn't carry a mimeType).
		const detected = this._detectImageExtensionFromMagic(bytes);
		if (detected) {
			return detected;
		}
		// Last-resort: try to recover from the display name; else .png is a
		// safe bet — claude's image loader uses content sniffing too.
		const nameExt = img.name ? path.extname(img.name).toLowerCase() : '';
		return nameExt && /^\.(png|jpe?g|gif|webp|bmp|svg)$/.test(nameExt) ? nameExt : '.png';
	}

	private _detectImageExtensionFromMagic(buf: Uint8Array): string | undefined {
		if (buf.length < 4) {
			return undefined;
		}
		// PNG: 89 50 4E 47
		if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
			return '.png';
		}
		// JPEG: FF D8 FF
		if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
			return '.jpg';
		}
		// GIF: 47 49 46 38
		if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
			return '.gif';
		}
		// WEBP: "RIFF"…"WEBP"
		if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
			&& buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
			return '.webp';
		}
		// BMP: "BM"
		if (buf[0] === 0x42 && buf[1] === 0x4D) {
			return '.bmp';
		}
		return undefined;
	}

	private _removeTempDir(dir: string): void {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch (err) {
			this.logService.warn(`[wfm-claude] failed to remove temp dir ${dir}: ${(err as Error).message}`);
		}
	}

	private _buildMcpConfigJson(workspaceRoot: string, cadSourceUri: string | undefined): string {
		const env: Record<string, string> = { WFM_WORKSPACE_ROOT: workspaceRoot };
		if (cadSourceUri) {
			env.WFM_CAD_SOURCE_URI = cadSourceUri;
		}
		if (this._browserApiServer.port) {
			env.WFM_BROWSER_API_PORT = String(this._browserApiServer.port);
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

	private _resolveClaudeBin(): string {
		// Override via env var.
		const override = process.env.WFM_CLAUDE_BIN;
		if (override && fs.existsSync(override)) {
			return override;
		}

		const appRoot = this.environmentMainService.appRoot;
		// Packaged: claude-cli lives at Resources/claude-cli/claude (macOS .app layout).
		const packagedCli = path.resolve(appRoot, '..', 'claude-cli', 'claude');
		if (fs.existsSync(packagedCli)) {
			return packagedCli;
		}
		// Dev fallback: .build/claude-cli/claude relative to repo root.
		const devCli = path.resolve(appRoot, '..', '.build', 'claude-cli', 'claude');
		if (fs.existsSync(devCli)) {
			return devCli;
		}
		// Last resort: rely on PATH.
		return 'claude';
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
			if (turn.tempDir) {
				this._removeTempDir(turn.tempDir);
			}
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
			if (turn.tempDir) {
				this._removeTempDir(turn.tempDir);
			}
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
