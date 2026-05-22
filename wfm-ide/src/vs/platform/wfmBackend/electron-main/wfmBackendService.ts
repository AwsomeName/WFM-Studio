/*---------------------------------------------------------------------------------------------
 *  WFM Studio — Python backend process manager.
 *
 *  Manages the lifecycle of the wfm-agents uvicorn server bundled inside
 *  the macOS .app. In dev mode the backend is started separately via
 *  scripts/dev.sh, so this service is a no-op when start.sh is absent.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { ILifecycleMainService } from '../lifecycleMainService.js';

const MAX_RESTARTS = 3;

export class WfmBackendService extends Disposable {

	private _process: ChildProcess | null = null;
	private _restartCount = 0;
	private _stopped = false;

	constructor(
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(toDisposable(() => this.stop()));
	}

	start(): void {
		// Locate wfm-backend/start.sh relative to the .app bundle's Resources dir.
		// In dev mode appRoot is <repo>/wfm-ide/out; in packaged .app it is
		// <app>/Contents/Resources/app.
		const resourcesDir = path.join(this.environmentMainService.appRoot, '..');
		const startScript = path.join(resourcesDir, 'wfm-backend', 'start.sh');

		if (!fs.existsSync(startScript)) {
			this.logService.trace('[wfm-backend] start.sh not found, skipping (dev mode)');
			return;
		}

		this.logService.info(`[wfm-backend] starting: ${startScript}`);
		this._spawn(startScript);
	}

	stop(): void {
		this._stopped = true;
		if (this._process) {
			this.logService.info('[wfm-backend] stopping...');
			this._process.kill('SIGTERM');
			this._process = null;
		}
	}

	private _spawn(startScript: string): void {
		const child = spawn('bash', [startScript], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env },
		});

		this._process = child;

		child.stdout?.on('data', (data: Buffer) => {
			this.logService.trace(`[wfm-backend:out] ${data.toString().trimEnd()}`);
		});

		child.stderr?.on('data', (data: Buffer) => {
			const msg = data.toString().trimEnd();
			// uvicorn startup lines are info-level, real errors go to error
			if (msg.includes('ERROR') || msg.includes('Traceback')) {
				this.logService.error(`[wfm-backend:err] ${msg}`);
			} else {
				this.logService.trace(`[wfm-backend:err] ${msg}`);
			}
		});

		child.on('exit', (code, signal) => {
			this.logService.info(`[wfm-backend] exited (code=${code}, signal=${signal})`);

			if (!this._stopped && !this._store.isDisposed) {
				if (this._restartCount < MAX_RESTARTS) {
					this._restartCount++;
					this.logService.info(`[wfm-backend] restarting (attempt ${this._restartCount}/${MAX_RESTARTS})...`);
					setTimeout(() => this._spawn(startScript), 2000);
				} else {
					this.logService.error(`[wfm-backend] giving up after ${MAX_RESTARTS} restarts`);
				}
			}
		});

		child.on('error', (err) => {
			this.logService.error(`[wfm-backend] spawn error: ${err.message}`);
		});
	}
}
