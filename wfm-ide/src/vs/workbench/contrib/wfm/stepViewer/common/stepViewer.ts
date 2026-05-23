/*---------------------------------------------------------------------------------------------
 *  WFM Studio STEP viewer constants.
 *--------------------------------------------------------------------------------------------*/

export const STEP_FILE_EXTENSION = '.step';
export const STP_FILE_EXTENSION = '.stp';
export const STL_FILE_EXTENSION = '.stl';

export const STEP_VIEWER_EDITOR_ID = 'wfm.step.stepViewerEditor';
export const STEP_VIEWER_EDITOR_LABEL = 'WFM 3D Viewer';

export const STEP_VIEWER_BYTE_LIMIT = 512 * 1024 * 1024;

/** Logical model formats handled by the 3D viewer. */
export type WfmModelFormat = 'glb' | 'stl';

export function modelFormatForExtension(ext: string): WfmModelFormat | undefined {
	const lower = ext.toLowerCase();
	if (lower === STEP_FILE_EXTENSION || lower === STP_FILE_EXTENSION) {
		return 'glb';
	}
	if (lower === STL_FILE_EXTENSION) {
		return 'stl';
	}
	return undefined;
}
