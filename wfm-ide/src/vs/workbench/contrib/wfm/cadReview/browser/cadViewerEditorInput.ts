/*---------------------------------------------------------------------------------------------
 *  WFM Studio CAD review — CAD viewer EditorInput.
 *
 *  v0.2: webview-based 真渲染编辑器（cad-viewer + libredwg-web）。
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { basename } from '../../../../../base/common/resources.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { localize } from '../../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { CAD_VIEWER_EDITOR_ID } from '../common/cadReview.js';

const cadViewerIcon = registerIcon(
	'wfm-cad-viewer-icon',
	Codicon.symbolStructure,
	localize('wfm.cad.cadViewerIcon', 'CAD 浏览器图标'),
);

export class CadViewerEditorInput extends EditorInput {

	static readonly ID = CAD_VIEWER_EDITOR_ID;

	constructor(
		readonly resource: URI,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super();
	}

	override get typeId(): string {
		return CadViewerEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return CadViewerEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// 只读：viewer 模式不允许直接修改 .dwg/.dxf。后续启用 cad-viewer
		// editor 模式时再放开（见 ARCH §8）。
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return basename(this.resource);
	}

	override getDescription(): string | undefined {
		return this.labelService.getUriLabel(this.resource, { relative: true });
	}

	override getIcon(): ThemeIcon {
		return cadViewerIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof CadViewerEditorInput) {
			return other.resource.toString() === this.resource.toString();
		}
		return false;
	}
}
