/*---------------------------------------------------------------------------------------------
 *  WFM Studio DOCX viewer contribution.
 *
 *  Registers the DocxViewerEditor as an *option* editor for .docx files.
 *  Double-click still opens the built-in text editor.  Users trigger the preview
 *  via the "预览 Word 文档" Explorer context-menu action.
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
	DOCX_VIEWER_EDITOR_LABEL,
	DOCX_FILE_EXTENSION,
} from '../common/docxViewer.js';
import { DocxViewerEditor } from './docxViewerEditor.js';
import { DocxViewerEditorInput } from './docxViewerEditorInput.js';

//#region --- editor pane registration ---

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DocxViewerEditor, DocxViewerEditor.ID, DOCX_VIEWER_EDITOR_LABEL),
	[new SyncDescriptor(DocxViewerEditorInput)],
);

class DocxViewerEditorContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.wfm.docxViewer';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		editorResolverService.registerEditor(
			`*.{${DOCX_FILE_EXTENSION.slice(1)}}`,
			{
				id: DocxViewerEditorInput.ID,
				label: DOCX_VIEWER_EDITOR_LABEL,
				priority: RegisteredEditorPriority.default,
			},
			{
				singlePerResource: true,
				canSupportResource: resource => {
					if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
						return false;
					}
					const ext = extname(resource).toLowerCase();
					return ext === DOCX_FILE_EXTENSION;
				},
			},
			{
				createEditorInput: ({ resource }) => ({
					editor: instantiationService.createInstance(DocxViewerEditorInput, resource),
				}),
			},
		);
	}
}

registerWorkbenchContribution2(
	DocxViewerEditorContribution.ID,
	DocxViewerEditorContribution,
	WorkbenchPhase.BlockStartup,
);

class DocxViewerEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof DocxViewerEditorInput;
	}

	serialize(editorInput: EditorInput): string {
		const input = editorInput as DocxViewerEditorInput;
		return JSON.stringify({ resource: input.resource.toString() });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditorInput) as { resource?: string };
			if (!data?.resource) { return undefined; }
			return instantiationService.createInstance(DocxViewerEditorInput, URI.parse(data.resource));
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	DocxViewerEditorInput.ID,
	DocxViewerEditorInputSerializer,
);

//#endregion

//#region --- Explorer 右键菜单: 预览 Word 文档 ---

class PreviewDocxFromExplorerAction extends Action2 {
	constructor() {
		super({
			id: 'wfm.docx.previewFromExplorer',
			title: localize2('previewDocxFromExplorer', "预览 Word 文档"),
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
		if (!URI.isUri(resource)) { return; }

		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		const input = instantiationService.createInstance(DocxViewerEditorInput, resource);
		await editorService.openEditor(input, { pinned: true });
	}
}

registerAction2(PreviewDocxFromExplorerAction);

//#endregion
