/*---------------------------------------------------------------------------------------------
 *  WFM Studio CAD review contribution.
 *
 *  v0.2: 把 *.dwg / *.dxf 关联到 webview-based CadViewerEditor。
 *  - 上游 ODA 转换链路（``wfm.cad.convertToDxf`` Action / Explorer 右键）
 *    已下线，详见 docs/ARCH_CAD_REVIEW.md。
 *
 *  Explorer 右键菜单：
 *  - 「AI 审图」: .dxf 直接读磁盘发 dxf_text；.dwg 打开 CAD Viewer（WASM 转换后发 dxf_text）。
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
import { basename } from '../../../../../base/common/resources.js';
import { ChatViewId, IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import {
	CAD_VIEWER_EDITOR_ID,
	CAD_VIEWER_EDITOR_LABEL,
	DWG_FILE_EXTENSION,
	DXF_FILE_EXTENSION,
} from '../common/cadReview.js';
import { CadViewerEditor } from './cadViewerEditor.js';
import { CadViewerEditorInput } from './cadViewerEditorInput.js';

//#region --- editor pane registration ---

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(CadViewerEditor, CadViewerEditor.ID, CAD_VIEWER_EDITOR_LABEL),
	[new SyncDescriptor(CadViewerEditorInput)],
);

class CadReviewEditorContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.wfm.cadReview';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		// 把 *.dwg / *.dxf 关联到 CadViewerEditor。priority=builtin 比 default 高，
		// 防止 vscode 看到「二进制文件」时直接退到 BinaryFileEditor 导致黑屏。
		// 用户仍能通过 "Open With..." 选回普通文本编辑器查看 .dxf 原始字段。
		editorResolverService.registerEditor(
			`*.{${DWG_FILE_EXTENSION.slice(1)},${DXF_FILE_EXTENSION.slice(1)}}`,
			{
				id: CadViewerEditorInput.ID,
				label: CAD_VIEWER_EDITOR_LABEL,
				priority: RegisteredEditorPriority.builtin,
			},
			{
				singlePerResource: true,
				canSupportResource: resource => {
					if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
						return false;
					}
					const ext = extname(resource).toLowerCase();
					return ext === DWG_FILE_EXTENSION || ext === DXF_FILE_EXTENSION;
				},
			},
			{
				createEditorInput: ({ resource }) => ({
					editor: instantiationService.createInstance(CadViewerEditorInput, resource),
				}),
			},
		);
	}
}

registerWorkbenchContribution2(
	CadReviewEditorContribution.ID,
	CadReviewEditorContribution,
	WorkbenchPhase.BlockStartup,
);

class CadViewerEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof CadViewerEditorInput;
	}

	serialize(editorInput: EditorInput): string {
		const input = editorInput as CadViewerEditorInput;
		return JSON.stringify({ resource: input.resource.toString() });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditorInput) as { resource?: string };
			if (!data?.resource) {
				return undefined;
			}
			return instantiationService.createInstance(CadViewerEditorInput, URI.parse(data.resource));
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	CadViewerEditorInput.ID,
	CadViewerEditorInputSerializer,
);

//#endregion

export { CAD_VIEWER_EDITOR_ID };

//#endregion

//#region --- Explorer 右键菜单: AI 审图 ---

class CadReviewFromExplorerAction extends Action2 {
	constructor() {
		super({
			id: 'wfm.cad.reviewFromExplorer',
			title: localize2('cadReviewFromExplorer', "AI 审图"),
			f1: false,
			menu: [{
				id: MenuId.ExplorerContext,
				group: 'navigation',
				order: 24,
				when: ContextKeyExpr.and(
					ExplorerFolderContext.negate(),
					ContextKeyExpr.regex(ResourceContextKey.Extension.key, /\.(dxf|dwg)$/i),
				),
			}],
		});
	}

	async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		if (!URI.isUri(resource)) {
			return;
		}

		const editorService = accessor.get(IEditorService);
		const fileName = basename(resource);
		const ext = extname(resource).toLowerCase();

		if (ext === DXF_FILE_EXTENSION) {
			// .dxf 是纯文本：打开 chat 面板，把文件作为附件传给 Claude agent。
			const viewsService = accessor.get(IViewsService);
			const chatWidgetService = accessor.get(IChatWidgetService);
			await viewsService.openView(ChatViewId, true);
			const widget = chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)[0]
				?? chatWidgetService.lastFocusedWidget;
			if (widget) {
				widget.focusInput();
				widget.attachmentModel.addFile(resource);
				widget.setInput(localize(
					'wfm.cad.explorer.reviewMessageDefault',
					"请审一下当前 CAD 图（{0}），用通用方法逐项检查。",
					fileName,
				));
			}
		} else {
			// .dwg 需要 WASM 转换，打开 CAD Viewer（已有「AI 审图」按钮）
			await editorService.openEditor({ resource });
		}
	}
}

registerAction2(CadReviewFromExplorerAction);

//#endregion
