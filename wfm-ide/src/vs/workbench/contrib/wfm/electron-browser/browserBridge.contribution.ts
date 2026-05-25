/*---------------------------------------------------------------------------------------------
 *  WFM Studio — Browser bridge contribution.
 *
 *  Wires up:
 *    1. IBrowserBridgeService (renderer-side singleton).
 *    2. An IPC channel ('wfmBrowserBridge') exposing that service back to the
 *       main process, so BrowserApiServer can forward HTTP requests onto it.
 *
 *  The main process side of this connection lives in
 *  `platform/wfmClaude/electron-main/browserApiServer.ts`.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IBrowserBridgeService, WFM_BROWSER_BRIDGE_CHANNEL } from '../common/browserBridge.js';
import { BrowserBridgeService } from './browserBridgeService.js';

registerSingleton(IBrowserBridgeService, BrowserBridgeService, InstantiationType.Delayed);

class WfmBrowserBridgeChannelContribution implements IWorkbenchContribution {

	private readonly _disposables = new DisposableStore();

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		// Resolving the service forces the singleton to be instantiated, which
		// gives the channel a live target before BrowserApiServer ever calls in.
		const service = instantiationService.invokeFunction(accessor => accessor.get(IBrowserBridgeService));
		mainProcessService.registerChannel(WFM_BROWSER_BRIDGE_CHANNEL, ProxyChannel.fromService(service, this._disposables));
	}

	dispose(): void {
		this._disposables.dispose();
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(WfmBrowserBridgeChannelContribution, LifecyclePhase.Restored);
