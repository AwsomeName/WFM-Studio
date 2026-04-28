/*---------------------------------------------------------------------------------------------
 *  WFM Studio contributions.
 *
 *  Registers the AI chat pane on the right AuxiliaryBar plus the HTTP client
 *  service it uses. See docs/PLAN.md §8.2 Step B for the minimal-closed-loop
 *  design.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IWfmAgentClientService } from '../common/wfmAgentClient.js';
import { WfmAgentClientService } from './wfmAgentClientService.js';
import { WfmChatViewPane } from './wfmChatViewPane.js';

const WFM_VIEW_CONTAINER_ID = 'workbench.view.wfm';

const wfmViewIcon = registerIcon(
	'wfm-view-icon',
	Codicon.commentDiscussion,
	localize('wfmViewIcon', 'Icon for the WFM Studio AI assistant view.'),
);

registerSingleton(IWfmAgentClientService, WfmAgentClientService, InstantiationType.Delayed);

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer(
	{
		id: WFM_VIEW_CONTAINER_ID,
		title: localize2('wfm.viewContainer.title', "WFM 助手"),
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
	name: localize2('wfm.chat.name', "AI 对话"),
	containerIcon: wfmViewIcon,
	ctorDescriptor: new SyncDescriptor(WfmChatViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([chatViewDescriptor], viewContainer);
