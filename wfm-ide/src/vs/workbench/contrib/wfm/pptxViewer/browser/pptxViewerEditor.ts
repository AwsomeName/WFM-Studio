/*---------------------------------------------------------------------------------------------
 *  WFM Studio PPTX viewer — webview-based PowerPoint rendering EditorPane.
 *
 *  Renders .pptx files inside a VS Code webview using @aiden0z/pptx-renderer.
 *  支持选中文字或单击形状 → 浮动栏/右键菜单 → 发送选区到 Chat。
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { extname, joinPath } from '../../../../../base/common/resources.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IWebviewElement, IWebviewService } from '../../../webview/browser/webview.js';
import { asWebviewUri } from '../../../webview/common/webview.js';
import { URI } from '../../../../../base/common/uri.js';
import { ChatViewId, IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import {
	PPTX_VIEWER_BYTE_LIMIT,
	PPTX_VIEWER_EDITOR_ID,
	PPTX_FILE_EXTENSION,
} from '../common/pptxViewer.js';
import { PptxViewerEditorInput } from './pptxViewerEditorInput.js';
import { PptxWebviewToMainMessage, IPptxLoadMessage } from './pptxViewerMessages.js';
import { webviewGenericCspSource } from '../../../webview/common/webview.js';

const $ = dom.$;
const LOG_PREFIX = '[wfm-pptx-viewer]';

const MEDIA_ROOT = FileAccess.asFileUri(
	'vs/workbench/contrib/wfm/pptxViewer/browser/media/',
);

interface IViewerHtmlArgs {
	readonly nonce: string;
	readonly cspSource: string;
	readonly rendererUri: string;
	readonly viewerJsUri: string;
	readonly viewerCssUri: string;
}

function buildViewerHtml(args: IViewerHtmlArgs): string {
	const { nonce, cspSource, rendererUri, viewerJsUri, viewerCssUri } = args;

	// pptx-renderer 是 ES module，需要 type=module；echarts 的 worker 用 Blob URL，
	// 因此 worker-src 必须放开到 blob:。pptx-renderer 通过 ImageBitmap/canvas2d 渲染
	// 图片，img-src 需要支持 data: 和 blob:。
	const csp = [
		`default-src 'none'`,
		`script-src ${cspSource} 'nonce-${nonce}' blob:`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`img-src ${cspSource} data: blob:`,
		`font-src ${cspSource} data:`,
		`connect-src ${cspSource} blob: data:`,
		`worker-src blob:`,
	].join('; ');

	return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${viewerCssUri}">
<title>WFM PPT 预览</title>
</head>
<body>
<div id="wfm-pptx-toolbar">
	<span id="wfm-pptx-filename"></span>
	<span id="wfm-pptx-status"></span>
	<button id="wfm-pptx-refresh" class="wfm-pptx-btn" title="销毁并重建 PPT 渲染（卡顿/异常时点这里恢复）">⟳ 重载视图</button>
</div>
<div id="wfm-pptx-loading">正在渲染 PPT…</div>
<div id="wfm-pptx-container"></div>
<div id="wfm-selection-toolbar">
	<button id="wfm-send-selection">发送到对话</button>
</div>
<div id="wfm-pptx-ctx-menu" hidden>
	<div class="wfm-pptx-ctx-item" data-action="send-selection">发送选中到对话</div>
</div>
<div id="wfm-pptx-error"></div>
<script nonce="${nonce}" type="module">
	// 拆分到 parseZip + buildPresentation + viewer.load + renderList，是为了在
	// 大 PPT 解析期间能给用户分阶段的进度反馈，避免"卡在正在渲染"看不到进展。
	import {
		PptxViewer,
		serializePresentation,
		parseZip,
		buildPresentation,
	} from "${rendererUri}";
	window.__wfmPptx = { PptxViewer, serializePresentation, parseZip, buildPresentation };
	window.dispatchEvent(new CustomEvent('wfm-pptx-renderer-ready'));
</script>
<script nonce="${nonce}">
	// 兜底错误捕获：webview 内 module 加载失败 / lib 抛错而被吞，都会在这里被截获并显示到页面错误条上。
	window.addEventListener('error', function (e) {
		var msg = (e && e.message ? e.message : 'unknown') + (e && e.filename ? ' @ ' + e.filename + ':' + (e.lineno || 0) : '');
		var el = document.getElementById('wfm-pptx-error');
		if (el) { el.textContent = 'JS 错误: ' + msg; el.style.display = 'block'; }
	});
	window.addEventListener('unhandledrejection', function (e) {
		var reason = e && e.reason;
		var msg = reason && reason.message ? reason.message : String(reason);
		var el = document.getElementById('wfm-pptx-error');
		if (el) { el.textContent = '未处理的 Promise 拒绝: ' + msg; el.style.display = 'block'; }
	});
</script>
<script nonce="${nonce}" src="${viewerJsUri}"></script>
</body>
</html>`;
}

export class PptxViewerEditor extends EditorPane {

	static readonly ID = PPTX_VIEWER_EDITOR_ID;

	private container: HTMLElement | undefined;
	private statusEl: HTMLElement | undefined;
	private webview: IWebviewElement | undefined;
	private readonly webviewListeners = this._register(new DisposableStore());
	private currentResource: string | undefined;
	private currentFileName: string | undefined;

	private rescueInFlight = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IViewsService private readonly viewsService: IViewsService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super(PptxViewerEditor.ID, group, telemetryService, themeService, storageService);

		this._register(this.themeService.onDidColorThemeChange(theme => {
			this.webview?.postMessage({
				kind: 'theme',
				isDark: theme.type === ColorScheme.DARK || theme.type === ColorScheme.HIGH_CONTRAST_DARK,
			});
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, $('.wfm-pptx-viewer-pane'));
		this.container.style.position = 'relative';
		this.statusEl = dom.append(this.container, $('.wfm-pptx-viewer-loading'));
		this.statusEl.textContent = localize('wfm.pptx.viewer.loading', "正在加载 PPT 视图…");
	}

	private async rescueReloadWebview(): Promise<void> {
		if (this.rescueInFlight) { return; }
		this.rescueInFlight = true;
		this.logService.info(`${LOG_PREFIX} rescueReloadWebview (manual)`);
		try {
			this.webviewListeners.clear();
			this.webview = undefined;
			await new Promise<void>(r => setTimeout(r, 0));
			this.ensureWebview();
			if (!this.webview) {
				throw new Error('ensureWebview() returned without creating webview');
			}
			if (this.currentResource && this.currentFileName) {
				await this.pushCurrentResourceToWebview();
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.error(`${LOG_PREFIX} rescue reload failed: ${message}`);
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize('wfm.pptx.viewer.rescueFailed', "重建 PPT 视图失败: {0}。请关闭后重新打开文件。", message),
			});
		} finally {
			this.rescueInFlight = false;
		}
	}

	private async pushCurrentResourceToWebview(): Promise<void> {
		if (!this.webview || !this.currentResource || !this.currentFileName) { return; }
		const uri = URI.parse(this.currentResource);
		const content = await this.fileService.readFile(uri);
		const isDark = this.themeService.getColorTheme().type === ColorScheme.DARK
			|| this.themeService.getColorTheme().type === ColorScheme.HIGH_CONTRAST_DARK;
		const buffer = (content.value.buffer as Uint8Array).slice().buffer;
		await this.webview.postMessage(
			{ kind: 'load', fileName: this.currentFileName, isDark, bytes: buffer } as IPptxLoadMessage & { bytes: ArrayBuffer },
			[buffer],
		);
	}

	override async setInput(
		input: PptxViewerEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		const resource = input.resource;
		const ext = extname(resource).toLowerCase();
		if (ext !== PPTX_FILE_EXTENSION) {
			this.showStatus(
				localize('wfm.pptx.viewer.unsupported', "不支持的扩展名: {0}", resource.path),
				/*isError*/ true,
			);
			return;
		}

		if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
			this.showStatus(
				localize('wfm.pptx.viewer.notLocal', "PPT 预览暂不支持 scheme: {0}", resource.scheme),
				/*isError*/ true,
			);
			return;
		}

		try {
			const stat = await this.fileService.stat(resource);
			if (token.isCancellationRequested) { return; }
			if (stat.size && stat.size > PPTX_VIEWER_BYTE_LIMIT) {
				this.showStatus(
					localize(
						'wfm.pptx.viewer.tooLarge',
						"文件过大 ({0} MB > {1} MB)",
						(stat.size / 1024 / 1024).toFixed(1),
						(PPTX_VIEWER_BYTE_LIMIT / 1024 / 1024).toFixed(0),
					),
					/*isError*/ true,
				);
				return;
			}

			this.ensureWebview();
			if (!this.webview || !this.container) { return; }

			const resourceString = resource.toString();
			// 关键：tab 切换/聚焦回来时 VS Code 会再次调 setInput；只有真的换文件
			// 才重新读字节 + post。retainContextWhenHidden 已经保住了 webview 内部
			// 状态，不要每次切回都重渲。
			if (this.currentResource === resourceString) {
				this.hideStatus();
				return;
			}
			this.currentResource = resourceString;
			this.currentFileName = input.getName();
			this.hideStatus();

			await this.pushCurrentResourceToWebview();
			if (token.isCancellationRequested) { return; }
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn(`${LOG_PREFIX} setInput failed: ${message}`);
			this.showStatus(
				localize('wfm.pptx.viewer.readFailed', "读取文件失败: {0}", message),
				/*isError*/ true,
			);
		}
	}

	private ensureWebview(): void {
		if (this.webview || !this.container) { return; }

		const nonce = generateUuid().replace(/-/g, '');
		const mediaUri = (file: string) => asWebviewUri(joinPath(MEDIA_ROOT, file)).toString(true);
		const html = buildViewerHtml({
			nonce,
			cspSource: webviewGenericCspSource,
			rendererUri: mediaUri('pptx-renderer.es.js'),
			viewerJsUri: mediaUri('pptxViewer.js'),
			viewerCssUri: mediaUri('pptxViewer.css'),
		});

		this.webview = this.webviewListeners.add(this.webviewService.createWebviewElement({
			title: localize('wfm.pptx.viewer.title', "WFM PPT 预览"),
			options: { retainContextWhenHidden: true },
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [MEDIA_ROOT],
			},
			extension: undefined,
		}));

		const host = dom.append(this.container, $('.wfm-pptx-viewer-host'));
		host.style.width = '100%';
		host.style.height = '100%';
		host.style.position = 'absolute';
		host.style.inset = '0';
		this.container.style.position = 'relative';
		this.webview.mountTo(host, this.window);
		this.webview.setHtml(html);

		this.webviewListeners.add(this.webview.onMessage(evt => {
			this.handleWebviewMessage(evt.message as PptxWebviewToMainMessage);
		}));
	}

	private handleWebviewMessage(msg: PptxWebviewToMainMessage): void {
		if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') { return; }
		switch (msg.kind) {
			case 'ready':
				this.logService.trace(`${LOG_PREFIX} webview script ready`);
				break;
			case 'rendered':
				this.logService.trace(`${LOG_PREFIX} pptx rendered (${msg.slideCount} slides)`);
				break;
			case 'error':
				this.logService.warn(`${LOG_PREFIX} webview error: ${msg.message}`);
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize('wfm.pptx.viewer.runtimeError', "PPT 预览错误: {0}", msg.message),
				});
				break;
			case 'selectionToChat':
				this.handleSelectionToChat(msg.slideIndex, msg.shapeIndex, msg.shapeName, msg.runStart, msg.runEnd, msg.selectedText);
				break;
			case 'reloadRequest':
				void this.rescueReloadWebview();
				break;
		}
	}

	/**
	 * 把选区送到 Chat。
	 *
	 * 复用 chatWidget 的 `addFile(uri, range)` 现有 chip 机制；把 PPT 的四维信息
	 * (slideIdx, shapeIdx, runStart, runEnd) 编码进 IRange 的四个字段：
	 *   - startLineNumber = slideIdx + 1                （1-based 页码）
	 *   - endLineNumber   = slideIdx + 1
	 *   - startColumn     = shapeIdx + 1                （1-based 形状号；选 -1 表示整页）
	 *   - endColumn       = (runEnd >= 0 ? runEnd + 1 : 0)
	 *
	 * agent 端的 `wfmClaudeAgent.contribution.ts:_stitchAttachments` 会识别 .pptx
	 * 扩展名并把这套数字翻译成人类可读的提示。chip 上 VS Code 默认渲染为
	 * `汇报.pptx:3:2`，虽然不漂亮但可点击跳转、用户能识别。
	 */
	private async handleSelectionToChat(
		slideIndex: number,
		shapeIndex: number,
		shapeName: string,
		runStart: number,
		runEnd: number,
		selectedText: string,
	): Promise<void> {
		if (!this.currentResource || !this.currentFileName) {
			this.logService.warn(`${LOG_PREFIX} selectionToChat but no current file`);
			return;
		}
		void shapeName;     // 当前不参与编码（agent 端按 index 回查 PPTX 拿名字），但保留以备 chip tooltip
		void selectedText;  // 同上：保留以备离线兜底

		await this.viewsService.openView(ChatViewId, true);
		const widget = this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)[0]
			?? this.chatWidgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}
		widget.focusInput();

		// 编码 see comment above
		const startLineNumber = slideIndex + 1;
		const endLineNumber = slideIndex + 1;
		const startColumn = shapeIndex >= 0 ? shapeIndex + 1 : 1;
		const endColumn = runEnd >= 0 ? runEnd + 1 : 0;

		try {
			widget.attachmentModel.addFile(URI.parse(this.currentResource), {
				startLineNumber,
				startColumn,
				endLineNumber,
				endColumn: Math.max(endColumn, startColumn),
			});
			// runStart 单独不在 Range 里表达（只用 runEnd 锚定到选区终点；agent 端能根据
			// `_stitchAttachments` 的提示拿到 shape+run 起始位置回读 PPTX）。当前
			// runStart 主要给 chip tooltip 用，TODO：未来如果 chip 改造支持携带 metadata，
			// 可以把 (runStart, runEnd) 完整传过去。
			void runStart;
		} catch (err) {
			this.logService.warn(`${LOG_PREFIX} addFile failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private showStatus(message: string, isError: boolean): void {
		if (!this.statusEl || !this.container) { return; }
		this.statusEl.hidden = false;
		this.statusEl.textContent = message;
		this.statusEl.classList.toggle('is-error', isError);
	}

	private hideStatus(): void {
		if (this.statusEl) { this.statusEl.hidden = true; }
	}

	override clearInput(): void {
		this.currentResource = undefined;
		this.currentFileName = undefined;
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}

	override focus(): void {
		this.webview?.focus();
	}

	override dispose(): void {
		this.webview = undefined;
		super.dispose();
	}
}
