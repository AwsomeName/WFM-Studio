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

export type DocxWebviewToMainMessage =
	| IDocxReadyMessage
	| IDocxErrorMessage
	| IDocxSelectionToChatMessage;
