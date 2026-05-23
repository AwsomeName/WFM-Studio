/*---------------------------------------------------------------------------------------------
 *  WFM Studio STEP viewer — IPC message types.
 *--------------------------------------------------------------------------------------------*/

// --- Main → Webview ---

export interface IStepLoadMessage {
	kind: 'load';
	format: 'glb' | 'stl';
	uri: string;
	fileName: string;
	isDark: boolean;
}

export interface IStepThemeMessage {
	kind: 'theme';
	isDark: boolean;
}

export interface IStepProgressMessage {
	kind: 'progress';
	stage: 'converting' | 'loading' | 'rendering' | 'error';
	message: string;
	/** When true, the message is a terminal error — the viewer should render it prominently. */
	isError?: boolean;
}

export type StepMainToWebviewMessage = IStepLoadMessage | IStepThemeMessage | IStepProgressMessage;

// --- Webview → Main ---

export interface IStepReadyMessage {
	kind: 'ready';
}

export interface IStepErrorMessage {
	kind: 'error';
	message: string;
}

export interface IStepRenderStatsMessage {
	kind: 'renderStats';
	meshCount: number;
	triangleCount: number;
	loadMs: number;
}

/**
 * webview 工具栏「重载视图」按钮触发：
 * 请求 main 端销毁 webview 并重建，然后重新 push 当前文件。
 * 比 Reload Window 快很多，是 webview 卡死的快速营救通道。
 */
export interface IStepReloadRequestMessage {
	kind: 'reloadRequest';
}

export type StepWebviewToMainMessage =
	| IStepReadyMessage
	| IStepErrorMessage
	| IStepRenderStatsMessage
	| IStepReloadRequestMessage;
