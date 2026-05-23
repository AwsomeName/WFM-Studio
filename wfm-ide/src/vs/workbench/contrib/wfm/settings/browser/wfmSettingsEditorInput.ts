/*---------------------------------------------------------------------------------------------
 *  WFM Studio Settings — EditorInput (singleton, virtual URI).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { WFM_SETTINGS_EDITOR_INPUT_ID } from '../common/wfmSettings.js';

const wfmSettingsIcon = registerIcon(
	'wfm-settings-icon',
	Codicon.settingsGear,
	localize('wfmSettingsIcon', 'WFM 设置图标'),
);

export class WfmSettingsEditorInput extends EditorInput {

	static readonly ID: string = WFM_SETTINGS_EDITOR_INPUT_ID;

	readonly resource: URI = URI.from({
		scheme: Schemas.vscodeSettings,
		path: 'wfm-settings',
	});

	override get typeId(): string {
		return WfmSettingsEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return WFM_SETTINGS_EDITOR_INPUT_ID;
	}

	override getName(): string {
		return localize('wfmSettingsEditorName', "WFM 设置");
	}

	override getIcon(): ThemeIcon {
		return wfmSettingsIcon;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof WfmSettingsEditorInput;
	}
}
