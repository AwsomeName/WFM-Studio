/*---------------------------------------------------------------------------------------------
 *  WFM Studio — STEP → GLB converter (main-process implementation).
 *
 *  Spawns the bundled / dev `python3` to run `step_to_glb.py`, parses the JSON
 *  result, and resolves with metadata that the renderer can use to load the GLB.
 *
 *  The renderer is sandboxed and cannot call `child_process` itself; all such
 *  work is funnelled here via the {@link IWfmStepConverterService} IPC channel.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import {
	IWfmStepConverterService,
	IWfmStepConvertOptions,
	IWfmStepConvertResult,
} from '../common/wfmStepConverter.js';

const LOG = '[wfm-step-converter]';
const DEFAULT_TIMEOUT_MS = 120_000;

interface IRawConvertResult {
	ok: boolean;
	glbPath?: string;
	stepHash?: string;
	glbSize?: number;
	elapsedMs?: number;
	error?: string;
}

export class WfmStepConverterMainService extends Disposable implements IWfmStepConverterService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
	) {
		super();
	}

	async convertStepToGlb(options: IWfmStepConvertOptions): Promise<IWfmStepConvertResult> {
		const { stepPath, glbPath } = options;

		if (!fs.existsSync(stepPath)) {
			throw new Error(`STEP 文件不存在: ${stepPath}`);
		}

		const resolved = this._resolvePythonAndScript(options.workspaceRoots ?? []);
		if (!resolved) {
			throw new Error('未找到 STEP → GLB 转换器。请确认已安装 WFM Studio CAD 工具链（python + step_to_glb.py）。');
		}
		this.logService.info(`${LOG} python=${resolved.pythonPath} script=${resolved.scriptPath}`);

		try {
			fs.mkdirSync(path.dirname(glbPath), { recursive: true });
		} catch (err) {
			this.logService.warn(`${LOG} mkdir failed: ${(err as Error).message}`);
		}

		const t0 = Date.now();
		const result = await this._runScript(resolved.pythonPath, resolved.scriptPath, stepPath, glbPath);
		const elapsed = Date.now() - t0;

		if (!result.ok) {
			throw new Error(result.error || '未知转换错误');
		}

		let glbSize = result.glbSize ?? 0;
		if (!glbSize) {
			try { glbSize = fs.statSync(glbPath).size; } catch { /* ignore */ }
		}

		this.logService.info(`${LOG} converted in ${elapsed}ms, ${(glbSize / 1024).toFixed(1)} KB`);

		return {
			glbPath: result.glbPath ?? glbPath,
			stepHash: result.stepHash ?? '',
			glbSize,
			elapsedMs: result.elapsedMs ?? elapsed,
		};
	}

	// ── private ────────────────────────────────────────────────────────────

	private _runScript(
		pythonPath: string,
		scriptPath: string,
		stepPath: string,
		glbPath: string,
	): Promise<IRawConvertResult> {
		return new Promise((resolve, reject) => {
			let stdout = '';
			let stderr = '';
			let child;
			try {
				child = spawn(pythonPath, [scriptPath, stepPath, '--output', glbPath], {
					timeout: DEFAULT_TIMEOUT_MS,
					stdio: ['ignore', 'pipe', 'pipe'],
				});
			} catch (err) {
				reject(err as Error);
				return;
			}
			child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
			child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
			child.on('error', (err: Error) => reject(err));
			child.on('close', (code: number | null) => {
				const trimmed = stdout.trim();
				if (trimmed) {
					try {
						resolve(JSON.parse(trimmed) as IRawConvertResult);
						return;
					} catch {
						// fall through — script printed something that isn't JSON
					}
				}
				const msg = stderr.trim() || trimmed || `进程异常退出 (code=${code})`;
				reject(new Error(msg));
			});
		});
	}

	private _resolvePythonAndScript(extraRoots: readonly string[]): { pythonPath: string; scriptPath: string } | null {
		const tryPair = (py: string, sc: string): { pythonPath: string; scriptPath: string } | null => {
			if (!py || !sc) { return null; }
			try {
				if (fs.existsSync(py) && fs.existsSync(sc)) {
					return { pythonPath: py, scriptPath: sc };
				}
			} catch { /* ignore */ }
			return null;
		};

		// Strategy 1: explicit env overrides (also set by the packaged start.sh).
		const envPython = process.env.WFM_CAD_PYTHON;
		const envSkill = process.env.WFM_CAD_SKILL_DIR;
		if (envPython && envSkill) {
			const hit = tryPair(envPython, path.join(envSkill, 'scripts', 'step_to_glb.py'));
			if (hit) { return hit; }
		}

		const envAgentsRoot = process.env.WFM_AGENTS_ROOT;
		if (envAgentsRoot) {
			const candidate = this._pickInsideRoot(envAgentsRoot);
			if (candidate) { return candidate; }
		}

		// Strategy 2 & 3: walk up from appRoot looking for wfm-agents (dev) or wfm-backend (packaged).
		const appRoot = this.environmentMainService.appRoot;
		const searchRoots = new Set<string>();
		let dir = appRoot;
		for (let i = 0; i < 8; i++) {
			searchRoots.add(path.join(dir, 'wfm-agents'));
			searchRoots.add(path.join(dir, 'wfm-backend'));
			searchRoots.add(path.join(dir, '..', 'wfm-agents'));
			searchRoots.add(path.join(dir, '..', 'wfm-backend'));
			const next = path.dirname(dir);
			if (next === dir) { break; }
			dir = next;
		}
		// Packaged macOS app: <App>.app/Contents/Resources/wfm-backend (process.resourcesPath).
		const resourcesPath = (process as any).resourcesPath as string | undefined;
		if (resourcesPath) {
			searchRoots.add(path.join(resourcesPath, 'wfm-backend'));
		}

		for (const root of searchRoots) {
			const hit = this._pickInsideRoot(root);
			if (hit) { return hit; }
		}

		// Strategy 5: caller-supplied workspace roots (renderer hints).
		for (const ws of extraRoots) {
			const devPython = path.join(ws, 'wfm-agents', '.venv', 'bin', 'python3');
			const devScript = path.join(ws, 'third_party', 'text-to-cad', 'skills', 'cad', 'scripts', 'step_to_glb.py');
			const hit = tryPair(devPython, devScript);
			if (hit) { return hit; }
		}

		return null;
	}

	/**
	 * Try the dev-tree layout (`<root>/.venv/bin/python3` + sibling `third_party`)
	 * first, then the packaged layout (`<root>/python/bin/python3` + `<root>/skills`).
	 */
	private _pickInsideRoot(root: string): { pythonPath: string; scriptPath: string } | null {
		// dev: <repo>/wfm-agents → script lives under <repo>/third_party/...
		const devPython = path.join(root, '.venv', 'bin', 'python3');
		if (fs.existsSync(devPython)) {
			const repoRoot = path.dirname(root);
			const devScript = path.join(repoRoot, 'third_party', 'text-to-cad', 'skills', 'cad', 'scripts', 'step_to_glb.py');
			if (fs.existsSync(devScript)) {
				return { pythonPath: devPython, scriptPath: devScript };
			}
		}
		// packaged: <wfm-backend>/python/bin/python3 + <wfm-backend>/skills/cad/scripts/step_to_glb.py
		const packagedPython = path.join(root, 'python', 'bin', 'python3');
		const packagedScript = path.join(root, 'skills', 'cad', 'scripts', 'step_to_glb.py');
		if (fs.existsSync(packagedPython) && fs.existsSync(packagedScript)) {
			return { pythonPath: packagedPython, scriptPath: packagedScript };
		}
		return null;
	}
}
