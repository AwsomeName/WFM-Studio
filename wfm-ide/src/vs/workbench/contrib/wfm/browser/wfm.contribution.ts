/*---------------------------------------------------------------------------------------------
 *  WFM Studio contributions.
 *
 *  Adds WFM-specific Explorer context-menu actions that route through the
 *  upstream Chat UI (wired to the local Claude Code CLI by
 *  contrib/wfm/electron-browser/wfmClaudeAgent.contribution.ts).
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IChatWidget } from '../../chat/browser/chat.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ExplorerFolderContext } from '../../files/common/files.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { ChatViewId, IChatWidgetService } from '../../chat/browser/chat.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { IChatSessionsService } from '../../chat/common/chatSessionsService.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { getChatSessionType } from '../../chat/common/model/chatUri.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

/**
 * Reveal the Chat view (right-side AuxiliaryBar) and return the focused widget.
 */
async function revealChatWidget(accessor: ServicesAccessor): Promise<IChatWidget | undefined> {
	const viewsService = accessor.get(IViewsService);
	const chatWidgetService = accessor.get(IChatWidgetService);

	await viewsService.openView(ChatViewId, true);

	const widget = chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)[0]
		?? chatWidgetService.lastFocusedWidget;
	widget?.focusInput();
	return widget;
}

//#region --- Explorer 右键菜单: 发送到对话 (任意非目录文件) ---

class SendFileToChatAction extends Action2 {
	constructor() {
		super({
			id: 'wfm.explorer.sendToChat',
			title: localize2('wfm.explorer.sendToChat', "发送到对话"),
			f1: false,
			menu: [{
				id: MenuId.ExplorerContext,
				group: 'navigation',
				order: 30,
				when: ExplorerFolderContext.negate(),
			}],
		});
	}

	async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		if (!URI.isUri(resource)) {
			return;
		}

		const widget = await revealChatWidget(accessor);
		if (!widget) {
			return;
		}

		widget.attachmentModel.addFile(resource);
	}
}

registerAction2(SendFileToChatAction);

//#endregion

//#region --- Explorer 右键菜单: AI 金额核对 (.docx) ---

class DocxAmountReviewAction extends Action2 {
	constructor() {
		super({
			id: 'wfm.docx.amountReview',
			title: localize2('docxAmountReview', "AI 金额核对"),
			f1: false,
			menu: [{
				id: MenuId.ExplorerContext,
				group: 'navigation',
				order: 25,
				when: ContextKeyExpr.and(
					ExplorerFolderContext.negate(),
					ContextKeyExpr.regex(ResourceContextKey.Extension.key, /\.docx$/i),
				),
			}],
		});
	}

	async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		if (!URI.isUri(resource)) {
			return;
		}

		const widget = await revealChatWidget(accessor);
		if (!widget) {
			return;
		}

		widget.attachmentModel.addFile(resource);
		widget.setInput(
			'请核对这份文档中的所有金额：逐行验证 数量×单价=合价，核对每个表格的小计，核对总计，' +
			'并交叉比对正文提及的金额与表格数据。',
		);
	}
}

registerAction2(DocxAmountReviewAction);

//#endregion

//#region --- 命令面板「WFM: Reset Chat Sessions Filter & Refresh」---
//
// 排障专用：当 chat 面板右侧 SESSIONS 一直显示 "No matching sessions" 时，
// 大概率是 PROFILE storage 里残留了 filter 排除项（providers / states / read），
// 而 "Reset Filter" 链接偶尔不能及时把存储清干净（time-of-check / 异步事件丢失等）。
//
// 这个 action 一次性做三件事：
//   1. 把 filter 用的 PROFILE storage key（`agentSessions.filterExcludes.<menuId>`）
//      全部 application/profile 两个 scope 都强制 remove
//   2. 触发 chatSessionsService.refreshChatSessionItems，对所有 provider 重新刷盘
//   3. 弹通知告诉用户清完了，请重开 chat 面板
//
// 用户操作路径：Cmd+Shift+P → "WFM: Reset Chat Sessions Filter & Refresh"

class WfmResetChatSessionsFilterAction extends Action2 {
	static readonly ID = 'wfm.chat.resetSessionsFilter';

	// agentSessionsFilter.ts 里硬编码的 storage key 前缀
	private static readonly FILTER_STORAGE_KEY_PREFIX = 'agentSessions.filterExcludes.';

	constructor() {
		super({
			id: WfmResetChatSessionsFilterAction.ID,
			title: localize2('wfm.chat.resetSessionsFilter', "WFM: Reset Chat Sessions Filter & Refresh"),
			category: localize2('wfm.category', 'WFM'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const storageService = accessor.get(IStorageService);
		const chatSessionsService = accessor.get(IChatSessionsService);
		const notificationService = accessor.get(INotificationService);

		// 1) 扫所有 PROFILE/APPLICATION scope storage key，把前缀匹配的全部 remove
		//    （正常只会有 1 个 `agentsessionsviewerfiltersubmenu`，但兼容多面板。）
		const scopes: StorageScope[] = [StorageScope.PROFILE, StorageScope.APPLICATION];
		let cleared = 0;
		for (const scope of scopes) {
			for (const key of storageService.keys(scope, StorageTarget.USER)) {
				if (key.startsWith(WfmResetChatSessionsFilterAction.FILTER_STORAGE_KEY_PREFIX)) {
					storageService.remove(key, scope);
					cleared++;
				}
			}
		}

		// 2) 强制 controllers 重新刷新所有 provider 的 session items
		await chatSessionsService.refreshChatSessionItems(undefined, CancellationToken.None);

		notificationService.notify({
			severity: Severity.Info,
			message: cleared > 0
				? `已清空 ${cleared} 个 chat sessions filter 存储项并刷新列表。请关闭再重新打开 Chat 视图。`
				: '没有发现残留的 filter 存储项；已强制刷新一次 SESSIONS 列表。',
		});
	}
}

registerAction2(WfmResetChatSessionsFilterAction);

//#endregion

//#region --- 命令面板「WFM: Diagnose Chat Sessions」---
//
// 真正打开诊断窗口，把以下信息都打出来让用户看到：
//   - 当前所有活动 chat models 的 sessionResource + chatSessionType + hasRequests
//   - filter storage 里残留的 excludes 内容（JSON）
//   - 所有已注册的 chat session item providers
//   - 强制 refresh 后，每个 provider 返回了多少 items（providerType + count）
//
// 这样用户一眼能看到「session 到底在不在 / 是不是被 filter 吃掉了」。

class WfmDiagnoseChatSessionsAction extends Action2 {
	static readonly ID = 'wfm.chat.diagnoseSessions';

	constructor() {
		super({
			id: WfmDiagnoseChatSessionsAction.ID,
			title: localize2('wfm.chat.diagnoseSessions', "WFM: Diagnose Chat Sessions (output to log)"),
			category: localize2('wfm.category', 'WFM'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const storageService = accessor.get(IStorageService);
		const chatSessionsService = accessor.get(IChatSessionsService);
		const notificationService = accessor.get(INotificationService);
		const chatService = accessor.get(IChatService);
		const clipboardService = accessor.get(IClipboardService);

		const lines: string[] = [];
		lines.push('=== WFM Chat Sessions Diagnostic ===');

		// 1) 活动的 chat models
		const liveModels = chatService.chatModels.get();
		lines.push(`\n[1] Live chat models: ${liveModels.length}`);
		for (const m of liveModels) {
			lines.push(`  - resource=${m.sessionResource.toString()}`);
			lines.push(`    scheme=${m.sessionResource.scheme}  authority=${m.sessionResource.authority || '(empty)'}`);
			lines.push(`    type=${getChatSessionType(m.sessionResource)}  hasRequests=${m.hasRequests}  initialLocation=${m.initialLocation}`);
		}

		// 2) filter 残留
		lines.push('\n[2] Filter excludes in PROFILE storage:');
		const scopes: StorageScope[] = [StorageScope.PROFILE, StorageScope.APPLICATION];
		let foundFilterKey = false;
		for (const scope of scopes) {
			for (const key of storageService.keys(scope, StorageTarget.USER)) {
				if (key.startsWith('agentSessions.filterExcludes.')) {
					foundFilterKey = true;
					const raw = storageService.get(key, scope);
					lines.push(`  scope=${scope}  key=${key}`);
					lines.push(`  value=${raw}`);
				}
			}
		}
		if (!foundFilterKey) {
			lines.push('  (no filter storage entries — filter should be default)');
		}

		// 3) 已注册 provider
		const providers = chatSessionsService.getRegisteredChatSessionItemProviders();
		lines.push(`\n[3] Registered chat session item providers: ${providers.length}`);
		for (const p of providers) {
			lines.push(`  - ${p}`);
		}

		// 4) 强制刷新后从每个 provider 拿 items
		lines.push('\n[4] Items per provider (after forced refresh):');
		await chatSessionsService.refreshChatSessionItems(undefined, CancellationToken.None);
		for await (const { chatSessionType, items } of chatSessionsService.getChatSessionItems(undefined, CancellationToken.None)) {
			lines.push(`  - provider=${chatSessionType}  count=${items.length}`);
			for (const it of items.slice(0, 5)) {
				lines.push(`      - ${it.label}  (${it.resource.toString()})`);
			}
			if (items.length > 5) {
				lines.push(`      ... +${items.length - 5} more`);
			}
		}

		lines.push('\n=== END ===');

		const fullReport = lines.join('\n');
		console.log(fullReport);

		notificationService.notify({
			severity: Severity.Info,
			message: 'WFM Diagnose 完成。详情已打印到 Developer Tools console（Help → Toggle Developer Tools → Console）。也可以下面展开看摘要。',
			sticky: true,
			source: { label: 'WFM' },
			actions: {
				primary: [{
					id: 'wfm.chat.diagnoseSessions.copy',
					label: '复制完整报告到剪贴板',
					tooltip: '把诊断报告复制到剪贴板，方便贴给 Claude 排障',
					class: undefined,
					enabled: true,
					run: async () => {
						await clipboardService.writeText(fullReport);
					},
				}],
				secondary: [],
			},
		});
	}
}

registerAction2(WfmDiagnoseChatSessionsAction);

//#endregion
