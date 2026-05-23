/*---------------------------------------------------------------------------------------------
 *  WFM Studio DOCX viewer — webview-based Word rendering EditorPane.
 *
 *  Renders .docx files inside a VS Code webview using the docx-preview library.
 *  P2: selection tracking → floating toolbar → send to Chat.
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
import { ChatViewId, IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import {
		DOCX_VIEWER_BYTE_LIMIT,
		DOCX_VIEWER_EDITOR_ID,
		DOCX_FILE_EXTENSION,
} from '../common/docxViewer.js';
import { DocxViewerEditorInput } from './docxViewerEditorInput.js';
import { DocxWebviewToMainMessage, IDocxLoadMessage } from './docxViewerMessages.js';
import { createDocumentReference } from './docxSelectionHelper.js';
import { webviewGenericCspSource } from '../../../webview/common/webview.js';

const $ = dom.$;
const LOG_PREFIX = '[wfm-docx-viewer]';

/** webview 的 localResourceRoots，指向 media 目录。 */
const MEDIA_ROOT = FileAccess.asFileUri(
	'vs/workbench/contrib/wfm/docxViewer/browser/media/',
);

interface IViewerHtmlArgs {
	readonly nonce: string;
	readonly cspSource: string;
	readonly jsZipUri: string;
	readonly docxPreviewUri: string;
	readonly viewerJsUri: string;
	readonly viewerCssUri: string;
}

function buildViewerHtml(args: IViewerHtmlArgs): string {
	const { nonce, cspSource, jsZipUri, docxPreviewUri, viewerJsUri, viewerCssUri } = args;

	const csp = [
		`default-src 'none'`,
		`script-src ${cspSource} 'nonce-${nonce}'`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`img-src ${cspSource} data: blob:`,
		`font-src ${cspSource} data:`,
		`connect-src ${cspSource} blob: data:`,
	].join('; ');

	return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${viewerCssUri}">
<title>WFM Word 预览</title>
</head>
<body>
<div id="wfm-docx-toolbar"><span id="wfm-docx-filename"></span></div>
<div id="wfm-docx-loading">正在渲染文档…</div>
<div id="wfm-docx-container"></div>
<div id="wfm-selection-toolbar">
	<button id="wfm-send-selection">发送到对话</button>
</div>
<div id="wfm-docx-error"></div>
<script nonce="${nonce}" src="${jsZipUri}"></script>
<script nonce="${nonce}" src="${docxPreviewUri}"></script>
<script nonce="${nonce}" src="${viewerJsUri}"></script>
</body>
</html>`;
}

export class DocxViewerEditor extends EditorPane {

	static readonly ID = DOCX_VIEWER_EDITOR_ID;

	private container: HTMLElement | undefined;
	private statusEl: HTMLElement | undefined;
	private webview: IWebviewElement | undefined;
	private readonly webviewListeners = this._register(new DisposableStore());
	private currentResource: string | undefined;
	private currentFileName: string | undefined;

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
		super(DocxViewerEditor.ID, group, telemetryService, themeService, storageService);

		this._register(this.themeService.onDidColorThemeChange(theme => {
			this.webview?.postMessage({
				kind: 'theme',
				isDark: theme.type === ColorScheme.DARK || theme.type === ColorScheme.HIGH_CONTRAST_DARK,
			});
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, $('.wfm-docx-viewer-pane'));
		this.statusEl = dom.append(this.container, $('.wfm-docx-viewer-loading'));
		this.statusEl.textContent = localize('wfm.docx.viewer.loading', "正在加载 Word 视图…");
	}

	override async setInput(
		input: DocxViewerEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		const resource = input.resource;
		const ext = extname(resource).toLowerCase();
		if (ext !== DOCX_FILE_EXTENSION) {
			this.showStatus(
				localize('wfm.docx.viewer.unsupported', "不支持的扩展名: {0}", resource.path),
				/*isError*/ true,
			);
			return;
		}

		if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
			this.showStatus(
				localize('wfm.docx.viewer.notLocal', "Word 预览暂不支持 scheme: {0}", resource.scheme),
				/*isError*/ true,
			);
			return;
		}

		try {
			const stat = await this.fileService.stat(resource);
			if (token.isCancellationRequested) { return; }
			if (stat.size && stat.size > DOCX_VIEWER_BYTE_LIMIT) {
				this.showStatus(
					localize(
						'wfm.docx.viewer.tooLarge',
						"文件过大 ({0} MB > {1} MB)",
						(stat.size / 1024 / 1024).toFixed(1),
						(DOCX_VIEWER_BYTE_LIMIT / 1024 / 1024).toFixed(0),
					),
					/*isError*/ true,
				);
				return;
			}

			this.ensureWebview();
			if (!this.webview || !this.container) { return; }

			const content = await this.fileService.readFile(resource);
			if (token.isCancellationRequested) { return; }

			this.currentResource = resource.toString();
			this.currentFileName = input.getName();
			this.hideStatus();

			const isDark = this.themeService.getColorTheme().type === ColorScheme.DARK
				|| this.themeService.getColorTheme().type === ColorScheme.HIGH_CONTRAST_DARK;

			const buffer = (content.value.buffer as Uint8Array).slice().buffer;
			await this.webview.postMessage(
				{ kind: 'load', fileName: input.getName(), isDark, bytes: buffer } as IDocxLoadMessage & { bytes: ArrayBuffer },
				[buffer],
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn(`${LOG_PREFIX} setInput failed: ${message}`);
			this.showStatus(
				localize('wfm.docx.viewer.readFailed', "读取文件失败: {0}", message),
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
			jsZipUri: mediaUri('jszip.min.js'),
			docxPreviewUri: mediaUri('docx-preview.min.js'),
			viewerJsUri: mediaUri('docxViewer.js'),
			viewerCssUri: mediaUri('docxViewer.css'),
		});

		this.webview = this.webviewListeners.add(this.webviewService.createWebviewElement({
			title: localize('wfm.docx.viewer.title', "WFM Word 预览"),
			options: { retainContextWhenHidden: true },
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [MEDIA_ROOT],
			},
			extension: undefined,
		}));

		const host = dom.append(this.container, $('.wfm-docx-viewer-host'));
		host.style.width = '100%';
		host.style.height = '100%';
		host.style.position = 'absolute';
		host.style.inset = '0';
		this.container.style.position = 'relative';
		this.webview.mountTo(host, this.window);
		this.webview.setHtml(html);

		this.webviewListeners.add(this.webview.onMessage(evt => {
			this.handleWebviewMessage(evt.message as DocxWebviewToMainMessage);
		}));
	}

	private handleWebviewMessage(msg: DocxWebviewToMainMessage): void {
		if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') { return; }
		switch (msg.kind) {
			case 'ready':
				this.logService.trace(`${LOG_PREFIX} webview ready`);
				break;
			case 'error':
				this.logService.warn(`${LOG_PREFIX} webview error: ${msg.message}`);
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize('wfm.docx.viewer.runtimeError', "Word 预览错误: {0}", msg.message),
				});
				break;
			case 'selectionToChat':
				this.handleSelectionToChat(msg.startPara, msg.endPara, msg.selectedText);
				break;
		}
	}

	private async handleSelectionToChat(startPara: number, endPara: number, selectedText: string): Promise<void> {
		if (!this.currentResource || !this.currentFileName) {
			this.logService.warn(`${LOG_PREFIX} selectionToChat but no current file`);
			return;
		}
		const ref = createDocumentReference(
			this.currentFileName,
			this.currentResource,
			{ startPara, endPara, selectedText },
		);
		await this.viewsService.openView(ChatViewId, true);
		const widget = this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)[0]
			?? this.chatWidgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}
		widget.focusInput();
		widget.setInput(`[文档: ${ref.displayLabel}]\n${ref.selectedText}`);
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
