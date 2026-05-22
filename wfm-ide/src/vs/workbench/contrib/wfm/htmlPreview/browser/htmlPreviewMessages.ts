/*---------------------------------------------------------------------------------------------
 *  WFM Studio HTML preview — webview <-> EditorPane IPC message types.
 *--------------------------------------------------------------------------------------------*/

// --- main → webview ---------------------------------------------------------

export interface IHtmlLoadMessage {
	readonly kind: 'load';
	readonly htmlContent: string;
	readonly fileName: string;
	readonly isDark: boolean;
}

export interface IHtmlThemeMessage {
	readonly kind: 'theme';
	readonly isDark: boolean;
}

export type HtmlMainToWebviewMessage = IHtmlLoadMessage | IHtmlThemeMessage;

// --- webview → main ---------------------------------------------------------

export interface IHtmlReadyMessage {
	readonly kind: 'ready';
}

export interface IHtmlErrorMessage {
	readonly kind: 'error';
	readonly message: string;
}

export type HtmlWebviewToMainMessage = IHtmlReadyMessage | IHtmlErrorMessage;
