/*---------------------------------------------------------------------------------------------
 *  WFM Studio HTML preview — webview-based HTML rendering EditorPane.
 *
 *  Renders .html / .htm files inside a sandboxed iframe (srcdoc) within a
 *  VS Code webview.  Default double-click still opens the text editor; this
 *  pane is only reachable via the "预览 HTML" Explorer context-menu action.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extname } from '../../../../../base/common/resources.js';
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
import {
	HTML_PREVIEW_BYTE_LIMIT,
	HTML_PREVIEW_EDITOR_ID,
	HTML_FILE_EXTENSION,
	HTM_FILE_EXTENSION,
} from '../common/htmlPreview.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';
import { HtmlWebviewToMainMessage } from './htmlPreviewMessages.js';

const $ = dom.$;
const LOG_PREFIX = '[wfm-html-preview]';

function buildPreviewHtml(nonce: string): string {
	const csp = [
		`default-src 'none'`,
		`script-src 'nonce-${nonce}'`,
		`style-src 'unsafe-inline'`,
		`img-src data: blob: http: https:`,
		`font-src data: http: https:`,
		`connect-src *`,
		`frame-src data: blob:`,
	].join('; ');

	return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>WFM HTML 预览</title>
<style>
	* { margin: 0; padding: 0; box-sizing: border-box; }
	html, body { width: 100%; height: 100%; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
	body { display: flex; flex-direction: column; background: #fff; color: #333; }
	body.is-dark { background: #1e1e1e; color: #ccc; }
	#wfm-html-toolbar {
		flex-shrink: 0; height: 32px; display: flex; align-items: center;
		padding: 0 12px; border-bottom: 1px solid #e0e0e0; font-size: 12px;
	}
	body.is-dark #wfm-html-toolbar { border-bottom-color: #404040; }
	#wfm-html-filename { opacity: 0.7; }
	#wfm-html-host { flex: 1; position: relative; }
	#wfm-html-frame {
		position: absolute; inset: 0; width: 100%; height: 100%;
		border: none; background: #fff;
	}
	body.is-dark #wfm-html-frame { background: #1e1e1e; }
	#wfm-html-error {
		flex-shrink: 0; padding: 8px 12px; background: #fdd; color: #b00;
		font-size: 12px; display: none;
	}
	body.is-dark #wfm-html-error { background: #3a1010; color: #f66; }
</style>
</head>
<body>
<div id="wfm-html-toolbar"><span id="wfm-html-filename"></span></div>
<div id="wfm-html-host">
	<iframe id="wfm-html-frame" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
</div>
<div id="wfm-html-error"></div>
<script nonce="${nonce}">
(function() {
	const vscodeApi = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
	const frame = document.getElementById('wfm-html-frame');
	const errorEl = document.getElementById('wfm-html-error');
	const filenameEl = document.getElementById('wfm-html-filename');

	function postMain(msg) {
		if (vscodeApi) { vscodeApi.postMessage(msg); }
		else { window.parent.postMessage(msg, '*'); }
	}

	window.addEventListener('message', function(event) {
		var msg = (vscodeApi ? event.data : event.data) || {};
		if (typeof msg !== 'object' || typeof msg.kind !== 'string') return;

		switch (msg.kind) {
			case 'load':
				filenameEl.textContent = msg.fileName || '';
				if (msg.isDark) { document.body.classList.add('is-dark'); }
				else { document.body.classList.remove('is-dark'); }
				frame.srcdoc = msg.htmlContent || '';
				errorEl.style.display = 'none';
				break;
			case 'theme':
				if (msg.isDark) { document.body.classList.add('is-dark'); }
				else { document.body.classList.remove('is-dark'); }
				break;
		}
	});

	frame.addEventListener('error', function() {
		errorEl.textContent = '渲染失败';
		errorEl.style.display = 'block';
	});

	postMain({ kind: 'ready' });
})();
</script>
</body>
</html>`;
}

export class HtmlPreviewEditor extends EditorPane {

	static readonly ID = HTML_PREVIEW_EDITOR_ID;

	private container: HTMLElement | undefined;
	private statusEl: HTMLElement | undefined;
	private webview: IWebviewElement | undefined;
	private readonly webviewListeners = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super(HtmlPreviewEditor.ID, group, telemetryService, themeService, storageService);

		this._register(this.themeService.onDidColorThemeChange(theme => {
			this.webview?.postMessage({
				kind: 'theme',
				isDark: theme.type === ColorScheme.DARK || theme.type === ColorScheme.HIGH_CONTRAST_DARK,
			});
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, $('.wfm-html-preview-pane'));
		this.statusEl = dom.append(this.container, $('.wfm-html-preview-loading'));
		this.statusEl.textContent = localize('wfm.html.preview.loading', "正在加载 HTML 预览…");
	}

	override async setInput(
		input: HtmlPreviewEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		const resource = input.resource;
		const ext = extname(resource).toLowerCase();
		if (ext !== HTML_FILE_EXTENSION && ext !== HTM_FILE_EXTENSION) {
			this.showStatus(
				localize('wfm.html.preview.unsupported', "不支持的扩展名: {0}", resource.path),
				/*isError*/ true,
			);
			return;
		}

		if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
			this.showStatus(
				localize('wfm.html.preview.notLocal', "HTML 预览暂不支持 scheme: {0}", resource.scheme),
				/*isError*/ true,
			);
			return;
		}

		try {
			const stat = await this.fileService.stat(resource);
			if (token.isCancellationRequested) { return; }
			if (stat.size && stat.size > HTML_PREVIEW_BYTE_LIMIT) {
				this.showStatus(
					localize(
						'wfm.html.preview.tooLarge',
						"文件过大 ({0} MB > {1} MB)",
						(stat.size / 1024 / 1024).toFixed(1),
						(HTML_PREVIEW_BYTE_LIMIT / 1024 / 1024).toFixed(0),
					),
					/*isError*/ true,
				);
				return;
			}

			this.ensureWebview();
			if (!this.webview || !this.container) { return; }

			const content = await this.fileService.readFile(resource);
			if (token.isCancellationRequested) { return; }

			const htmlContent = content.value.toString();
			this.hideStatus();

			const isDark = this.themeService.getColorTheme().type === ColorScheme.DARK
				|| this.themeService.getColorTheme().type === ColorScheme.HIGH_CONTRAST_DARK;

			await this.webview.postMessage({
				kind: 'load',
				htmlContent,
				fileName: input.getName(),
				isDark,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn(`${LOG_PREFIX} setInput failed: ${message}`);
			this.showStatus(
				localize('wfm.html.preview.readFailed', "读取文件失败: {0}", message),
				/*isError*/ true,
			);
		}
	}

	private ensureWebview(): void {
		if (this.webview || !this.container) { return; }

		const nonce = generateUuid().replace(/-/g, '');
		const html = buildPreviewHtml(nonce);

		this.webview = this.webviewListeners.add(this.webviewService.createWebviewElement({
			title: localize('wfm.html.preview.title', "WFM HTML 预览"),
			options: { retainContextWhenHidden: true },
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [],
			},
			extension: undefined,
		}));

		const host = dom.append(this.container, $('.wfm-html-preview-host'));
		host.style.width = '100%';
		host.style.height = '100%';
		host.style.position = 'absolute';
		host.style.inset = '0';
		this.container.style.position = 'relative';
		this.webview.mountTo(host, this.window);
		this.webview.setHtml(html);

		this.webviewListeners.add(this.webview.onMessage(evt => {
			this.handleWebviewMessage(evt.message as HtmlWebviewToMainMessage);
		}));
	}

	private handleWebviewMessage(msg: HtmlWebviewToMainMessage): void {
		if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') { return; }
		switch (msg.kind) {
			case 'ready':
				this.logService.trace(`${LOG_PREFIX} webview ready`);
				break;
			case 'error':
				this.logService.warn(`${LOG_PREFIX} webview error: ${msg.message}`);
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize('wfm.html.preview.runtimeError', "HTML 预览错误: {0}", msg.message),
				});
				break;
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
