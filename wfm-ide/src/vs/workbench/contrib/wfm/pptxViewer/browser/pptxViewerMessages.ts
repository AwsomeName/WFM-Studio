/*---------------------------------------------------------------------------------------------
 *  WFM Studio PPTX viewer — webview <-> EditorPane IPC message types.
 *--------------------------------------------------------------------------------------------*/

// --- main → webview ---------------------------------------------------------

export interface IPptxLoadMessage {
	readonly kind: 'load';
	readonly fileName: string;
	readonly isDark: boolean;
}

export interface IPptxThemeMessage {
	readonly kind: 'theme';
	readonly isDark: boolean;
}

export type PptxMainToWebviewMessage = IPptxLoadMessage | IPptxThemeMessage;

// --- webview → main ---------------------------------------------------------

export interface IPptxReadyMessage {
	readonly kind: 'ready';
}

/** pptx-renderer 真正渲染完成（区别于 `ready` 的"脚本已起来"）。 */
export interface IPptxRenderedMessage {
	readonly kind: 'rendered';
	readonly slideCount: number;
}

export interface IPptxErrorMessage {
	readonly kind: 'error';
	readonly message: string;
}

/**
 * 用户在 webview 内选中文本/形状后选择"发送到对话"。
 *
 * - `slideIndex` 0-based 页码
 * - `shapeIndex` 0-based 形状在该页中的数据模型索引（不是 DOM 顺序，已通过 bbox 匹配回数据模型）
 * - `shapeName`  形状名（如 "Title 1"、"Content Placeholder 2"），用于人类可读 chip 提示
 * - `runStart`/`runEnd` 选中文字跨越的 run 范围（0-based，闭区间）。整选形状（未拖选文本）时两者均为 -1
 * - `selectedText` 选中文本原文，仅供 chip 预览/兜底；agent 端建议靠 slide/shape 索引回读 PPTX
 */
export interface IPptxSelectionToChatMessage {
	readonly kind: 'selectionToChat';
	readonly slideIndex: number;
	readonly shapeIndex: number;
	readonly shapeName: string;
	readonly runStart: number;
	readonly runEnd: number;
	readonly selectedText: string;
}

/** viewer 工具栏「重载视图」按钮触发，让 main 销毁并重建 webview。 */
export interface IPptxReloadRequestMessage {
	readonly kind: 'reloadRequest';
}

export type PptxWebviewToMainMessage =
	| IPptxReadyMessage
	| IPptxRenderedMessage
	| IPptxErrorMessage
	| IPptxSelectionToChatMessage
	| IPptxReloadRequestMessage;
