/*---------------------------------------------------------------------------------------------
 *  WFM Studio HTML preview — EditorInput.
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
import { HTML_PREVIEW_EDITOR_ID } from '../common/htmlPreview.js';

const htmlPreviewIcon = registerIcon(
	'wfm-html-preview-icon',
	Codicon.preview,
	localize('wfm.html.previewIcon', 'HTML 预览图标'),
);

export class HtmlPreviewEditorInput extends EditorInput {

	static readonly ID = HTML_PREVIEW_EDITOR_ID;

	constructor(
		readonly resource: URI,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super();
	}

	override get typeId(): string {
		return HtmlPreviewEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return HtmlPreviewEditorInput.ID;
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
		return htmlPreviewIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof HtmlPreviewEditorInput) {
			return other.resource.toString() === this.resource.toString();
		}
		return false;
	}
}
