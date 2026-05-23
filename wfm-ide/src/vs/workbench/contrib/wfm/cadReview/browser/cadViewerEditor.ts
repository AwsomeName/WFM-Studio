/*---------------------------------------------------------------------------------------------
 *  WFM Studio CAD review — webview-based CAD viewer EditorPane.
 *
 *  v0.2: 在中央编辑区用 cad-viewer + libredwg-web (WASM) 在浏览器内
 *  渲染 .dwg / .dxf。后端不再做任何 DWG -> DXF 转换。
 *  详见 docs/ARCH_CAD_REVIEW.md §4。
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { extname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
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
	CAD_VIEWER_BYTE_LIMIT,
	CAD_VIEWER_EDITOR_ID,
	DWG_FILE_EXTENSION,
	DXF_FILE_EXTENSION,
} from '../common/cadReview.js';
import { CadViewerEditorInput } from './cadViewerEditorInput.js';
import {
	CadFileKind,
	CadWebviewToMainMessage,
	ICadLoadMessage,
} from './cadViewerMessages.js';

const $ = dom.$;
const LOG_PREFIX = '[wfm-cad-viewer]';

/** webview 的 localResourceRoots。指向我们 vendor 的 cad-viewer/libredwg 资源。 */
const MEDIA_ROOT = FileAccess.asFileUri(
	'vs/workbench/contrib/wfm/cadReview/browser/media/',
);

/**
 * 内联 viewer.html。把它做成 string 而不是磁盘文件，是为了：
 *  (1) 不用让 webview 走 service worker 二次跳转去 fetch HTML
 *  (2) viewer 的所有依赖 URL 由 main 端 asWebviewUri() 注入，避免 CSP 拼错
 *  (3) 主题色 / 文件名等参数即时填充，不用再 postMessage 一次
 */
interface IViewerHtmlArgs {
	readonly nonce: string;
	readonly cspSource: string;
	readonly viewerJsUri: string;
	readonly viewerCssUri: string;
	readonly cadViewerBundleUri: string;
	readonly libredwgWasmUri: string;
	/** webview 内的 media/ 基准 URI，**必须以 `/` 结尾**。
	 *  cad-simple-viewer 内部会做 `mediaBase + 'fonts/'` 拼接得到 fontLoader baseUrl。 */
	readonly mediaBaseUri: string;
	readonly workerUrls: {
		readonly dxfParser: string;
		readonly dwgParser: string;
		readonly mtextRender: string;
	};
}

function buildViewerHtml(args: IViewerHtmlArgs): string {
	const {
		nonce, cspSource, viewerJsUri, viewerCssUri, cadViewerBundleUri,
		libredwgWasmUri, mediaBaseUri, workerUrls,
	} = args;
	// CSP：
	//  - script-src: 允许 vendor bundle (cspSource) + 我们自己的 viewer.js +
	//    `wasm-unsafe-eval` 让 LibreDWG WASM 模块编译；libredwg emscripten glue
	//    会 `new Function(...)` / `eval(...)` 来生成调用桥（典型 emscripten 行为），
	//    所以也必须放 `unsafe-eval`。webview 是本地 vendor 代码，无外部脚本注入面，
	//    可以接受这条规则。
	//  - style-src: 'unsafe-inline' 给 cad-viewer 自己生成的内联样式（OrbitControls 等）
	//  - img-src: data: blob: 给 viewer 内 canvas 截图 / 自动生成的位图
	//  - connect-src: blob: 让 viewer 用 fetch(blob:) 取 wasm
	//  - worker-src: blob: 我们把 vendor worker 包成 same-origin blob URL 给浏览器
	const csp = [
		`default-src 'none'`,
		`script-src ${cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-eval' blob:`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`img-src ${cspSource} data: blob:`,
		`font-src ${cspSource} data:`,
		`connect-src ${cspSource} blob: data:`,
		`worker-src ${cspSource} blob:`,
	].join('; ');

	// 把 vendor 路径塞到 window.__WFM_CAD__ 里给 viewer.js 取用，避免在 viewer.js
	// 中硬编码任何 vscode-cdn URL（开发期方便 vendor 路径切换）。
	const bootstrapJson = JSON.stringify({
		cadViewerBundle: cadViewerBundleUri,
		libredwgWasm: libredwgWasmUri,
		mediaBase: mediaBaseUri,
		workerUrls,
	});

	return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${viewerCssUri}">
<title>WFM CAD 预览</title>
</head>
<body>
<div id="wfm-cad-toolbar">
	<span id="wfm-cad-filename"></span>
	<button id="wfm-cad-toggle-mode" class="wfm-cad-btn" title="切换 选择/平移 模式（左键行为）">
		<span data-mode-text>选择模式</span>
	</button>
	<button id="wfm-cad-zoom-fit" class="wfm-cad-btn" title="回到全图（双击中键也可）">
		<span class="codicon-like">⤢</span>
	</button>
	<button id="wfm-cad-refresh" class="wfm-cad-btn" title="销毁并重建 CAD 渲染（卡顿/异常时点这里恢复，比 Reload Window 快）">
		<span class="codicon-like">⟳</span> 重载视图
	</button>
	<button id="wfm-cad-toggle-layers" class="wfm-cad-btn" title="图层">
		图层
	</button>
	<button id="wfm-cad-review" class="wfm-cad-btn primary" title="把当前图发到右侧任务对话进行 AI 审图">
		AI 审图
	</button>
</div>
<div id="wfm-cad-status">正在加载 viewer 资源…</div>
<div id="wfm-cad-canvas-host"></div>
<div id="wfm-cad-tip" hidden>
	<div class="wfm-cad-tip-title">操作提示</div>
	<div>· 滚轮：缩放　· 右键拖动 / 中键拖动：平移</div>
	<div>· 左键单击：选择实体　· 左键框选：批量选择（窗口模式）</div>
	<div>· 切到「平移模式」后左键也能拖动画布</div>
	<div class="wfm-cad-tip-close">点击任意处关闭</div>
</div>
<div id="wfm-cad-layer-panel" hidden></div>
<div id="wfm-cad-error" hidden></div>
<div id="wfm-cad-sel-badge" hidden></div>
<div id="wfm-cad-ctx-menu" hidden>
	<div class="wfm-cad-ctx-item" data-action="send-selection">发送选中到对话</div>
	<div class="wfm-cad-ctx-sep"></div>
	<div class="wfm-cad-ctx-item wfm-cad-ctx-danger" data-action="delete-selection">删除</div>
</div>
<script nonce="${nonce}">window.__WFM_CAD__ = ${bootstrapJson};</script>
<script nonce="${nonce}" src="${cadViewerBundleUri}"></script>
<script nonce="${nonce}" src="${viewerJsUri}"></script>
</body>
</html>`;
}

function detectFileKind(uri: URI): CadFileKind | undefined {
	const ext = extname(uri).toLowerCase();
	if (ext === DWG_FILE_EXTENSION) {
		return 'dwg';
	}
	if (ext === DXF_FILE_EXTENSION) {
		return 'dxf';
	}
	return undefined;
}

/**
 * 扫 DXF 文本，给指定的 handle 集合算出 1-based 行范围（[startLine, endLine]）。
 *
 * DXF 行格式：交替的 group code / value 行。一个实体由 `0\n<TYPE>\n` 开头，
 * 至下一个 `0\n` 之前结束。每个实体内部的 handle 用 group code `5` 标记：
 * ```
 *     0
 * TEXT     ← entity 开头
 *     5
 * 3D1A6    ← handle
 *     ...
 *     0    ← 下一个 entity 开头（或 ENDSEC）
 * ```
 *
 * 注意：
 *  - group code 一般右对齐到 3 个字符宽（如 "  0"、"  5"），我们用 trim() 容错。
 *  - 实体也可能出现在 BLOCKS/OBJECTS 段。本函数只关心 handle 匹配，不区分段。
 *  - 找不到的 handle 不会出现在返回 Map 里，调用方据此判断是否兜底。
 */
export function findDxfEntityRanges(
	dxfText: string,
	wantedHandles: ReadonlySet<string>,
): Map<string, { start: number; end: number }> {
	const result = new Map<string, { start: number; end: number }>();
	if (wantedHandles.size === 0 || !dxfText) {
		return result;
	}
	const lines = dxfText.split(/\r?\n/);
	let entityStartLine = -1;     // 当前实体起始的 0 所在行 (0-based)
	let currentHandle: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed === '0') {
			// 关上一个实体
			if (currentHandle && wantedHandles.has(currentHandle) && entityStartLine >= 0 && !result.has(currentHandle)) {
				result.set(currentHandle, { start: entityStartLine + 1, end: i });
			}
			entityStartLine = i;
			currentHandle = undefined;
		} else if (trimmed === '5' && i + 1 < lines.length && entityStartLine >= 0) {
			const handle = lines[i + 1].trim().toUpperCase();
			if (handle && wantedHandles.has(handle)) {
				currentHandle = handle;
			}
		}
	}
	// 文件末尾仍未关闭的实体
	if (currentHandle && wantedHandles.has(currentHandle) && entityStartLine >= 0 && !result.has(currentHandle)) {
		result.set(currentHandle, { start: entityStartLine + 1, end: lines.length });
	}
	return result;
}

export class CadViewerEditor extends EditorPane {

	static readonly ID = CAD_VIEWER_EDITOR_ID;

	private container: HTMLElement | undefined;
	private statusEl: HTMLElement | undefined;
	private webview: IWebviewElement | undefined;
	private readonly webviewListeners = this._register(new DisposableStore());
	private currentResourceUri: string | undefined;
	private currentFileName: string | undefined;
	private currentResource: URI | undefined;
	private currentFileKind: CadFileKind | undefined;
	private dimension: Dimension | undefined;

	/** 当前文件的 IFileService 监听句柄（包含 watch() 注册 + onDidFilesChange listener）。
	 *  切到下一个文件 / 关闭 editor 时自动 dispose，避免泄露监听。 */
	private readonly fileWatcher = this._register(new MutableDisposable());
	/** 文件变更触发的去抖 timer。多次 save 在 200ms 内只触发一次 reload。 */
	private reloadDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	/** 自写抑制窗口：viewer 内部删除实体 → main 写盘 → fs watch 会再发一遍变更。
	 *  在窗口内（默认 1500ms）的文件变更事件直接忽略，防止把刚 push 给 webview
	 *  的编辑状态又被磁盘版本覆盖回去。值是绝对时间戳（ms）。 */
	private suppressWatchUntil = 0;
	/** 防并发 reload：在一次 reload 完成前再次触发只重新计一次。 */
	private reloadInFlight = false;

	/** 防并发的 webview 重建——viewer 工具栏「重载视图」按钮点击会触发。 */
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
		super(CadViewerEditor.ID, group, telemetryService, themeService, storageService);

		this._register(this.themeService.onDidColorThemeChange(theme => {
			this.webview?.postMessage({
				kind: 'theme',
				isDark: theme.type === ColorScheme.DARK || theme.type === ColorScheme.HIGH_CONTRAST_DARK,
			});
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, $('.wfm-cad-viewer-pane'));
		this.container.style.position = 'relative';
		this.statusEl = dom.append(this.container, $('.wfm-cad-viewer-loading'));
		this.statusEl.textContent = localize('wfm.cad.viewer.loading', "正在加载 CAD 视图…");

		// 实际的 webview 在 setInput 里按需挂载——这样切到下一个文件时
		// 我们重用同一个 webview，省一次 ~6 MB bundle 重新解析的开销。
	}

	/**
	 * 强制销毁现有 webview 并重新创建 + 重新发 load。
	 *
	 * viewer 工具栏「重载视图」按钮触发（webview → main 的 `reloadRequest`）。
	 * 区别于既有 `pushLoadFromDisk`（只是再发一次字节，对死掉的 webview 没用），
	 * 这里会把 IWebviewElement 整个扔掉，连同它 retain 的 6 MB cad-viewer
	 * bundle 和 wasm 实例都 GC 掉，然后 ensureWebview() 重建。
	 *
	 * 注意：如果 webview 已经完全卡死，viewer 内按钮的 click 也派发不出来 →
	 * 这条路径压根触发不了，用户只能 reload window。这是已知限制，按用户偏好
	 * 不上 host-side 营救横幅，避免误报遮挡正常 toolbar。
	 */
	private async rescueReloadWebview(): Promise<void> {
		if (this.rescueInFlight) {
			return;
		}
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
			if (this.currentResource) {
				await this.pushLoadFromDisk('manual');
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.error(`${LOG_PREFIX} rescue reload failed: ${message}`);
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize('wfm.cad.viewer.rescueFailed', "重建 CAD 视图失败: {0}。请关闭后重新打开文件。", message),
			});
		} finally {
			this.rescueInFlight = false;
		}
	}

	override async setInput(
		input: CadViewerEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		const resource = input.resource;
		const fileKind = detectFileKind(resource);
		if (!fileKind) {
			this.showStatus(
				localize(
					'wfm.cad.viewer.unsupported',
					"不支持的扩展名: {0}",
					resource.path,
				),
				/*isError*/ true,
			);
			return;
		}

		// 只支持本地文件（与 editor 关联条件一致）。
		if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
			this.showStatus(
				localize(
					'wfm.cad.viewer.notLocal',
					"WFM CAD viewer 暂不支持 scheme: {0}",
					resource.scheme,
				),
				/*isError*/ true,
			);
			return;
		}

		const fileName = input.getName();
		this.currentResource = resource;
		this.currentFileName = fileName;
		this.currentResourceUri = resource.toString();
		this.currentFileKind = fileKind;

		this.ensureWebview();
		if (!this.webview || !this.container) {
			return;
		}

		// 装载 + 后续的自动刷新走同一条路径。
		await this.pushLoadFromDisk('initial', token);
		this.setupFileWatcher(resource);
	}

	/**
	 * 读磁盘上的当前 CAD 文件，把字节通过 transferable 发到 webview。
	 *
	 * 复用场景：
	 *  - `setInput` 首次打开 (`reason='initial'`)
	 *  - 用户点 toolbar 刷新按钮 (`reason='manual'`)
	 *  - 文件被外部改写、IFileService.watch 命中 (`reason='watch'`)
	 *
	 * 单飞：`reloadInFlight` 防止并发刷新堆积——若 watch 在 reload 进行中再次
	 * 触发，会被去抖 timer 排到下一拍。
	 */
	private async pushLoadFromDisk(
		reason: 'initial' | 'manual' | 'watch',
		token?: CancellationToken,
	): Promise<void> {
		const resource = this.currentResource;
		const fileName = this.currentFileName;
		const fileKind = this.currentFileKind;
		if (!resource || !fileName || !fileKind || !this.webview || !this.container) {
			return;
		}
		if (this.reloadInFlight) {
			this.logService.trace(`${LOG_PREFIX} skip reload (in-flight) reason=${reason}`);
			return;
		}
		this.reloadInFlight = true;
		try {
			const stat = await this.fileService.stat(resource);
			if (token?.isCancellationRequested) {
				return;
			}
			if (stat.size && stat.size > CAD_VIEWER_BYTE_LIMIT) {
				this.showStatus(
					localize(
						'wfm.cad.viewer.tooLarge',
						"文件过大 ({0} MB > {1} MB)。请先用桌面 CAD 软件预审或拆图。",
						(stat.size / 1024 / 1024).toFixed(1),
						(CAD_VIEWER_BYTE_LIMIT / 1024 / 1024).toFixed(0),
					),
					/*isError*/ true,
				);
				return;
			}

			const content = await this.fileService.readFile(resource);
			if (token?.isCancellationRequested) {
				return;
			}

			this.hideStatus();

			const isDark = this.themeService.getColorTheme().type === ColorScheme.DARK
				|| this.themeService.getColorTheme().type === ColorScheme.HIGH_CONTRAST_DARK;

			const loadMessage: ICadLoadMessage = {
				kind: 'load',
				uri: resource.toString(),
				fileName,
				fileKind,
				isDark,
			};

			const buffer = (content.value.buffer as Uint8Array).slice().buffer;
			await this.webview.postMessage(
				{ ...loadMessage, bytes: buffer } as ICadLoadMessage & { bytes: ArrayBuffer },
				[buffer],
			);
			this.logService.trace(`${LOG_PREFIX} reload ok reason=${reason} bytes=${buffer.byteLength}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn(`${LOG_PREFIX} pushLoadFromDisk failed (${reason}): ${message}`);
			this.showStatus(
				localize(
					'wfm.cad.viewer.readFailed',
					"读取文件失败: {0}",
					message,
				),
				/*isError*/ true,
			);
		} finally {
			this.reloadInFlight = false;
		}
	}

	/**
	 * 监听磁盘上的当前 CAD 文件，外部改写时自动刷新画布。
	 *
	 *  - `IFileService.watch(resource)` 注册操作系统级 watcher；
	 *  - `onDidFilesChange` 是工作区级别的聚合事件，需要用 `affects()` 过滤；
	 *  - 200ms 去抖：保存动作经常触发多次（先 truncate 再写入）；
	 *  - `suppressWatchUntil` 抑制窗：viewer 自己 `editsApplied` 后会马上 writeFile，
	 *    1.5s 内不要把这次自写回环成 watch reload。
	 */
	private setupFileWatcher(resource: URI): void {
		const watcherStore = new DisposableStore();
		watcherStore.add(this.fileService.watch(resource));
		watcherStore.add(this.fileService.onDidFilesChange(e => {
			if (!e.affects(resource)) {
				return;
			}
			if (Date.now() < this.suppressWatchUntil) {
				this.logService.trace(`${LOG_PREFIX} fs change suppressed (self-write window)`);
				return;
			}
			if (this.reloadDebounceTimer) {
				clearTimeout(this.reloadDebounceTimer);
			}
			this.reloadDebounceTimer = setTimeout(() => {
				this.reloadDebounceTimer = undefined;
				void this.pushLoadFromDisk('watch');
			}, 200);
		}));
		this.fileWatcher.value = watcherStore;
	}

	private ensureWebview(): void {
		if (this.webview || !this.container) {
			return;
		}

		const nonce = generateUuid().replace(/-/g, '');
		const mediaUri = (file: string) => asWebviewUri(joinPath(MEDIA_ROOT, file)).toString(true);
		// mediaBaseUri 必须以 `/` 结尾——cad-simple-viewer 内部会做
		// `mediaBaseUri + 'fonts/'` 拼接成 fontLoader 的实际 baseUrl，结尾少斜杠
		// 会拼出错误路径（如 `.../mediafonts/`）。asWebviewUri 不一定保留尾部斜杠，
		// 这里强制补一下。
		const rawMediaBase = asWebviewUri(MEDIA_ROOT).toString(true);
		const mediaBaseUri = rawMediaBase.endsWith('/') ? rawMediaBase : `${rawMediaBase}/`;
		const html = buildViewerHtml({
			nonce,
			cspSource: 'https://*.vscode-cdn.net',
			viewerJsUri: mediaUri('viewer.js'),
			viewerCssUri: mediaUri('viewer.css'),
			cadViewerBundleUri: mediaUri('cad-viewer.iife.js'),
			libredwgWasmUri: mediaUri('libredwg-web.wasm'),
			mediaBaseUri,
			workerUrls: {
				dxfParser: mediaUri('dxf-parser-worker.js'),
				dwgParser: mediaUri('libredwg-parser-worker.js'),
				mtextRender: mediaUri('mtext-renderer-worker.js'),
			},
		});

		this.webview = this.webviewListeners.add(this.webviewService.createWebviewElement({
			title: localize('wfm.cad.viewer.title', "WFM CAD 预览"),
			options: {
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [MEDIA_ROOT],
			},
			extension: undefined,
		}));

		// 让 webview 占满 pane。CadViewerEditor.layout() 会随父 dimension 一起调整大小。
		const host = dom.append(this.container, $('.wfm-cad-viewer-host'));
		host.style.width = '100%';
		host.style.height = '100%';
		host.style.position = 'absolute';
		host.style.inset = '0';
		this.container.style.position = 'relative';
		this.webview.mountTo(host, this.window);
		this.webview.setHtml(html);

		this.webviewListeners.add(this.webview.onMessage(evt => {
			this.handleWebviewMessage(evt.message as CadWebviewToMainMessage);
		}));
	}

	private handleWebviewMessage(msg: CadWebviewToMainMessage): void {
		if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') {
			return;
		}
		switch (msg.kind) {
			case 'ready':
				this.logService.trace(`${LOG_PREFIX} webview ready`);
				break;
			case 'error':
				this.logService.warn(`${LOG_PREFIX} webview error: ${msg.message}`);
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize(
						'wfm.cad.viewer.runtimeError',
						"CAD viewer 运行错误: {0}",
						msg.message,
					),
				});
				break;
			case 'reviewRequest':
				void this.dispatchReviewRequest(msg.dxfText, msg.sourceUri, msg.fileName, msg.userNote);
				break;
			case 'layerStats':
				this.logService.trace(
					`${LOG_PREFIX} layer stats: ${Object.keys(msg.counts).length} layers`,
				);
				break;
			case 'missingData':
				this.handleMissingData(msg.missingFontNames, msg.missingImageCount);
				break;
			case 'debug':
				this.logService.info(
					`${LOG_PREFIX} debug[${msg.stage}] ${JSON.stringify(msg.info)}`,
				);
				break;
			case 'sendSelection':
				this.handleSendSelection(msg.entities, msg.sourceUri, msg.fileName);
				break;
			case 'editsApplied':
				this.handleEditsApplied(msg.dxfText, msg.sourceUri);
				break;
			case 'reloadRequest':
				// 工具栏「重载视图」按钮：销毁并重建 webview。重的，但只在用户
				// 明确点的时候做，正常使用没有自动监测，所以不会误触。
				void this.rescueReloadWebview();
				break;
		}
	}

	/**
	 * 上报"渲染不完整"的弹窗。
	 *
	 * 字体方案 v0.2 之后：
	 *  - WFM Studio vendor 了 mlightcad 完整字体集（含 SHX + woff/ttf），加上
	 *    `fonts.json` 里给设计院/天正常见自定义字体（swissl / hzdx / hzfs ...）
	 *    配的 alias，绝大多数 dwg 已经能完整渲染。
	 *  - 这里上来的 `missingFontNames` 是 cad-simple-viewer eventBus 真正
	 *    `fonts-not-found` / `fonts-not-loaded` 的字体——也就是 fonts.json 里没
	 *    定义、也没 alias 的"漏网之鱼"。这种文本会用 viewer 内置 fallback（一般
	 *    是 simhei）显示，不至于完全消失，但视觉可能略有偏差。
	 *  - 文案明确指引用户怎么补字体，详见 docs/USAGE_CAD_VIEWER.md §5.4。
	 */
	private handleMissingData(missingFontNames: readonly string[], missingImageCount: number): void {
		if (missingFontNames.length === 0 && missingImageCount === 0) {
			return;
		}
		const parts: string[] = [];
		if (missingFontNames.length > 0) {
			const preview = missingFontNames.slice(0, 5).join(', ');
			const suffix = missingFontNames.length > 5
				? `... (共 ${missingFontNames.length} 个)` : '';
			parts.push(localize(
				'wfm.cad.viewer.missingFonts',
				"未识别字体 {0}{1}（已用内置 fallback 渲染，视觉可能略有偏差。可在 media/fonts/fonts.json 里加 alias 永久解决）",
				preview, suffix,
			));
		}
		if (missingImageCount > 0) {
			parts.push(localize(
				'wfm.cad.viewer.missingImages',
				"{0} 张外部位图未加载（IMAGE/外部参照）",
				missingImageCount,
			));
		}
		this.notificationService.notify({
			severity: Severity.Warning,
			message: parts.join('；'),
			// sticky: 让用户能完整看到清单，确保不会一闪而过。
			sticky: true,
		});
	}

	private async dispatchReviewRequest(
		dxfText: string,
		sourceUri: string,
		fileName: string,
		userNote: string | undefined,
	): Promise<void> {
		if (!dxfText || !dxfText.trim()) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize(
					'wfm.cad.viewer.reviewEmpty',
					"viewer 还没生成可审图的 DXF 文本，请等模型加载完毕后再试。",
				),
			});
			return;
		}

		const note = (userNote ?? '').trim();
		const message = note
			? localize(
				'wfm.cad.viewer.reviewMessageWithNote',
				"请审一下当前 CAD 图（{0}），重点关注：{1}",
				fileName,
				note,
			)
			: localize(
				'wfm.cad.viewer.reviewMessageDefault',
				"请审一下当前 CAD 图（{0}），用通用方法逐项检查。",
				fileName,
			);

		try {
			await this.viewsService.openView(ChatViewId, true);
			const widget = this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)[0]
				?? this.chatWidgetService.lastFocusedWidget;
			if (!widget) {
				throw new Error('chat widget unavailable');
			}
			widget.focusInput();
			widget.attachmentModel.addFile(URI.parse(sourceUri));
			widget.setInput(message);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize(
					'wfm.cad.viewer.reviewSubmitFailed',
					"提交 AI 审图失败: {0}",
					detail,
				),
			});
		}
	}

	private showStatus(message: string, isError: boolean): void {
		if (!this.statusEl || !this.container) {
			return;
		}
		this.statusEl.hidden = false;
		this.statusEl.textContent = message;
		this.statusEl.classList.toggle('is-error', isError);
	}

	private hideStatus(): void {
		if (!this.statusEl) {
			return;
		}
		this.statusEl.hidden = true;
	}

	override clearInput(): void {
		this.currentResourceUri = undefined;
		this.currentFileName = undefined;
		this.currentResource = undefined;
		this.currentFileKind = undefined;
		this.fileWatcher.clear();
		if (this.reloadDebounceTimer) {
			clearTimeout(this.reloadDebounceTimer);
			this.reloadDebounceTimer = undefined;
		}
		// 不销毁 webview：retainContextWhenHidden=true，下次 setInput 直接 reuse。
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}

	override focus(): void {
		this.webview?.focus();
	}

	override dispose(): void {
		if (this.reloadDebounceTimer) {
			clearTimeout(this.reloadDebounceTimer);
			this.reloadDebounceTimer = undefined;
		}
		this.webview = undefined;
		super.dispose();
	}

	private async handleSendSelection(
		entities: ReadonlyArray<{ handle: string; entityType: string; textContent?: string; layer: string; colorIndex?: number }>,
		sourceUri: string,
		fileName: string,
	): Promise<void> {
		if (!entities || entities.length === 0) {
			return;
		}
		await this.viewsService.openView(ChatViewId, true);
		const widget = this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)[0]
			?? this.chatWidgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}
		widget.focusInput();

		const fileUri = URI.parse(sourceUri);
		const isDxf = /\.dxf$/i.test(fileName);

		// 仅 DXF 是文本文件，能扫出每个 handle 在原文中的行范围。DWG 是二进制，
		// 行号无意义，退回到"只附文件 + 单条提示"。
		let ranges: Map<string, { start: number; end: number }> | undefined;
		if (isDxf) {
			try {
				const content = await this.fileService.readFile(fileUri);
				const dxfText = content.value.toString();
				const wantedHandles = new Set(entities.map(e => e.handle.toUpperCase()).filter(h => h.length > 0));
				ranges = findDxfEntityRanges(dxfText, wantedHandles);
			} catch (err) {
				this.logService.warn(`${LOG_PREFIX} read dxf for ranges failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// 准备 chip：≤ 10 个实体一条 chip 一条；> 10 个合并为一个 bounding range chip，避免输入区被刷屏。
		const MAX_PER_CHIP = 10;
		const matched = entities
			.map(e => ({ entity: e, range: ranges?.get(e.handle.toUpperCase()) }))
			.filter(it => !!it.range) as Array<{ entity: typeof entities[number]; range: { start: number; end: number } }>;

		if (matched.length === 0) {
			// 无法定位行号：单纯附文件，让用户继续写自然语言要求即可。
			widget.attachmentModel.addFile(fileUri);
			this.notificationService.notify({
				severity: Severity.Info,
				message: localize(
					'wfm.cad.viewer.noRange',
					"已附加文件 {0}。当前 {1} 是二进制或无法解析 handle 行号，未生成行级引用。",
					fileName, isDxf ? '选区' : '文件',
				),
			});
			return;
		}

		if (matched.length <= MAX_PER_CHIP) {
			for (const m of matched) {
				widget.attachmentModel.addFile(fileUri, {
					startLineNumber: m.range.start,
					startColumn: 1,
					endLineNumber: m.range.end,
					endColumn: 1,
				});
			}
		} else {
			// 合并：min..max 包络。
			const startLine = matched.reduce((a, b) => Math.min(a, b.range.start), Number.POSITIVE_INFINITY);
			const endLine = matched.reduce((a, b) => Math.max(a, b.range.end), 0);
			widget.attachmentModel.addFile(fileUri, {
				startLineNumber: startLine,
				startColumn: 1,
				endLineNumber: endLine,
				endColumn: 1,
			});
		}
	}

	private async handleEditsApplied(dxfText: string, sourceUri: string): Promise<void> {
		if (!dxfText || !sourceUri) {
			return;
		}
		try {
			const uri = URI.parse(sourceUri);
			// 关掉自写引发的 watch reload：viewer 内的删除/改色已经在画布上生效，
			// 没必要再把磁盘版本回灌一次（会丢失后续的 in-memory 选区状态）。
			this.suppressWatchUntil = Date.now() + 1500;
			await this.fileService.writeFile(uri, VSBuffer.fromString(dxfText));
			this.logService.info(`${LOG_PREFIX} saved modified DXF: ${sourceUri}`);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize(
					'wfm.cad.viewer.saveFailed',
					"保存修改失败: {0}",
					detail,
				),
			});
		}
	}

	// 让上面 themeService listener 能引用 currentFileName / dimension 不被 tsc 报 unused。
	getFileName(): string | undefined {
		return this.currentFileName;
	}
	getCurrentDimension(): Dimension | undefined {
		return this.dimension;
	}
}
