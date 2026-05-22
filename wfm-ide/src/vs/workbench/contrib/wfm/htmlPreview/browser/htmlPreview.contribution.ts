/*---------------------------------------------------------------------------------------------
 *  WFM Studio HTML preview contribution.
 *
 *  Registers the HtmlPreviewEditor as an *option* editor for .html / .htm files.
 *  Double-click still opens the built-in text editor.  Users trigger the preview
 *  via the "预览 HTML" Explorer context-menu action.
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
	HTML_PREVIEW_EDITOR_LABEL,
	HTML_FILE_EXTENSION,
	HTM_FILE_EXTENSION,
} from '../common/htmlPreview.js';
import { HtmlPreviewEditor } from './htmlPreviewEditor.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';

//#region --- editor pane registration ---

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(HtmlPreviewEditor, HtmlPreviewEditor.ID, HTML_PREVIEW_EDITOR_LABEL),
	[new SyncDescriptor(HtmlPreviewEditorInput)],
);

class HtmlPreviewEditorContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.wfm.htmlPreview';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		editorResolverService.registerEditor(
			`*.{${HTML_FILE_EXTENSION.slice(1)},${HTM_FILE_EXTENSION.slice(1)}}`,
			{
				id: HtmlPreviewEditorInput.ID,
				label: HTML_PREVIEW_EDITOR_LABEL,
				priority: RegisteredEditorPriority.option,
			},
			{
				singlePerResource: true,
				canSupportResource: resource => {
					if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
						return false;
					}
					const ext = extname(resource).toLowerCase();
					return ext === HTML_FILE_EXTENSION || ext === HTM_FILE_EXTENSION;
				},
			},
			{
				createEditorInput: ({ resource }) => ({
					editor: instantiationService.createInstance(HtmlPreviewEditorInput, resource),
				}),
			},
		);
	}
}

registerWorkbenchContribution2(
	HtmlPreviewEditorContribution.ID,
	HtmlPreviewEditorContribution,
	WorkbenchPhase.BlockStartup,
);

class HtmlPreviewEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof HtmlPreviewEditorInput;
	}

	serialize(editorInput: EditorInput): string {
		const input = editorInput as HtmlPreviewEditorInput;
		return JSON.stringify({ resource: input.resource.toString() });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditorInput) as { resource?: string };
			if (!data?.resource) { return undefined; }
			return instantiationService.createInstance(HtmlPreviewEditorInput, URI.parse(data.resource));
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	HtmlPreviewEditorInput.ID,
	HtmlPreviewEditorInputSerializer,
);

//#endregion

//#region --- Explorer 右键菜单: 预览 HTML ---

class PreviewHtmlFromExplorerAction extends Action2 {
	constructor() {
		super({
			id: 'wfm.html.previewFromExplorer',
			title: localize2('previewHtmlFromExplorer', "预览 HTML"),
			f1: false,
			menu: [{
				id: MenuId.ExplorerContext,
				group: 'navigation',
				order: 23,
				when: ContextKeyExpr.and(
					ExplorerFolderContext.negate(),
					ContextKeyExpr.regex(ResourceContextKey.Extension.key, /\.(html|htm)$/i),
				),
			}],
		});
	}

	async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		if (!URI.isUri(resource)) { return; }

		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		const input = instantiationService.createInstance(HtmlPreviewEditorInput, resource);
		await editorService.openEditor(input, { pinned: true });
	}
}

registerAction2(PreviewHtmlFromExplorerAction);

//#endregion
