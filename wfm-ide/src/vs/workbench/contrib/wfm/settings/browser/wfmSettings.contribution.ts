/*---------------------------------------------------------------------------------------------
 *  WFM Studio Settings — contribution registration.
 *
 *  Registers the settings EditorPane, EditorInput, serializer, and the
 *  "WFM: Open Settings" command-palette action.
 *--------------------------------------------------------------------------------------------*/

import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { localize2 } from '../../../../../nls.js';
import { WFM_SETTINGS_EDITOR_INPUT_ID } from '../common/wfmSettings.js';
import { WfmSettingsEditor } from './wfmSettingsEditor.js';
import { WfmSettingsEditorInput } from './wfmSettingsEditorInput.js';

//#region --- Editor pane registration ---

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(WfmSettingsEditor, WfmSettingsEditor.ID, 'WFM Settings'),
	[new SyncDescriptor(WfmSettingsEditorInput)],
);

//#endregion

//#region --- Serializer ---

class WfmSettingsEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof WfmSettingsEditorInput;
	}

	serialize(): string {
		return '{}';
	}

	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(WfmSettingsEditorInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	WFM_SETTINGS_EDITOR_INPUT_ID,
	WfmSettingsEditorInputSerializer,
);

//#endregion

//#region --- Command: WFM: Open Settings ---

class OpenWfmSettingsAction extends Action2 {
	constructor() {
		super({
			id: 'wfm.openSettings',
			title: localize2('openWfmSettings', "WFM: 打开设置"),
			f1: true,
			category: localize2('wfmCategory', "WFM Studio"),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const input = instantiationService.createInstance(WfmSettingsEditorInput);
		await editorService.openEditor(input, { pinned: true });
	}
}

registerAction2(OpenWfmSettingsAction);

//#endregion
