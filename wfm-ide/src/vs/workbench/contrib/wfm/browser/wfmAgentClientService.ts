/*---------------------------------------------------------------------------------------------
 *  WFM Studio contributions.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { listenStream } from '../../../../base/common/stream.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import {
	IWfmAgentChatReply,
	IWfmAgentClientService,
	IWfmChatExtras,
	IWfmExternalChatSubmission,
	IWfmFileAttachment,
	IWfmStreamCallbacks,
} from '../common/wfmAgentClient.js';

// 注意：写死 127.0.0.1 而不是 localhost。macOS 上 localhost 优先解析到 ::1 (IPv6)，
// 而 uvicorn 默认只绑 127.0.0.1 (IPv4)，Electron 的 net 模块不会像 curl 那样自动回退，
// 会直接报连接失败。要改 IPv6 需要后端显式 --host ::1 或 ::。
const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';

/**
 * 与 wfmChatViewPane 中 ViewPane.ID 同步；放在这里避免 service 反向 import
 * browser/wfmChatViewPane.ts 形成循环依赖。
 */
const WFM_CHAT_VIEW_ID = 'workbench.view.wfm.aiChat';

interface IRawChatReply {
	readonly role: 'assistant';
	readonly content: string;
	readonly workspace_root: string;
	readonly received_at: string;
	readonly session_id?: string;
}

interface IRawChatRequestBody {
	readonly workspace_root: string;
	readonly message: string;
	readonly session_id?: string;
	readonly dxf_text?: string;
	readonly dxf_source_uri?: string;
	readonly model?: string;
	readonly backend?: string;
	readonly attachments?: { readonly uri: string; readonly name: string; readonly rel_path?: string }[];
}

export class WfmAgentClientService extends Disposable implements IWfmAgentClientService {

	declare readonly _serviceBrand: undefined;

	readonly baseUrl: string = DEFAULT_BASE_URL;

	private _backendReady = false;
	private readonly _onBackendReady = this._register(new Emitter<boolean>());
	readonly onBackendReady: Event<boolean> = this._onBackendReady.event;
	get backendReady(): boolean { return this._backendReady; }

	private readonly _onExternalChatSubmission = this._register(
		new Emitter<IWfmExternalChatSubmission>(),
	);
	readonly onExternalChatSubmission: Event<IWfmExternalChatSubmission> =
		this._onExternalChatSubmission.event;

	private readonly _onExternalChatPrefill = this._register(
		new Emitter<string>(),
	);
	readonly onExternalChatPrefill: Event<string> =
		this._onExternalChatPrefill.event;

	private readonly _onExternalChatAttach = this._register(
		new Emitter<IWfmFileAttachment[]>(),
	);
	readonly onExternalChatAttach: Event<IWfmFileAttachment[]> =
		this._onExternalChatAttach.event;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();
		this._pollBackendReady();
	}

	private _pollBackendReady(): void {
		let attempts = 0;
		const maxAttempts = 30;
		const interval = setInterval(async () => {
			attempts++;
			const ready = await this.ping();
			if (ready) {
				this._backendReady = true;
				this._onBackendReady.fire(true);
				clearInterval(interval);
			} else if (attempts >= maxAttempts) {
				this.logService.warn('[wfm] backend did not become ready after 60s');
				clearInterval(interval);
			}
		}, 2000);
		this._register(toDisposable(() => clearInterval(interval)));
	}

	async chat(
		message: string,
		extras?: IWfmChatExtras,
		token: CancellationToken = CancellationToken.None,
		sessionId?: string,
		backend?: string,
	): Promise<IWfmAgentChatReply> {
		const workspaceRoot = this.getWorkspaceRoot();
		if (!workspaceRoot) {
			throw new Error('WFM Studio: 请先打开一个文件夹作为工作区（File → Open Folder）。');
		}

		const payload: IRawChatRequestBody = {
			workspace_root: workspaceRoot,
			message,
			...(sessionId ? { session_id: sessionId } : {}),
			...(extras?.dxfText ? { dxf_text: extras.dxfText } : {}),
			...(extras?.dxfSourceUri ? { dxf_source_uri: extras.dxfSourceUri } : {}),
			...(extras?.attachments?.length ? {
				attachments: extras.attachments.map(a => ({
					uri: a.uri,
					name: a.name,
					...(a.relPath ? { rel_path: a.relPath } : {}),
				})),
			} : {}),
		...(backend ? { backend } : {}),
		};
		const body = JSON.stringify(payload);
		this.logService.trace(
			`[wfm] POST ${this.baseUrl}/v1/chat (workspace=${workspaceRoot}, dxfInline=${!!extras?.dxfText})`,
		);

		const context = await this.requestService.request({
			type: 'POST',
			url: `${this.baseUrl}/v1/chat`,
			headers: { 'Content-Type': 'application/json' },
			data: body,
			callSite: 'wfm.agentClient.chat',
		}, token);

		const status = context.res.statusCode ?? 0;
		if (status < 200 || status >= 300) {
			const text = await asJson<{ detail?: string }>(context).catch(() => null);
			const detail = text?.detail ?? `HTTP ${status}`;
			throw new Error(`WFM Studio 后端错误: ${detail}`);
		}

		const raw = await asJson<IRawChatReply>(context);
		if (!raw) {
			throw new Error('WFM Studio 后端返回为空');
		}

		return {
			role: raw.role,
			content: raw.content,
			workspaceRoot: raw.workspace_root,
			receivedAt: raw.received_at,
			sessionId: raw.session_id,
		};
	}

	async chatStream(
		message: string,
		extras: IWfmChatExtras | undefined,
		token: CancellationToken,
		sessionId: string | undefined,
		callbacks: IWfmStreamCallbacks,
		model?: string,
		backend?: string,
	): Promise<void> {
		const workspaceRoot = this.getWorkspaceRoot();
		if (!workspaceRoot) {
			throw new Error('WFM Studio: 请先打开一个文件夹作为工作区（File → Open Folder）。');
		}

		const payload: IRawChatRequestBody = {
			workspace_root: workspaceRoot,
			message,
			...(sessionId ? { session_id: sessionId } : {}),
			...(extras?.dxfText ? { dxf_text: extras.dxfText } : {}),
			...(extras?.dxfSourceUri ? { dxf_source_uri: extras.dxfSourceUri } : {}),
			...(model ? { model } : {}),
			...(backend ? { backend } : {}),
			...(extras?.attachments?.length ? {
				attachments: extras.attachments.map(a => ({
					uri: a.uri,
					name: a.name,
					...(a.relPath ? { rel_path: a.relPath } : {}),
				})),
			} : {}),
		};
		const body = JSON.stringify(payload);
		this.logService.trace(
			`[wfm] POST ${this.baseUrl}/v1/chat/stream (workspace=${workspaceRoot})`,
		);

		const context = await this.requestService.request({
			type: 'POST',
			url: `${this.baseUrl}/v1/chat/stream`,
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'text/event-stream',
			},
			data: body,
			callSite: 'wfm.agentClient.chatStream',
		}, token);

		const status = context.res.statusCode ?? 0;
		if (status < 200 || status >= 300) {
			const text = await asJson<{ detail?: string }>(context).catch(() => null);
			const detail = text?.detail ?? `HTTP ${status}`;
			throw new Error(`WFM Studio 后端错误: ${detail}`);
		}

		await new Promise<void>((resolve, reject) => {
			let buffer = '';

			listenStream(context.stream, {
				onData: (vsBuffer) => {
					if (token.isCancellationRequested) {
						return;
					}
					buffer += vsBuffer.toString();
					while (true) {
						const frameEnd = buffer.indexOf('\n\n');
						if (frameEnd === -1) {
							break;
						}
						const frame = buffer.substring(0, frameEnd);
						buffer = buffer.substring(frameEnd + 2);
						for (const line of frame.split('\n')) {
							if (!line.startsWith('data: ')) {
								continue;
							}
							try {
								const json: { type: string; [key: string]: unknown } = JSON.parse(line.substring(6));
								this.dispatchSseEvent(json, callbacks);
							} catch (e) {
								this.logService.warn(`[wfm] SSE parse error: ${e}`);
							}
						}
					}
				},
				onError: (err) => {
					this.logService.warn(`[wfm] SSE stream error: ${err}`);
					callbacks.onError(err.message || String(err));
					reject(err);
				},
				onEnd: () => {
					resolve();
				},
			}, token);
		});
	}

	private dispatchSseEvent(
		json: { type: string; [key: string]: unknown },
		cb: IWfmStreamCallbacks,
	): void {
		switch (json.type) {
			case 'session':
				cb.onSession?.((json.session_id as string | null) ?? null);
				break;
			case 'thinking_delta':
				cb.onThinkingDelta?.((json.delta as string) ?? '');
				break;
			case 'text_delta':
				cb.onTextDelta((json.delta as string) ?? '');
				break;
			case 'tool_call_started':
				cb.onToolCallStarted(json.id as string, json.name as string);
				break;
			case 'tool_call_done':
				cb.onToolCallDone(json.id as string);
				break;
			case 'agent_handoff':
				cb.onAgentHandoff(json.agent as string);
				break;
			case 'done':
				cb.onDone((json.session_id as string | null) ?? null, (json.text as string) ?? '');
				break;
			case 'error':
				cb.onError((json.error as string) ?? 'Unknown error');
				break;
			default:
				this.logService.trace(`[wfm] unknown SSE event type: ${json.type}`);
		}
	}

	async submitExternalChat(submission: IWfmExternalChatSubmission): Promise<void> {
		try {
			await this.viewsService.openView(WFM_CHAT_VIEW_ID, /*focus*/ false);
		} catch (err) {
			this.logService.warn(`[wfm] openView(${WFM_CHAT_VIEW_ID}) failed: ${err}`);
		}
		this._onExternalChatSubmission.fire(submission);
	}

	async prefillChatInput(text: string): Promise<void> {
		try {
			await this.viewsService.openView(WFM_CHAT_VIEW_ID, /*focus*/ true);
		} catch (err) {
			this.logService.warn(`[wfm] openView(${WFM_CHAT_VIEW_ID}) failed: ${err}`);
		}
		this._onExternalChatPrefill.fire(text);
	}

	async attachFiles(files: IWfmFileAttachment[]): Promise<void> {
		try {
			await this.viewsService.openView(WFM_CHAT_VIEW_ID, /*focus*/ true);
		} catch (err) {
			this.logService.warn(`[wfm] openView(${WFM_CHAT_VIEW_ID}) failed: ${err}`);
		}
		this._onExternalChatAttach.fire(files);
	}

	async ping(token: CancellationToken = CancellationToken.None): Promise<boolean> {
		try {
			const context = await this.requestService.request({
				type: 'GET',
				url: `${this.baseUrl}/v1/health`,
				callSite: 'wfm.agentClient.ping',
			}, token);
			const status = context.res.statusCode ?? 0;
			return status >= 200 && status < 300;
		} catch (err) {
			this.logService.trace(`[wfm] ping failed: ${err}`);
			return false;
		}
	}

	private getWorkspaceRoot(): string | undefined {
		if (this.workspaceService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return undefined;
		}
		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		const uri = folders[0].uri;
		if (uri.scheme !== Schemas.file) {
			return undefined;
		}
		return uri.fsPath;
	}
}
