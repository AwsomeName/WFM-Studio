/*---------------------------------------------------------------------------------------------
 *  WFM Studio contributions.
 *
 *  Registers the AI chat pane on the right AuxiliaryBar plus the HTTP client
 *  service it uses. See docs/PLAN.md §8.2 Step B for the minimal-closed-loop
 *  design.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ExplorerFolderContext } from '../../files/common/files.js';
import { relativePath } from '../../../../base/common/resources.js';
import { IWfmAgentClientService } from '../common/wfmAgentClient.js';
import { WfmAgentClientService } from './wfmAgentClientService.js';
import { WfmChatViewPane } from './wfmChatViewPane.js';

const WFM_VIEW_CONTAINER_ID = 'workbench.view.wfm';

const wfmViewIcon = registerIcon(
	'wfm-view-icon',
	Codicon.commentDiscussion,
	localize('wfmViewIcon', 'WFM Studio 任务助手侧栏图标'),
);

registerSingleton(IWfmAgentClientService, WfmAgentClientService, InstantiationType.Delayed);

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer(
	{
		id: WFM_VIEW_CONTAINER_ID,
		title: localize2('wfm.viewContainer.title', "WFM Studio"),
		icon: wfmViewIcon,
		order: 100,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [WFM_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: WFM_VIEW_CONTAINER_ID,
		hideIfEmpty: false,
	},
	ViewContainerLocation.AuxiliaryBar,
	{ isDefault: true, doNotRegisterOpenCommand: false },
);

const chatViewDescriptor: IViewDescriptor = {
	id: WfmChatViewPane.ID,
	name: localize2('wfm.chat.name', "任务对话"),
	containerIcon: wfmViewIcon,
	ctorDescriptor: new SyncDescriptor(WfmChatViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([chatViewDescriptor], viewContainer);

//#region --- Explorer 右键菜单: 发送到 WFM 对话 ---

class SendToWfmChatAction extends Action2 {
	constructor() {
		super({
			id: 'wfm.explorer.sendToChat',
			title: localize2('sendToWfmChat', "发送到 WFM 对话"),
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
		const contextService = accessor.get(IWorkspaceContextService);
		const agentClient = accessor.get(IWfmAgentClientService);

		const workspace = contextService.getWorkspace();
		const folder = workspace.folders[0];
		const relPath = folder ? relativePath(folder.uri, resource) : resource.path;

		await agentClient.prefillChatInput(
			localize('wfm.chat.prefill.file', "请帮我分析一下这个文件: {0} ", relPath),
		);
	}
}

registerAction2(SendToWfmChatAction);

//#endregion
