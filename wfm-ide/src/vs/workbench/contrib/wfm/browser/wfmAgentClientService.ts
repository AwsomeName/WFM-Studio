/*---------------------------------------------------------------------------------------------
 *  WFM Studio contributions.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import {
	IWfmAgentChatReply,
	IWfmAgentClientService,
	IWfmChatExtras,
	IWfmExternalChatSubmission,
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
}

interface IRawChatRequestBody {
	readonly workspace_root: string;
	readonly message: string;
	readonly dxf_text?: string;
	readonly dxf_source_uri?: string;
}

export class WfmAgentClientService extends Disposable implements IWfmAgentClientService {

	declare readonly _serviceBrand: undefined;

	readonly baseUrl: string = DEFAULT_BASE_URL;

	private readonly _onExternalChatSubmission = this._register(
		new Emitter<IWfmExternalChatSubmission>(),
	);
	readonly onExternalChatSubmission: Event<IWfmExternalChatSubmission> =
		this._onExternalChatSubmission.event;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();
	}

	async chat(
		message: string,
		extras?: IWfmChatExtras,
		token: CancellationToken = CancellationToken.None,
	): Promise<IWfmAgentChatReply> {
		const workspaceRoot = this.getWorkspaceRoot();
		if (!workspaceRoot) {
			throw new Error('WFM Studio: 请先打开一个文件夹作为工作区（File → Open Folder）。');
		}

		const payload: IRawChatRequestBody = {
			workspace_root: workspaceRoot,
			message,
			...(extras?.dxfText ? { dxf_text: extras.dxfText } : {}),
			...(extras?.dxfSourceUri ? { dxf_source_uri: extras.dxfSourceUri } : {}),
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
		};
	}

	async submitExternalChat(submission: IWfmExternalChatSubmission): Promise<void> {
		// 先把右侧任务对话面板打开 / focus。openView 会触发 view 实例化，
		// 进而触发 view 构造里对 onExternalChatSubmission 的订阅；只有这一步
		// 完成后 fire 才能被 view 接到（首次冷启动场景）。
		try {
			await this.viewsService.openView(WFM_CHAT_VIEW_ID, /*focus*/ false);
		} catch (err) {
			this.logService.warn(`[wfm] openView(${WFM_CHAT_VIEW_ID}) failed: ${err}`);
		}
		this._onExternalChatSubmission.fire(submission);
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

	/**
	 * Returns the first workspace folder as an absolute filesystem path, or
	 * undefined when no folder is open (empty workbench / untitled workspace
	 * without folders).
	 */
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
			// Only local disk workspaces are supported for Step B. Remote /
			// vscode-vfs workspaces will need a dedicated protocol later.
			return undefined;
		}
		return uri.fsPath;
	}
}
