/*---------------------------------------------------------------------------------------------
 *  WFM Studio — STEP → GLB converter service (interface).
 *
 *  The renderer is sandboxed and cannot spawn `python3` directly. This service
 *  proxies the conversion to the Electron main process which has full Node.js
 *  access. See `WfmStepConverterMainService` for the implementation.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IWfmStepConverterService = createDecorator<IWfmStepConverterService>('wfmStepConverterService');

export interface IWfmStepConvertOptions {
	/** Absolute filesystem path to the input .step / .stp file. */
	readonly stepPath: string;
	/** Absolute filesystem path where the resulting .glb should be written. */
	readonly glbPath: string;
	/** Optional workspace root hints (additional search roots for Python + script). */
	readonly workspaceRoots?: readonly string[];
}

export interface IWfmStepConvertResult {
	readonly glbPath: string;
	readonly stepHash: string;
	readonly glbSize: number;
	readonly elapsedMs: number;
}

export interface IWfmStepConverterService {
	readonly _serviceBrand: undefined;

	/**
	 * Convert a STEP file to GLB using the bundled / dev-tree Python toolchain.
	 *
	 * Resolution strategy (first match wins):
	 *   1. env WFM_CAD_PYTHON + WFM_CAD_SKILL_DIR
	 *   2. env WFM_AGENTS_ROOT
	 *   3. packaged app:    <resources>/wfm-backend/{python,skills}
	 *   4. dev tree:        walk up from appRoot until wfm-agents/.venv is found
	 *   5. caller-provided workspaceRoots
	 *
	 * Rejects with a localised error if none of the strategies succeed.
	 */
	convertStepToGlb(options: IWfmStepConvertOptions): Promise<IWfmStepConvertResult>;
}
