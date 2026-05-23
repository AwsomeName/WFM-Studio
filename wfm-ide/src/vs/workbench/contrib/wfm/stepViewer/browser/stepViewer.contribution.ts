/*---------------------------------------------------------------------------------------------
 *  WFM Studio STEP viewer contribution.
 *
 *  把 *.step / *.stp 关联到 webview-based StepViewerEditor。
 *  架构完全复刻 cadReview.contribution.ts。
 *--------------------------------------------------------------------------------------------*/

import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extname } from '../../../../../base/common/resources.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ResourceContextKey } from '../../../../common/contextkeys.js';
import { ExplorerFolderContext } from '../../../files/common/files.js';
import { localize, localize2 } from '../../../../../nls.js';
import {
	STEP_VIEWER_EDITOR_ID,
	STEP_VIEWER_EDITOR_LABEL,
	STEP_FILE_EXTENSION,
	STP_FILE_EXTENSION,
	STL_FILE_EXTENSION,
} from '../common/stepViewer.js';
import { StepViewerEditor } from './stepViewerEditor.js';
import { StepViewerEditorInput } from './stepViewerEditorInput.js';

//#region --- editor pane registration ---

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(StepViewerEditor, StepViewerEditor.ID, STEP_VIEWER_EDITOR_LABEL),
	[new SyncDescriptor(StepViewerEditorInput)],
);

class StepViewerEditorContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.wfm.stepViewer';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		editorResolverService.registerEditor(
			`*.{${STEP_FILE_EXTENSION.slice(1)},${STP_FILE_EXTENSION.slice(1)},${STL_FILE_EXTENSION.slice(1)}}`,
			{
				id: StepViewerEditorInput.ID,
				label: STEP_VIEWER_EDITOR_LABEL,
				priority: RegisteredEditorPriority.builtin,
			},
			{
				singlePerResource: true,
				canSupportResource: resource => {
					if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
						return false;
					}
					const ext = extname(resource).toLowerCase();
					return ext === STEP_FILE_EXTENSION
						|| ext === STP_FILE_EXTENSION
						|| ext === STL_FILE_EXTENSION;
				},
			},
			{
				createEditorInput: ({ resource }) => ({
					editor: instantiationService.createInstance(StepViewerEditorInput, resource),
				}),
			},
		);
	}
}

registerWorkbenchContribution2(
	StepViewerEditorContribution.ID,
	StepViewerEditorContribution,
	WorkbenchPhase.BlockStartup,
);

class StepViewerEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof StepViewerEditorInput;
	}

	serialize(editorInput: EditorInput): string {
		const input = editorInput as StepViewerEditorInput;
		return JSON.stringify({ resource: input.resource.toString() });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditorInput) as { resource?: string };
			if (!data?.resource) { return undefined; }
			return instantiationService.createInstance(StepViewerEditorInput, URI.parse(data.resource));
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	StepViewerEditorInput.ID,
	StepViewerEditorInputSerializer,
);

//#endregion

//#region --- Explorer 右键菜单 ---

class OpenStepViewerFromExplorerAction extends Action2 {
	constructor() {
		super({
			id: 'wfm.step.openFromExplorer',
			title: localize2('stepOpenFromExplorer', "在 3D Viewer 中打开"),
			f1: false,
			menu: [{
				id: MenuId.ExplorerContext,
				group: 'navigation',
				order: 26,
				when: ContextKeyExpr.and(
					ExplorerFolderContext.negate(),
					ContextKeyExpr.regex(ResourceContextKey.Extension.key, /\.(step|stp|stl)$/i),
				),
			}],
		});
	}

	async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		if (!URI.isUri(resource)) { return; }
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor({ resource });
	}
}

registerAction2(OpenStepViewerFromExplorerAction);

export { STEP_VIEWER_EDITOR_ID };

//#endregion
