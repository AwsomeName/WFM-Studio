/*---------------------------------------------------------------------------------------------
 *  WFM Studio contributions.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IWfmAgentClientService = createDecorator<IWfmAgentClientService>('wfmAgentClientService');

export interface IWfmAgentChatReply {
	readonly role: 'assistant';
	readonly content: string;
	readonly workspaceRoot: string;
	readonly receivedAt: string;
}

/**
 * Optional payload that an external trigger (e.g. CAD viewer 工具栏「AI 审图」按钮)
 * can attach to a chat request. The backend `/v1/chat` route looks at
 * `dxfText` first and skips the workspace .dxf lookup when set.
 */
export interface IWfmChatExtras {
	/** In-browser 解析得到的完整 DXF 文本。后端会用 ezdxf 直接读这个串。 */
	readonly dxfText?: string;
	/** dxfText 的来源 URI（仅审计标识，不做磁盘解析）。 */
	readonly dxfSourceUri?: string;
}

/**
 * 由 CAD viewer / 其它 EditorPane 投递到右侧「任务对话」的请求。
 * - WfmChatViewPane 订阅 {@link IWfmAgentClientService.onExternalChatSubmission}
 *   后会自动打开自身 + 渲染用户/助手两条气泡 + 复用 chat() 调链路。
 * - viewer 不在自己 pane 里显示回复，避免成为迷你聊天框。
 */
export interface IWfmExternalChatSubmission {
	readonly message: string;
	readonly extras?: IWfmChatExtras;
	/** 用于 UI 展示「来自 xxx.dxf」的标签，可选。 */
	readonly originLabel?: string;
}

export interface IWfmAgentClientService {
	readonly _serviceBrand: undefined;

	/**
	 * Base URL of the local agent backend. Defaults to http://127.0.0.1:8765.
	 * Intentionally configurable for future tests / alt ports.
	 */
	readonly baseUrl: string;

	/**
	 * Send a chat message. The current workspace root (first folder of the
	 * active workspace) is auto-injected; callers never pass it explicitly.
	 *
	 * `extras.dxfText` 命中时，后端走 viewer_inline 分支，跳过工作区 .dxf
	 * lookup（v0.2）。
	 *
	 * Rejects if there is no open workspace folder or the backend is
	 * unreachable / returns a non-2xx status.
	 */
	chat(
		message: string,
		extras?: IWfmChatExtras,
		token?: CancellationToken,
	): Promise<IWfmAgentChatReply>;

	/**
	 * Minimal liveness check; returns true iff the backend responds 200 on
	 * /v1/health within a short timeout. Does not throw.
	 */
	ping(token?: CancellationToken): Promise<boolean>;

	/**
	 * 由 CadViewerEditor 等外部 pane 调用，把一次请求"投递"到右侧任务对话。
	 *
	 * 实现会先 `IViewsService.openView` 打开聊天 pane（确保监听器已注册），
	 * 再通过 {@link onExternalChatSubmission} 把数据交给 pane 渲染并自动发送。
	 *
	 * 多次调用按 FIFO 投递；调用方不需要等待回复。
	 */
	submitExternalChat(submission: IWfmExternalChatSubmission): Promise<void>;

	/**
	 * 外部投递事件。WfmChatViewPane 在构造时订阅，自己负责渲染与调用 chat()。
	 */
	readonly onExternalChatSubmission: Event<IWfmExternalChatSubmission>;

	/**
	 * 打开聊天面板并预填输入框文本（不自动发送），让用户编辑后手动提交。
	 * 用于 Explorer 右键「发送到 WFM 对话」等场景。
	 */
	prefillChatInput(text: string): Promise<void>;

	/**
	 * 预填事件。WfmChatViewPane 订阅后将文本写入输入框并聚焦。
	 */
	readonly onExternalChatPrefill: Event<string>;
}
