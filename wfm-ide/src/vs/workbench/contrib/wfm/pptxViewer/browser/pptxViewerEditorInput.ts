/*---------------------------------------------------------------------------------------------
 *  WFM Studio PPTX viewer — EditorInput.
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
import { PPTX_VIEWER_EDITOR_ID } from '../common/pptxViewer.js';

const pptxViewerIcon = registerIcon(
	'wfm-pptx-viewer-icon',
	Codicon.file,
	localize('wfm.pptx.viewerIcon', 'PPT 文档图标'),
);

export class PptxViewerEditorInput extends EditorInput {

	static readonly ID = PPTX_VIEWER_EDITOR_ID;

	constructor(
		readonly resource: URI,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super();
	}

	override get typeId(): string {
		return PptxViewerEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return PptxViewerEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return basename(this.resource);
	}

	override getDescription(): string | undefined {
		return this.labelService.getUriLabel(this.resource, { relative: true });
	}

	override getIcon(): ThemeIcon {
		return pptxViewerIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof PptxViewerEditorInput) {
			return other.resource.toString() === this.resource.toString();
		}
		return false;
	}
}
