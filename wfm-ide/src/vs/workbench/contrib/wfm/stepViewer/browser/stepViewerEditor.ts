/*---------------------------------------------------------------------------------------------
 *  WFM Studio 3D viewer — webview-based EditorPane.
 *
 *  双击 .step/.stp/.stl 文件时，在中央编辑区用 Three.js 渲染 3D 模型。
 *  数据流:
 *    - STEP/STP → (Python subprocess) → GLB → postMessage(ArrayBuffer) → webview
 *    - STL      → 直接 postMessage(ArrayBuffer) → webview（STLLoader 解析）
 *  架构参照 cadViewerEditor.ts。
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { extname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
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
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWfmStepConverterService } from '../../../../../platform/wfmStepConverter/common/wfmStepConverter.js';
import {
	STEP_VIEWER_BYTE_LIMIT,
	STEP_VIEWER_EDITOR_ID,
	modelFormatForExtension,
} from '../common/stepViewer.js';
import { StepViewerEditorInput } from './stepViewerEditorInput.js';
import {
	StepWebviewToMainMessage,
} from './stepViewerMessages.js';

const $ = dom.$;
const LOG_PREFIX = '[wfm-step-viewer]';

const MEDIA_ROOT = FileAccess.asFileUri(
	'vs/workbench/contrib/wfm/stepViewer/browser/media/',
);

interface IViewerHtmlArgs {
	readonly nonce: string;
	readonly cspSource: string;
	readonly viewerJsUri: string;
	readonly viewerCssUri: string;
	readonly bundleUri: string;
}

function buildViewerHtml(args: IViewerHtmlArgs): string {
	const { nonce, cspSource, viewerJsUri, viewerCssUri, bundleUri } = args;

	const csp = [
		`default-src 'none'`,
		`script-src ${cspSource} 'nonce-${nonce}'`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`img-src ${cspSource} data: blob:`,
		`connect-src ${cspSource} blob: data:`,
	].join('; ');

	return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${viewerCssUri}">
<title>WFM STEP Viewer</title>
</head>
<body>
<div id="step-loading">
	<div class="step-spinner"></div>
	<div id="step-loading-text">Loading STEP viewer...</div>
</div>
<div id="step-toolbar">
	<span id="step-filename"></span>
	<div class="step-separator"></div>
	<div class="step-btn-group">
		<button data-preset="solid" class="step-btn active">Solid</button>
		<button data-preset="technical" class="step-btn">Technical</button>
		<button data-preset="clay" class="step-btn">Clay</button>
		<button data-preset="normals" class="step-btn">Normals</button>
		<button data-preset="xray" class="step-btn">X-Ray</button>
		<button data-preset="wire" class="step-btn">Wire</button>
	</div>
	<div class="step-separator"></div>
	<button id="step-edges" class="step-btn active">Edges</button>
	<div class="step-separator"></div>
	<div class="step-btn-group">
		<button data-view="front" class="step-btn">Front</button>
		<button data-view="top" class="step-btn">Top</button>
		<button data-view="iso" class="step-btn">Iso</button>
	</div>
	<button id="step-fit" class="step-btn" title="Fit to view">Fit</button>
	<div class="step-separator"></div>
	<button id="step-refresh" class="step-btn" title="销毁并重建 3D 渲染（黑屏/卡顿/不显示时点这里，比 Reload Window 快）">⟳ 重载视图</button>
</div>
<div id="step-canvas-host"></div>
<div id="step-status"></div>
<script nonce="${nonce}" src="${bundleUri}"></script>
<script nonce="${nonce}" src="${viewerJsUri}"></script>
</body>
</html>`;
}

function glbCachePath(stepUri: URI): { glbUri: URI; hashUri: URI } {
	const stepPath = stepUri.path;
	const dir = stepPath.substring(0, stepPath.lastIndexOf('/'));
	const fileName = stepPath.substring(stepPath.lastIndexOf('/') + 1);
	const glbName = '.' + fileName + '.glb';
	const hashName = '.' + fileName + '.glb.hash';
	return {
		glbUri: stepUri.with({ path: dir + '/' + glbName }),
		hashUri: stepUri.with({ path: dir + '/' + hashName }),
	};
}

export class StepViewerEditor extends EditorPane {

	static readonly ID = STEP_VIEWER_EDITOR_ID;

	private container: HTMLElement | undefined;
	private statusEl: HTMLElement | undefined;
	private webview: IWebviewElement | undefined;
	private readonly webviewListeners = this._register(new DisposableStore());
	private dimension: Dimension | undefined;

	/** 当前已打开的资源，rescue 重建 webview 时用来重新 push 数据。 */
	private currentResource: URI | undefined;
	private currentFileName: string | undefined;

	/** 防并发的 webview 重建——工具栏「重载视图」按钮点击会触发。 */
	private rescueInFlight = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWfmStepConverterService private readonly stepConverterService: IWfmStepConverterService,
	) {
		super(StepViewerEditor.ID, group, telemetryService, themeService, storageService);

		this._register(this.themeService.onDidColorThemeChange(theme => {
			this.webview?.postMessage({
				kind: 'theme',
				isDark: theme.type === ColorScheme.DARK || theme.type === ColorScheme.HIGH_CONTRAST_DARK,
			});
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, $('.wfm-step-viewer-pane'));
		this.statusEl = dom.append(this.container, $('.wfm-step-viewer-loading'));
		this.statusEl.textContent = localize('wfm.step.viewer.loading', "正在加载 STEP 视图…");
	}

	override async setInput(
		input: StepViewerEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		const resource = input.resource;
		const ext = extname(resource).toLowerCase();
		const format = modelFormatForExtension(ext);
		if (!format) {
			this.showStatus(localize('wfm.step.viewer.unsupported', "不支持的扩展名: {0}", resource.path), true);
			return;
		}

		if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
			this.showStatus(localize('wfm.step.viewer.notLocal', "3D viewer 暂不支持 scheme: {0}", resource.scheme), true);
			return;
		}

		const fileName = input.getName();

		this.currentResource = resource;
		this.currentFileName = fileName;

		try {
			const stat = await this.fileService.stat(resource);
			if (token.isCancellationRequested) { return; }
			if (stat.size && stat.size > STEP_VIEWER_BYTE_LIMIT) {
				this.showStatus(localize(
					'wfm.step.viewer.tooLarge',
					"文件过大 ({0} MB > {1} MB)。",
					(stat.size / 1024 / 1024).toFixed(1),
					(STEP_VIEWER_BYTE_LIMIT / 1024 / 1024).toFixed(0),
				), true);
				return;
			}

			this.ensureWebview();
			if (!this.webview || !this.container) { return; }

			await this.pushCurrentResourceToWebview(token);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn(`${LOG_PREFIX} setInput failed: ${message}`);
			// Surface the error in the webview overlay (which is above the hidden statusEl).
			this.webview?.postMessage({
				kind: 'progress',
				stage: 'error',
				message: localize('wfm.step.viewer.readFailed', "加载失败: {0}", message),
				isError: true,
			});
			this.showStatus(localize('wfm.step.viewer.readFailed', "加载失败: {0}", message), true);
		}
	}

	/**
	 * 把 `currentResource` 读出来 post 给 webview。
	 * 供 setInput 首次加载与 rescueReloadWebview 重建后复用。
	 */
	private async pushCurrentResourceToWebview(token: CancellationToken): Promise<void> {
		if (!this.webview || !this.currentResource || !this.currentFileName) { return; }
		const resource = this.currentResource;
		const fileName = this.currentFileName;
		const ext = extname(resource).toLowerCase();
		const format = modelFormatForExtension(ext);
		if (!format) { return; }

		let meshBuffer: ArrayBuffer;
		if (format === 'stl') {
			const stlContent = await this.fileService.readFile(resource);
			if (token.isCancellationRequested) { return; }
			meshBuffer = (stlContent.value.buffer as Uint8Array).slice().buffer;
		} else {
			const cache = glbCachePath(resource);
			try {
				const glbContent = await this.fileService.readFile(cache.glbUri);
				if (token.isCancellationRequested) { return; }
				meshBuffer = (glbContent.value.buffer as Uint8Array).slice().buffer;
				this.logService.info(`${LOG_PREFIX} cache hit: ${cache.glbUri}`);
			} catch {
				this.logService.info(`${LOG_PREFIX} cache miss, converting STEP → GLB...`);
				meshBuffer = await this.convertStepToGlb(resource, cache, token);
			}
		}

		if (token.isCancellationRequested) { return; }
		this.hideStatus();

		const isDark = this.themeService.getColorTheme().type === ColorScheme.DARK
			|| this.themeService.getColorTheme().type === ColorScheme.HIGH_CONTRAST_DARK;

		await this.webview.postMessage({
			kind: 'load' as const,
			format,
			uri: resource.toString(),
			fileName,
			isDark,
			bytes: meshBuffer,
		}, [meshBuffer]);
	}

	/**
	 * 销毁现有 webview 并重建，然后重新 push 当前文件。
	 *
	 * 由 viewer 工具栏「重载视图」按钮触发（webview → main 的 `reloadRequest`）。
	 * 如果 webview 已完全卡死、in-webview 按钮点不到，这条路径触发不了，
	 * 用户仍需 Reload Window，这是已知限制。
	 */
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
				await this.pushCurrentResourceToWebview(CancellationToken.None);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.error(`${LOG_PREFIX} rescue reload failed: ${message}`);
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize('wfm.step.viewer.rescueFailed', "重建 3D 视图失败: {0}。请关闭后重新打开文件。", message),
			});
		} finally {
			this.rescueInFlight = false;
		}
	}

	private async convertStepToGlb(
		stepUri: URI,
		cache: { glbUri: URI; hashUri: URI },
		token: CancellationToken,
	): Promise<ArrayBuffer> {
		this.webview?.postMessage({ kind: 'progress', stage: 'converting', message: 'Converting STEP to GLB…' });

		// Sandbox-safe: spawning + path resolution is delegated to the
		// main-process WfmStepConverterMainService via IPC.
		const workspaceRoots = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath);

		try {
			const result = await this.stepConverterService.convertStepToGlb({
				stepPath: stepUri.fsPath,
				glbPath: cache.glbUri.fsPath,
				workspaceRoots,
			});
			if (token.isCancellationRequested) { throw new Error('cancelled'); }
			this.logService.info(`${LOG_PREFIX} converted in ${result.elapsedMs}ms, ${(result.glbSize / 1024).toFixed(1)}KB`);

			const glbContent = await this.fileService.readFile(cache.glbUri);
			if (token.isCancellationRequested) { throw new Error('cancelled'); }
			return (glbContent.value.buffer as Uint8Array).slice().buffer;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === 'cancelled') { throw err; }
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize(
					'wfm.step.viewer.conversionFailed',
					"STEP → GLB 转换失败: {0}",
					message,
				),
			});
			throw err;
		}
	}

	private ensureWebview(): void {
		if (this.webview || !this.container) { return; }

		const nonce = generateUuid().replace(/-/g, '');
		const mediaUri = (file: string) => asWebviewUri(joinPath(MEDIA_ROOT, file)).toString(true);

		const html = buildViewerHtml({
			nonce,
			cspSource: 'https://*.vscode-cdn.net',
			viewerJsUri: mediaUri('viewer.js'),
			viewerCssUri: mediaUri('viewer.css'),
			bundleUri: mediaUri('step-viewer.iife.js'),
		});

		this.webview = this.webviewListeners.add(this.webviewService.createWebviewElement({
			title: localize('wfm.step.viewer.title', "WFM STEP Viewer"),
			options: { retainContextWhenHidden: true },
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [MEDIA_ROOT],
			},
			extension: undefined,
		}));

		const host = dom.append(this.container, $('.wfm-step-viewer-host'));
		host.style.width = '100%';
		host.style.height = '100%';
		host.style.position = 'absolute';
		host.style.inset = '0';
		this.container.style.position = 'relative';
		this.webview.mountTo(host, this.window);
		this.webview.setHtml(html);

		this.webviewListeners.add(this.webview.onMessage(evt => {
			this.handleWebviewMessage(evt.message as StepWebviewToMainMessage);
		}));
	}

	private handleWebviewMessage(msg: StepWebviewToMainMessage): void {
		if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') { return; }
		switch (msg.kind) {
			case 'ready':
				this.logService.trace(`${LOG_PREFIX} webview ready`);
				break;
			case 'error':
				this.logService.warn(`${LOG_PREFIX} webview error: ${msg.message}`);
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize('wfm.step.viewer.runtimeError', "STEP viewer 错误: {0}", msg.message),
				});
				break;
			case 'renderStats':
				this.logService.trace(`${LOG_PREFIX} ${msg.meshCount} meshes, ${msg.triangleCount} tris, ${msg.loadMs}ms`);
				break;
			case 'reloadRequest':
				void this.rescueReloadWebview();
				break;
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}

	override clearInput(): void {
		this.currentResource = undefined;
		this.currentFileName = undefined;
		super.clearInput();
	}

	override dispose(): void {
		this.webview = undefined;
		super.dispose();
	}

	private showStatus(text: string, isError = false): void {
		if (this.statusEl) {
			this.statusEl.textContent = text;
			this.statusEl.style.color = isError ? 'var(--vscode-errorForeground)' : '';
			this.statusEl.style.display = 'block';
		}
	}

	private hideStatus(): void {
		if (this.statusEl) {
			this.statusEl.style.display = 'none';
		}
	}
}
