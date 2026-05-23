/*---------------------------------------------------------------------------------------------
 *  WFM Studio DOCX viewer — webview <-> EditorPane IPC message types.
 *--------------------------------------------------------------------------------------------*/

// --- main → webview ---------------------------------------------------------

export interface IDocxLoadMessage {
	readonly kind: 'load';
	readonly fileName: string;
	readonly isDark: boolean;
}

export interface IDocxThemeMessage {
	readonly kind: 'theme';
	readonly isDark: boolean;
}

export type DocxMainToWebviewMessage = IDocxLoadMessage | IDocxThemeMessage;

// --- webview → main ---------------------------------------------------------

export interface IDocxReadyMessage {
	readonly kind: 'ready';
}

/** docx-preview 真正渲染完成（区别于 `ready` 的"脚本已起来"）。 */
export interface IDocxRenderedMessage {
	readonly kind: 'rendered';
}

export interface IDocxErrorMessage {
	readonly kind: 'error';
	readonly message: string;
}

export interface IDocxSelectionToChatMessage {
	readonly kind: 'selectionToChat';
	readonly startPara: number;
	readonly endPara: number;
	readonly selectedText: string;
}

/** viewer 工具栏「重载视图」按钮触发，让 main 销毁并重建 webview。 */
export interface IDocxReloadRequestMessage {
	readonly kind: 'reloadRequest';
}

export type DocxWebviewToMainMessage =
	| IDocxReadyMessage
	| IDocxRenderedMessage
	| IDocxErrorMessage
	| IDocxSelectionToChatMessage
	| IDocxReloadRequestMessage;
