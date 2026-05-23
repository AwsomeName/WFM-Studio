/*---------------------------------------------------------------------------------------------
 *  WFM Studio contributions.
 *
 *  Adds WFM-specific Explorer context-menu actions that route through the
 *  upstream Chat UI (wired to the local Claude Code CLI by
 *  contrib/wfm/electron-browser/wfmClaudeAgent.contribution.ts).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IChatWidget } from '../../chat/browser/chat.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ExplorerFolderContext } from '../../files/common/files.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { ChatViewId, IChatWidgetService } from '../../chat/browser/chat.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
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
