/*---------------------------------------------------------------------------------------------
 *  WFM Studio CAD review — webview <-> EditorPane IPC message types.
 *--------------------------------------------------------------------------------------------*/

/**
 * 文件类型，决定 webview 内走 LibreDWG 解析还是直接喂 cad-viewer。
 */
export type CadFileKind = 'dwg' | 'dxf';

// --- main → webview ---------------------------------------------------------

export interface ICadLoadMessage {
	readonly kind: 'load';
	/** 文件资源 URI（仅供 webview 显示文件名 / 审计；不要再去 fetch）。 */
	readonly uri: string;
	/** 文件名展示用。 */
	readonly fileName: string;
	/** 文件类型。 */
	readonly fileKind: CadFileKind;
	/** 是否暗色主题（viewer 里用来切背景）。 */
	readonly isDark: boolean;
}

export interface ICadThemeMessage {
	readonly kind: 'theme';
	readonly isDark: boolean;
}

export type CadMainToWebviewMessage = ICadLoadMessage | ICadThemeMessage;

// --- webview → main ---------------------------------------------------------

export interface ICadReadyMessage {
	readonly kind: 'ready';
}

export interface ICadErrorMessage {
	readonly kind: 'error';
	readonly message: string;
}

/**
 * viewer 工具栏「AI 审图」按钮触发。dxfText 是 webview 内 cad-viewer/libredwg
 * 解析得到的 DXF 文本（DWG 也会先转成 DXF 文本再走这条路）。
 */
export interface ICadReviewRequestMessage {
	readonly kind: 'reviewRequest';
	readonly dxfText: string;
	readonly sourceUri: string;
	readonly fileName: string;
	/** 用户在 viewer 工具栏里输入的额外说明，可空。 */
	readonly userNote?: string;
}

export interface ICadLayerStatsMessage {
	readonly kind: 'layerStats';
	readonly counts: Record<string, number>;
}

/**
 * viewer 加载完成后上报的"渲染不完整"信息：
 *  - missingFontNames: fontLoader 在 eventBus `fonts-not-found` /
 *    `fonts-not-loaded` 里累积的字体名（已在 `fonts.json` 命中 alias 的不会上报）。
 *    main 端弹出常驻 Warning，提示用户可能仍在用内置 fallback，可按文档补 alias。
 *  - missingImageCount: 外部位图引用未加载的数量（IMAGE / xref 等）。
 */
export interface ICadMissingDataMessage {
	readonly kind: 'missingData';
	readonly missingFontNames: readonly string[];
	readonly missingImageCount: number;
}

/**
 * 调试信息：viewer 在 zoom 流程里把每次 fit 的结果（实体数 / scene bbox / 重试次数）
 * 上报给 main，落到 `logService.info`，便于无 DevTools 场景排查"画布空白"。
 */
export interface ICadDebugMessage {
	readonly kind: 'debug';
	readonly stage: string;
	readonly info: Record<string, unknown>;
}

/**
 * viewer 内右键「发送选中到对话」触发。携带选中实体的元数据。
 */
export interface ICadSendSelectionMessage {
	readonly kind: 'sendSelection';
	readonly entities: ReadonlyArray<{
		readonly handle: string;
		readonly entityType: string;
		readonly textContent?: string;
		readonly layer: string;
		readonly colorIndex?: number;
	}>;
	readonly sourceUri: string;
	readonly fileName: string;
}

/**
 * viewer 内实体修改（删除 / 颜色变更）完成后，把新 DXF 文本发回 main 保存。
 */
export interface ICadEditsAppliedMessage {
	readonly kind: 'editsApplied';
	readonly dxfText: string;
	readonly sourceUri: string;
}

/**
 * viewer 工具栏「刷新」按钮触发，让 main 重读磁盘上的当前文件并重新 push 'load'。
 * 文件被外部工具（AutoCAD、SolidWorks 导出等）改写后，用户点这个按钮拿到最新内容。
 */
export interface ICadReloadRequestMessage {
	readonly kind: 'reloadRequest';
}

export type CadWebviewToMainMessage =
	| ICadReadyMessage
	| ICadErrorMessage
	| ICadReviewRequestMessage
	| ICadLayerStatsMessage
	| ICadMissingDataMessage
	| ICadDebugMessage
	| ICadSendSelectionMessage
	| ICadEditsAppliedMessage
	| ICadReloadRequestMessage;
