/*---------------------------------------------------------------------------------------------
 *  WFM Studio PPTX viewer contribution.
 *
 *  Registers the PptxViewerEditor as an *option* editor for .pptx files.
 *  双击仍然走原有 omni-viewer / 文本编辑器；用户主动通过 Explorer 右键
 *  "预览 PPT 文档" 或 "使用 … 打开" 选 "WFM PPT 预览" 才进我们的视图。
 *  这样不影响现有用户体验，新功能（选区发送到对话）是叠加而非替换。
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
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ResourceContextKey } from '../../../../common/contextkeys.js';
import { ExplorerFolderContext } from '../../../files/common/files.js';
import { localize2 } from '../../../../../nls.js';
import {
	PPTX_VIEWER_EDITOR_LABEL,
	PPTX_FILE_EXTENSION,
} from '../common/pptxViewer.js';
import { PptxViewerEditor } from './pptxViewerEditor.js';
import { PptxViewerEditorInput } from './pptxViewerEditorInput.js';

//#region --- editor pane registration ---

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(PptxViewerEditor, PptxViewerEditor.ID, PPTX_VIEWER_EDITOR_LABEL),
	[new SyncDescriptor(PptxViewerEditorInput)],
);

class PptxViewerEditorContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.wfm.pptxViewer';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		editorResolverService.registerEditor(
			`*.{${PPTX_FILE_EXTENSION.slice(1)}}`,
			{
				id: PptxViewerEditorInput.ID,
				label: PPTX_VIEWER_EDITOR_LABEL,
				priority: RegisteredEditorPriority.option,
			},
			{
				singlePerResource: true,
				canSupportResource: resource => {
					if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
						return false;
					}
					const ext = extname(resource).toLowerCase();
					return ext === PPTX_FILE_EXTENSION;
				},
			},
			{
				createEditorInput: ({ resource }) => ({
					editor: instantiationService.createInstance(PptxViewerEditorInput, resource),
				}),
			},
		);
	}
}

registerWorkbenchContribution2(
	PptxViewerEditorContribution.ID,
	PptxViewerEditorContribution,
	WorkbenchPhase.BlockStartup,
);

class PptxViewerEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof PptxViewerEditorInput;
	}

	serialize(editorInput: EditorInput): string {
		const input = editorInput as PptxViewerEditorInput;
		return JSON.stringify({ resource: input.resource.toString() });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditorInput) as { resource?: string };
			if (!data?.resource) { return undefined; }
			return instantiationService.createInstance(PptxViewerEditorInput, URI.parse(data.resource));
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PptxViewerEditorInput.ID,
	PptxViewerEditorInputSerializer,
);

//#endregion

//#region --- Explorer 右键菜单: 预览 PPT 文档 ---

class PreviewPptxFromExplorerAction extends Action2 {
	constructor() {
		super({
			id: 'wfm.pptx.previewFromExplorer',
			title: localize2('previewPptxFromExplorer', "预览 PPT 文档"),
			f1: false,
			menu: [{
				id: MenuId.ExplorerContext,
				group: 'navigation',
				order: 26,
				when: ContextKeyExpr.and(
					ExplorerFolderContext.negate(),
					ContextKeyExpr.regex(ResourceContextKey.Extension.key, /\.pptx$/i),
				),
			}],
		});
	}

	async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		if (!URI.isUri(resource)) { return; }

		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		const input = instantiationService.createInstance(PptxViewerEditorInput, resource);
		await editorService.openEditor(input, { pinned: true });
	}
}

registerAction2(PreviewPptxFromExplorerAction);

//#endregion
