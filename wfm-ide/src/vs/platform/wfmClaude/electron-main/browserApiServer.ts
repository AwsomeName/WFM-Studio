/*---------------------------------------------------------------------------------------------
 *  WFM Studio — Browser API Bridge for MCP tools.
 *
 *  Lightweight HTTP server running in the main process that exposes browser
 *  operations (open, navigate, click, type, read, screenshot, etc.) so the
 *  Python MCP server can drive the embedded WebContentsView over localhost.
 *
 *  Implementation: this server is *just* an HTTP-to-IPC adapter. The actual
 *  work happens in the renderer process, in `BrowserBridgeService`, which
 *  drives `IPlaywrightService` and opens `BrowserEditorInput` tabs in the
 *  main editor area (so the user sees the page and can interact manually,
 *  including solving CAPTCHAs alongside the AI).
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IPCServer, StaticRouter } from '../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../log/common/log.js';

const BRIDGE_CHANNEL_NAME = 'wfmBrowserBridge';

interface IBridgeChannel {
	call<T>(command: string, arg?: unknown): Promise<T>;
}

export class BrowserApiServer extends Disposable {

	private _server: http.Server | undefined;
	private _port: number = 0;
	get port(): number { return this._port; }

	private _bridgeChannel: IBridgeChannel | undefined;

	constructor(
		private readonly logService: ILogService,
	) {
		super();
	}

	/**
	 * Attach the channel that fronts the renderer-side `IBrowserBridgeService`.
	 *
	 * Called once from the app bootstrap after `mainProcessElectronServer` is
	 * ready. We use a "route to first available" router because there is only
	 * ever one workbench window servicing this bridge.
	 */
	attachIpcServer(ipcServer: IPCServer<string>): void {
		const router = new StaticRouter<string>(() => true);
		this._bridgeChannel = ipcServer.getChannel(BRIDGE_CHANNEL_NAME, router);
	}

	async start(): Promise<number> {
		this._server = http.createServer((req, res) => this._handleRequest(req, res));
		this._server.listen(0, '127.0.0.1');

		return new Promise<number>((resolve, reject) => {
			this._server!.once('listening', () => {
				const addr = this._server!.address();
				if (addr && typeof addr === 'object') {
					this._port = addr.port;
					this.logService.info(`[browser-api] listening on 127.0.0.1:${this._port}`);
					resolve(this._port);
				} else {
					reject(new Error('Failed to get server port'));
				}
			});
			this._server!.once('error', reject);
		});
	}

	override dispose(): void {
		this._server?.close();
		super.dispose();
	}

	// ── request routing ──────────────────────────────────────────────

	private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (req.method !== 'POST') {
			this._jsonResponse(res, 405, { error: 'Method not allowed' });
			return;
		}

		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const body = await this._readBody(req);
		let params: Record<string, unknown>;
		try {
			params = JSON.parse(body || '{}');
		} catch {
			this._jsonResponse(res, 400, { error: 'Invalid JSON' });
			return;
		}

		try {
			const result = await this._route(url.pathname, params);
			this._jsonResponse(res, 200, result);
		} catch (err) {
			// Errors that cross the renderer → main IPC boundary often arrive as
			// plain objects `{ name, message, stack, ... }` rather than `Error`
			// instances (the prototype chain doesn't survive structured clone).
			// Falling back to `String(err)` for those would render "[object Object]"
			// and lose the useful diagnostic — so dig for `.message` explicitly.
			const message = this._extractMessage(err);
			this.logService.warn(`[browser-api] ${url.pathname} error: ${message}`);
			this._jsonResponse(res, 500, { error: message });
		}
	}

	private async _route(pathname: string, params: Record<string, unknown>): Promise<unknown> {
		if (!this._bridgeChannel) {
			throw new Error('Browser bridge not attached yet (workbench window not ready)');
		}
		switch (pathname) {
			case '/open': {
				const url = this._requireString(params, 'url');
				// Default reuseExisting=true matches the service-layer default.
				// Accept either snake_case or camelCase from the caller side.
				const reuseRaw = params.reuse_existing ?? params.reuseExisting;
				const reuseExisting = reuseRaw === undefined ? true : reuseRaw !== false;
				return this._bridgeChannel.call('open', [url, reuseExisting]);
			}
			case '/list_pages':
			case '/list': {
				return this._bridgeChannel.call('list', []);
			}
			case '/navigate': {
				const pageId = this._requireString(params, 'pageId');
				const url = this._requireString(params, 'url');
				return this._bridgeChannel.call('navigate', [pageId, url]);
			}
			case '/read': {
				const pageId = this._requireString(params, 'pageId');
				return this._bridgeChannel.call('read', [pageId]);
			}
			case '/screenshot': {
				const pageId = this._requireString(params, 'pageId');
				return this._bridgeChannel.call('screenshot', [pageId]);
			}
			case '/click': {
				const pageId = this._requireString(params, 'pageId');
				const selector = this._requireString(params, 'selector');
				const element = typeof params.element === 'string' ? params.element : '';
				return this._bridgeChannel.call('click', [pageId, selector, element]);
			}
			case '/click_native': {
				const pageId = this._requireString(params, 'pageId');
				const selector = this._requireString(params, 'selector');
				const element = typeof params.element === 'string' ? params.element : '';
				return this._bridgeChannel.call('clickNative', [pageId, selector, element]);
			}
			case '/type': {
				const pageId = this._requireString(params, 'pageId');
				const selector = this._requireString(params, 'selector');
				const text = this._requireString(params, 'text');
				const element = typeof params.element === 'string' ? params.element : '';
				return this._bridgeChannel.call('type', [pageId, selector, text, element]);
			}
			case '/type_native': {
				const pageId = this._requireString(params, 'pageId');
				const selector = this._requireString(params, 'selector');
				const text = this._requireString(params, 'text');
				const element = typeof params.element === 'string' ? params.element : '';
				return this._bridgeChannel.call('typeNative', [pageId, selector, text, element]);
			}
			case '/hover': {
				const pageId = this._requireString(params, 'pageId');
				const selector = this._requireString(params, 'selector');
				const element = typeof params.element === 'string' ? params.element : '';
				return this._bridgeChannel.call('hover', [pageId, selector, element]);
			}
			case '/dialog':
			case '/handle_dialog': {
				const pageId = this._requireString(params, 'pageId');
				const accept = params.accept === true;
				const text = typeof params.text === 'string' ? params.text : '';
				return this._bridgeChannel.call('dialog', [pageId, accept, text]);
			}
			case '/close': {
				const pageId = this._requireString(params, 'pageId');
				return this._bridgeChannel.call('close', [pageId]);
			}
			default:
				throw new Error(`Unknown endpoint: ${pathname}`);
		}
	}

	// ── helpers ──────────────────────────────────────────────────────

	private _extractMessage(err: unknown): string {
		if (err instanceof Error) {
			return err.message;
		}
		if (err && typeof err === 'object') {
			const obj = err as { message?: unknown; name?: unknown };
			if (typeof obj.message === 'string' && obj.message) {
				return obj.message;
			}
			if (typeof obj.name === 'string' && obj.name) {
				return obj.name;
			}
			try {
				return JSON.stringify(err);
			} catch {
				/* fall through */
			}
		}
		return String(err);
	}

	private _requireString(params: Record<string, unknown>, key: string): string {
		const v = params[key];
		if (typeof v !== 'string' || !v) {
			throw new Error(`Missing or invalid parameter: ${key}`);
		}
		return v;
	}

	private _readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	private _jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
		const data = JSON.stringify(body);
		res.writeHead(status, {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(data),
		});
		res.end(data);
	}
}
