/*---------------------------------------------------------------------------------------------
 *  WFM Studio CAD viewer — webview 内启动脚本。
 *
 *  与 main 端 (cadViewerEditor.ts) 通过 postMessage 通信：
 *    main → webview:  { kind: 'load',  uri, fileName, fileKind, isDark, bytes }
 *                     { kind: 'theme', isDark }
 *    webview → main:  { kind: 'ready' }
 *                     { kind: 'error', message }
 *                     { kind: 'reviewRequest', dxfText, sourceUri, fileName, userNote }
 *                     { kind: 'layerStats', counts }
 *
 *  实际渲染走 vendor 的 cad-viewer 引擎（@mlightcad/cad-simple-viewer +
 *  @mlightcad/libredwg-web）。这些依赖体积大且依赖 ESM 运行时，必须先经
 *  打包为 IIFE 后放进 media/cad-viewer.iife.js 才能被 webview 加载。
 *  详见同目录 VENDOR.md 与 scripts/build-cad-viewer.mjs。
 *--------------------------------------------------------------------------------------------*/
/* eslint-env browser */
/* global acquireVsCodeApi */
/* eslint-disable @typescript-eslint/no-this-alias */

(function () {
	'use strict';

	const LOG_PREFIX = '[wfm-cad-viewer]';
	const vscode = acquireVsCodeApi();

	// 全局错误捕获——cad-simple-viewer 内部经常把 promise reject 吞掉，再加上
	// worker 抛出的异常，main thread 默认收不到，这里强制全部打到 console
	// 让 main 端的 webview console listener 看到。
	window.addEventListener('error', (evt) => {
		console.error(LOG_PREFIX, 'window.error', evt.message, evt.error || evt.filename);
	});
	window.addEventListener('unhandledrejection', (evt) => {
		const r = evt.reason;
		console.error(
			LOG_PREFIX,
			'unhandledrejection',
			r && r.message ? r.message : String(r),
			r && r.stack ? r.stack : '(no stack)',
		);
	});

	const $$ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
	const filenameEl = $$('wfm-cad-filename');
	const statusEl = $$('wfm-cad-status');
	const canvasHost = $$('wfm-cad-canvas-host');
	const layerPanel = $$('wfm-cad-layer-panel');
	const errorEl = $$('wfm-cad-error');
	const tipEl = $$('wfm-cad-tip');
	const reviewBtn = /** @type {HTMLButtonElement} */ ($$('wfm-cad-review'));
	const zoomFitBtn = /** @type {HTMLButtonElement} */ ($$('wfm-cad-zoom-fit'));
	const layersBtn = /** @type {HTMLButtonElement} */ ($$('wfm-cad-toggle-layers'));
	const modeBtn = /** @type {HTMLButtonElement} */ ($$('wfm-cad-toggle-mode'));

	/** @type {{ fileName: string; sourceUri: string; dxfText: string | undefined } | undefined} */
	let currentDoc;
	/** @type {any} */
	let docManager; // cad-simple-viewer 的 AcApDocManager 实例
	let viewerReady = false;
	/** 当前的 view mode：'select' / 'pan'。注意这是 UI 状态，cad-simple-viewer
	 *  内部用 `AcEdViewMode.SELECTION` / `AcEdViewMode.PAN`，我们通过 view.mode = ... 切换。 */
	let currentViewMode = 'select';

		// ── 实体选中 / 删除 ──────────────────────────────────────────────
		const MAX_SEL_ENTITIES = 200;
		/** handle(uppercase) → entity 的查找 Map，每次 loadDocument 重建。 */
		let entityLookup = new Map();
		/** 当前选中的实体信息列表（仅包含 entityLookup 命中的）。 */
		let lastSelectionEntities = [];
		const selBadgeEl = $$('wfm-cad-sel-badge');
		const ctxMenuEl = $$('wfm-cad-ctx-menu');
	/** 由 cad-simple-viewer eventBus 'fonts-not-found' / 'fonts-not-loaded' 收集的、
	 *  fontLoader 真正尝试加载但失败的字体名集合（小写 + 已 strip 扩展名）。
	 *  比扫 textStyleTable 更精准 —— 那种方式会把已经 alias 到 simhei 的字体也错算
	 *  成"缺失"。 */
	const failedFontNames = new Set();
	let fontEventListenerInstalled = false;

	function setStatus(text, isError) {
		if (!statusEl) {
			return;
		}
		if (!text) {
			statusEl.hidden = true;
			statusEl.textContent = '';
			statusEl.classList.remove('is-error');
			return;
		}
		statusEl.hidden = false;
		statusEl.textContent = text;
		statusEl.classList.toggle('is-error', !!isError);
	}

	function showFatalError(message, hint) {
		if (!errorEl) {
			return;
		}
		errorEl.hidden = false;
		errorEl.textContent = '';
		const title = document.createElement('div');
		title.style.fontWeight = '600';
		title.textContent = message;
		errorEl.appendChild(title);
		if (hint) {
			const sub = document.createElement('div');
			sub.style.marginTop = '8px';
			sub.style.opacity = '0.85';
			sub.textContent = hint;
			errorEl.appendChild(sub);
		}
		setStatus('', false);
		vscode.postMessage({ kind: 'error', message });
	}

	function setBusy(isBusy) {
		if (reviewBtn) {
			reviewBtn.disabled = isBusy || !currentDoc?.dxfText;
		}
		if (zoomFitBtn) {
			zoomFitBtn.disabled = isBusy || !viewerReady;
		}
		if (layersBtn) {
			layersBtn.disabled = isBusy || !viewerReady;
		}
		if (modeBtn) {
			modeBtn.disabled = isBusy || !viewerReady;
		}
	}

	function applyTheme(isDark) {
		document.body.classList.toggle('is-light', !isDark);
	}

	/**
	 * 等到 vendor 的 cad-viewer IIFE bundle 把全局对象挂上后再继续。
	 * IIFE 我们约定挂在 window.WfmCadBootstrap = { AcApDocManager, ... }（由
	 * scripts/build-cad-viewer.mjs 产出）。
	 *
	 * @returns {Promise<{ AcApDocManager: any }>}
	 */
	function waitForBootstrap(timeoutMs = 8000) {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			(function poll() {
				const w = /** @type {any} */ (window);
				if (w.WfmCadBootstrap && w.WfmCadBootstrap.AcApDocManager) {
					resolve(w.WfmCadBootstrap);
					return;
				}
				if (Date.now() - start > timeoutMs) {
					reject(new Error('WfmCadBootstrap 未就绪'));
					return;
				}
				setTimeout(poll, 50);
			})();
		});
	}

	/**
	 * 带重试 + 单次超时的 fetch。webview 资源服务（`vscode-cdn.net`）偶尔会
	 * 返回纯文本 "Request Timeout"，更糟的情况是 service worker 卡住导致 fetch
	 * **永远不返回**——此前 fetchWithRetry 没有单次超时，整个 viewer 初始化会
	 * 永久停在"正在初始化 CAD 渲染引擎…"。这里用 AbortController 给每次 attempt
	 * 加 perAttemptTimeoutMs 的硬超时，超时按一次失败处理、走重试间隔，最终
	 * 保证总耗时有上限。
	 *
	 * @param {string} url
	 * @param {number} maxAttempts
	 * @param {'json' | 'text' | 'binary'} expectKind
	 * @param {number} perAttemptTimeoutMs
	 */
	async function fetchWithRetry(url, maxAttempts = 5, expectKind = 'text', perAttemptTimeoutMs = 8000) {
		let lastErr;
		for (let i = 0; i < maxAttempts; i++) {
			const ctl = new AbortController();
			const timer = setTimeout(() => ctl.abort(), perAttemptTimeoutMs);
			try {
				const resp = await fetch(url, { cache: 'no-cache', signal: ctl.signal });
				if (!resp.ok) { throw new Error(`HTTP ${resp.status}`); }
				if (expectKind === 'json') {
					const txt = await resp.text();
					// 服务有时返 200 + body="Request Timeout"。先看是不是合法 JSON。
					if (!txt.trim().startsWith('{') && !txt.trim().startsWith('[')) {
						throw new Error(`non-JSON body: ${txt.slice(0, 80)}`);
					}
					return txt;
				}
				if (expectKind === 'text') {
					return await resp.text();
				}
				return await resp.arrayBuffer();
			} catch (err) {
				lastErr = err;
				const aborted = ctl.signal.aborted;
				const wait = 200 * (i + 1);
				console.warn(
					LOG_PREFIX,
					`fetch retry ${i + 1}/${maxAttempts}${aborted ? ' (timed out)' : ''}`,
					url,
					err,
				);
				await new Promise((r) => setTimeout(r, wait));
			} finally {
				clearTimeout(timer);
			}
		}
		throw lastErr;
	}

	/**
	 * 主线程预取 fonts.json。后面会:
	 *  1) 注入到 worker 源码前缀，绕过 worker 跨域 fetch vscode-cdn.net 的偶发超时
	 *  2) 主线程通过 hack `_loader._avaiableFonts` 灌进 `AcApFontLoader`
	 *
	 * @param {string} mediaBase - mediaBase URI（必须以 `/` 结尾）
	 * @returns {Promise<string>} fonts.json 文本
	 */
	async function prefetchFontsJson(mediaBase) {
		const url = `${mediaBase}fonts/fonts.json`;
		const txt = await fetchWithRetry(url, 6, 'json');
		reportDebug('fonts-json-prefetch', { url, bytes: txt.length });
		return txt;
	}

	/**
	 * Webview 的 origin 是 `vscode-webview://...`，而 vendor worker 文件经
	 * `asWebviewUri()` 解析出来是 `https://*.vscode-cdn.net/...` —— 这是跨 origin，
	 * 浏览器会拒绝直接 `new Worker(httpsUrl)`。解决方案：把每个 worker 文件 fetch
	 * 下来再用 `URL.createObjectURL(new Blob([...]))` 包成 same-origin 的 `blob:` URL，
	 * 那样 worker 就能正常构造。CSP 中 `worker-src` 已允许 `blob:`。
	 *
	 * 同时在 worker 源码前缀注入 fonts.json 缓存 + fetch 拦截器，避免 worker 内
	 * `mtext-renderer` 自己 `fetch(baseUrl + 'fonts.json')` 跨域到 vscode-cdn 间歇
	 * 性"Request Timeout"。
	 *
	 * @param {Record<string, string>} urlMap
	 * @param {string} fontsJson - 预取好的 fonts.json 文本（可空）
	 * @returns {Promise<Record<string, string>>}
	 */
	async function rewriteWorkersToBlob(urlMap, fontsJson) {
		const out = {};
		const names = Object.keys(urlMap);
		// 用 JSON.stringify 把 fontsJson 字符串安全地嵌进 worker 源码（避免反引号 / 转义陷阱）
		const fontsLiteral = fontsJson ? JSON.stringify(fontsJson) : 'null';
		const fetchShim = `\n;(function(){\n  var __WFM_FONTS = ${fontsLiteral};\n  if (!__WFM_FONTS) { return; }\n  var __origFetch = self.fetch;\n  self.fetch = function(input, init){\n    try {\n      var u = typeof input === 'string' ? input : (input && input.url) || '';\n      if (u && /\\/fonts\\.json(\\?|$)/.test(u)) {\n        return Promise.resolve(new Response(__WFM_FONTS, { status: 200, headers: { 'Content-Type': 'application/json' } }));\n      }\n    } catch (_) {}\n    return __origFetch.call(self, input, init);\n  };\n})();\n`;
		await Promise.all(names.map(async (name) => {
			const httpsUrl = urlMap[name];
			if (!httpsUrl) {
				return;
			}
			try {
				const code = await fetchWithRetry(httpsUrl, 4, 'text');
				const finalCode = name === 'mtextRender' && fontsJson ? fetchShim + code : code;
				out[name] = URL.createObjectURL(new Blob([finalCode], { type: 'text/javascript' }));
			} catch (err) {
				console.warn(LOG_PREFIX, 'failed to rewrite worker', name, err);
				out[name] = httpsUrl;
			}
		}));
		return out;
	}

	/**
	 * 给 promise 加一个总兜底超时。任意一个 fetch / wasm 编译 / vendor 内部
	 * await 卡死都会被这里 reject 出来，避免 viewer 永远停在某个状态。
	 *
	 * @template T
	 * @param {Promise<T>} promise
	 * @param {number} timeoutMs
	 * @param {string} label
	 * @returns {Promise<T>}
	 */
	function withTimeout(promise, timeoutMs, label) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`${label} 超时 (${timeoutMs}ms)`));
			}, timeoutMs);
			promise.then(
				(v) => { clearTimeout(timer); resolve(v); },
				(e) => { clearTimeout(timer); reject(e); },
			);
		});
	}

	async function ensureViewer(initialIsDark) {
		if (viewerReady && docManager) {
			return docManager;
		}
		setStatus('正在初始化 CAD 渲染引擎…', false);
		applyTheme(initialIsDark);

		// 总兜底：所有内部 await（vendor bundle 准备就绪、prefetch fonts.json、
		// rewriteWorkersToBlob 各 worker 拉取）加起来正常 ≤ 几秒，最坏 ≤ 30s。
		// 超过 60s 基本可以判定是 webview 资源服务被 service worker 卡死，让用户
		// 看到清晰错误信息而不是无限转圈。
		return withTimeout(doEnsureViewer(initialIsDark), 60_000, 'CAD 引擎初始化');
	}

	async function doEnsureViewer(initialIsDark) {
		void initialIsDark;
		try {
			const bootstrap = await waitForBootstrap();
			// 提前装 fonts-not-found / fonts-not-loaded 监听器：createInstance
			// 内部会异步调 loadDefaultFonts，如果 fonts.json 里少 entry 也得能抓到。
			installFontEventListeners();
			const cfg = /** @type {any} */ (window).__WFM_CAD__ || {};
			// 主线程预取 fonts.json（带重试），同时给 worker 注入 fetch shim。
			// 失败也 fallback 到原行为，不阻断 viewer 初始化。
			let fontsJsonText;
			try {
				fontsJsonText = await prefetchFontsJson(cfg.mediaBase || '');
			} catch (err) {
				console.warn(LOG_PREFIX, 'prefetch fonts.json failed; worker will fetch directly', err);
				reportDebug('fonts-json-prefetch-failed', { err: String(err) });
			}
			const workerBlobUrls = cfg.workerUrls
				? await rewriteWorkersToBlob(cfg.workerUrls, fontsJsonText)
				: undefined;
			docManager = bootstrap.AcApDocManager.createInstance({
				container: canvasHost,
				autoResize: true,
				// cad-simple-viewer 内部会做 `baseUrl + 'fonts/'` 当 fontLoader 的实际
				// base，所以这里传 mediaBase（必须以 / 结尾），它就会去 fetch
				// `${mediaBase}fonts/fonts.json`、`${mediaBase}fonts/<file>.shx` 等。
				// fonts/ 下我们已经 vendor 了 mlightcad 完整字体集（含 SHX 二进制 +
				// woff/ttf），离线 100% 可用，dwg 里大部分文本能直接用原字体渲染。
				baseUrl: cfg.mediaBase,
				webworkerFileUrls: workerBlobUrls
					? {
						dxfParser: workerBlobUrls.dxfParser,
						dwgParser: workerBlobUrls.dwgParser,
						mtextRender: workerBlobUrls.mtextRender,
					}
					: undefined,
				// notLoadDefaultFonts 留默认（false）：让 fontLoader 主动加载默认字体
				// （romans / simhei / arial 等），mtext-renderer 才能正常工作。
			});

			// **预灌字体清单**：把预取到的 fonts.json 直接喂给主线程 fontLoader 的
			// 私有 `_avaiableFonts` 字段，并触发一次 `buildFontMap`，让后续
			// `getAvailableFonts()` 直接返回缓存而不再 `fetch(baseUrl + fonts.json)`，
			// 彻底避开 vscode-cdn 偶发"Request Timeout"。
			// fontLoader 路径：AcApDocManager._fontLoader._loader（mtext-renderer FontLoader）
			if (fontsJsonText) {
				try {
					const fontInfos = JSON.parse(fontsJsonText);
					const dm = /** @type {any} */ (docManager);
					const innerLoader = dm?._fontLoader?._loader;
					if (innerLoader && Array.isArray(fontInfos)) {
						const baseUrl = innerLoader._baseUrl || (cfg.mediaBase + 'fonts/');
						fontInfos.forEach((it) => { it.url = baseUrl + it.file; });
						innerLoader._avaiableFonts = fontInfos;
						innerLoader.buildFontMap?.();
						reportDebug('fonts-json-injected', { count: fontInfos.length });
					}
				} catch (err) {
					console.warn(LOG_PREFIX, 'inject fonts.json into main fontLoader failed', err);
					reportDebug('fonts-json-inject-failed', { err: String(err) });
				}
			}

			// 手动覆盖式 register 一遍 DXF / DWG converter。
			// 历史背景：cad-simple-viewer 1.5 的 dist 把 @mlightcad/libredwg-converter
			// 标为 external 风格的 dependency，dist 内部 try/catch 创建 converter
			// 时若类不可用就静默吞掉。我们自己 import + 显式注册一次以彻底兜住。
			if (workerBlobUrls && bootstrap.AcDbDatabaseConverterManager) {
				try {
					const mgr = bootstrap.AcDbDatabaseConverterManager.instance;
					mgr.register(
						bootstrap.AcDbFileType.DXF,
						new bootstrap.AcDbDxfConverter({
							convertByEntityType: false,
							useWorker: true,
							parserWorkerUrl: workerBlobUrls.dxfParser,
						}),
					);
					mgr.register(
						bootstrap.AcDbFileType.DWG,
						new bootstrap.AcDbLibreDwgConverter({
							convertByEntityType: false,
							useWorker: true,
							parserWorkerUrl: workerBlobUrls.dwgParser,
						}),
					);
				} catch (regErr) {
					console.error(LOG_PREFIX, '手动注册 converter 失败', regErr);
				}
			}
			viewerReady = true;
			configureCanvasInteractions();
			setStatus('', false);
			maybeShowFirstRunTip();
			vscode.postMessage({ kind: 'ready' });
			return docManager;
		} catch (err) {
			console.error(LOG_PREFIX, 'bootstrap failed', err);
			const msg = err && err.message ? err.message : String(err);
			if (msg.includes('WfmCadBootstrap 未就绪')) {
				showFatalError(
					'CAD 渲染引擎未就绪',
					'缺少 vendor 的 cad-viewer.iife.js。请在 wfm-ide 目录运行: '
						+ '`npm install --save-dev @mlightcad/cad-simple-viewer ... esbuild` 然后 '
						+ '`node scripts/build-cad-viewer.mjs`，重启 IDE 后再试。',
				);
			} else {
				// 走到这条分支基本是网络 / service worker 卡死，或 wasm 编译失败。
				showFatalError(
					`CAD 渲染引擎初始化失败: ${msg}`,
					'若提示"超时"，多半是 vscode-cdn 资源服务被 service worker 卡了。'
						+ '建议：① 关闭并重新打开此 CAD 文件；② 仍失败时，命令面板执行'
						+ '"Developer: Reload Window"刷新 webview。',
				);
			}
			throw err;
		}
	}

	/**
	 * cad-simple-viewer 默认的 OrbitControls 只把 pan 绑到鼠标中键上，普通笔记本
	 * trackpad 用户没有真正的中键，会以为画布"无法拖动"。这里在初始化完成后
	 * 把右键也绑成 pan，并屏蔽 webview 的右键菜单，让"右键拖动 = 平移"成立。
	 *
	 * 同时把 OrbitControls 的 rotate 彻底禁掉（虽然 cad-simple-viewer 已设过
	 * enableRotate=false，但有些异常路径下我们的覆盖会更稳）。
	 */
	let interactionsConfigured = false;
	function configureCanvasInteractions() {
		// 这个函数会被调两次：一次在 ensureViewer（webview 初始化），一次在 loadDocument
		// 末尾（layout 真正切换完后）。后者才是 _cameraControls 一定可达的时机，但
		// 我们做成 idempotent：mouseButtons 等无害多写一次，而 contextmenu 监听用
		// flag 避免重复绑定。
		const view = docManager?.curView;
		const layoutView = view?.activeLayoutView;
		const controls = layoutView?._cameraControls;
		if (controls) {
			const THREE = /** @type {any} */ (window).WfmCadBootstrap?.THREE;
			// THREE.MOUSE.PAN === 2、ROTATE === 0、DOLLY === 1（OrbitControls 历史值）。
			// 走数字 fallback 这样即使上游忘了导出 THREE 也不会炸。
			const PAN = THREE?.MOUSE?.PAN ?? 2;
			controls.mouseButtons = {
				LEFT: undefined,
				MIDDLE: PAN,
				RIGHT: PAN,
			};
			controls.enableRotate = false;
			controls.zoomSpeed = Math.max(controls.zoomSpeed || 1, 2.5);
			controls.update();
		}

		if (!interactionsConfigured) {
			interactionsConfigured = true;
			const canvas = canvasHost?.querySelector?.('canvas');
			if (canvas) {
				canvas.addEventListener('contextmenu', (e) => e.preventDefault());
			}
			canvasHost?.addEventListener('contextmenu', (e) => e.preventDefault());
		}
	}

	function getViewModeEnum(name) {
		const w = /** @type {any} */ (window);
		const enumObj = w.WfmCadBootstrap?.AcEdViewMode;
		if (!enumObj) {
			return undefined;
		}
		return name === 'pan' ? enumObj.PAN : enumObj.SELECTION;
	}

	function setViewMode(mode) {
		const view = docManager?.curView;
		const layoutView = view?.activeLayoutView;
		if (!layoutView) {
			return;
		}
		const target = getViewModeEnum(mode);
		if (target == null) {
			console.warn(LOG_PREFIX, 'AcEdViewMode 未导出，无法切换模式');
			return;
		}
		try {
			layoutView.mode = target;
			currentViewMode = mode;
			document.body.classList.toggle('wfm-cad-pan-mode', mode === 'pan');
			if (modeBtn) {
				const span = modeBtn.querySelector('[data-mode-text]');
				if (span) {
					span.textContent = mode === 'pan' ? '平移模式' : '选择模式';
				}
				modeBtn.classList.toggle('is-active', mode === 'pan');
			}
		} catch (err) {
			console.warn(LOG_PREFIX, 'switch view mode failed', err);
		}
	}

	function maybeShowFirstRunTip() {
		try {
			const state = vscode.getState() || {};
			if (state.tipDismissed) {
				return;
			}
		} catch {
			// ignore
		}
		if (!tipEl) {
			return;
		}
		tipEl.hidden = false;
		const dismiss = () => {
			tipEl.hidden = true;
			try {
				vscode.setState({ tipDismissed: true });
			} catch {
				// ignore
			}
		};
		tipEl.addEventListener('click', dismiss);
		// 6 秒后自动消失，不强制要求用户点
		setTimeout(() => { if (!tipEl.hidden) { dismiss(); } }, 6000);
	}

	/**
	 * 监听 cad-simple-viewer 的字体加载失败事件。fontLoader 在 fontMap 里查不到
	 * 字体名时会触发 'fonts-not-found'；加载到一半 IO 失败会触发 'fonts-not-loaded'。
	 * 这里把字体名累积到 `failedFontNames`，等 reportMissingData 一次性上报。
	 *
	 * 注意：如果字体名已经被 fonts.json 里的 alias 命中（如 swissl→arial.woff、
	 * hzdx→simhei.woff），fontLoader 会查到对应 entry 并加载成功，不会触发这俩
	 * 事件——也就**不会**误报"缺失"。这是切到 alias 方案后比扫 textStyleTable 更
	 * 精准的关键原因。
	 */
	function installFontEventListeners() {
		if (fontEventListenerInstalled) {
			return;
		}
		const w = /** @type {any} */ (window);
		const eventBus = w.WfmCadBootstrap?.eventBus;
		if (!eventBus || typeof eventBus.on !== 'function') {
			console.warn(LOG_PREFIX, 'eventBus 不可达，无法监听字体加载事件');
			return;
		}
		eventBus.on('fonts-not-found', (evt) => {
			const fonts = evt && Array.isArray(evt.fonts) ? evt.fonts : [];
			for (const f of fonts) {
				if (typeof f === 'string' && f) { failedFontNames.add(f.toLowerCase()); }
			}
		});
		eventBus.on('fonts-not-loaded', (evt) => {
			const fonts = evt && Array.isArray(evt.fonts) ? evt.fonts : [];
			for (const item of fonts) {
				const name = item && (item.fontName || item.name);
				if (typeof name === 'string' && name) { failedFontNames.add(name.toLowerCase()); }
			}
		});
		fontEventListenerInstalled = true;
	}

	/**
	 * 上报"渲染不完整"的细节给 main：
	 *  - 字体：取自 `failedFontNames`（fontLoader 真正加载失败时累积）。
	 *  - 外部位图：取自 `view.missedData.images`（IMAGE 实体引用的外部位图、xref）。
	 */

	/**
	 * 走 IPC 把诊断信息上报给 main，主进程会把它写进 logService.info。
	 * 用于无 DevTools 场景下排查"画布空白"。
	 * @param {string} stage - 阶段标签，便于过滤
	 * @param {Record<string, unknown>} info - 任意 JSON-safe 信息
	 */
	function reportDebug(stage, info) {
		try {
			vscode.postMessage({ kind: 'debug', stage, info });
		} catch {
			// ignore
		}
	}

	/**
	 * 自动「回到全图」：
	 *
	 * 上游 cad-simple-viewer 默认在 openDocument 完成时按 db.extmin/extmax 做 zoomTo。
	 * 但很多 dwg（设计院/天正出图）头里的 $EXTMIN/$EXTMAX 没在保存前 ZOOM E 更新，
	 * 会把首屏视口 zoom 到一片空白；而我们的兜底分支（openDocument 静默 false →
	 * 直接 database.read）甚至**完全不触发** zoom。
	 *
	 * 这里采用"等到 scene 真的有实体了再 fit + 多次重试"的策略：
	 *  1. 实体灌入场景是 async 的（worker → main），用 view.stats.summary.entityCount
	 *     判断是否到位
	 *  2. 最多重试 ~5 秒，每次间隔递增；每次重试都把 entityCount / scene bbox 上报，
	 *     便于 main 日志排错
	 *  3. 一旦实体数稳定（连续两次相同且 > 0），调用 zoomToFitDrawing 并停手
	 */
	function scheduleAutoFit() {
		const startedAt = Date.now();
		let lastEntityCount = -1;
		let stableHits = 0;
		let attempt = 0;
		const intervals = [50, 100, 200, 400, 600, 800, 1000, 1500];
		const tick = () => {
			attempt++;
			let entityCount = -1;
			let bbox;
			try {
				const view = docManager?.curView;
				const stats = view?.stats;
				entityCount = stats?.summary?.entityCount ?? -1;
				const box = view?.scene?.box;
				if (box && Number.isFinite(box.min?.x)) {
					bbox = {
						min: [box.min.x, box.min.y],
						max: [box.max.x, box.max.y],
						empty: box.isEmpty?.() ?? false,
					};
				}
			} catch (err) {
				reportDebug('auto-fit-probe-error', { err: String(err) });
			}

			if (entityCount > 0 && entityCount === lastEntityCount) {
				stableHits++;
			} else {
				stableHits = 0;
			}
			lastEntityCount = entityCount;

			const shouldFit = (entityCount > 0 && stableHits >= 1)
				|| attempt >= intervals.length;
			reportDebug('auto-fit', {
				attempt,
				entityCount,
				stableHits,
				bbox,
				elapsedMs: Date.now() - startedAt,
				willFit: shouldFit,
			});

			if (shouldFit) {
				try {
					docManager?.curView?.zoomToFitDrawing?.();
					reportDebug('auto-fit-done', { attempt, entityCount });
				} catch (err) {
					reportDebug('auto-fit-error', { err: String(err) });
				}
				return;
			}
			setTimeout(tick, intervals[attempt - 1] || 1000);
		};
		setTimeout(tick, intervals[0]);
	}

	function reportMissingData() {
		try {
			const view = docManager?.curView;
			const data = view?.missedData;
			let imageCount = 0;
			const imagesObj = data?.images;
			if (imagesObj instanceof Map) {
				imageCount = imagesObj.size;
			} else if (imagesObj && typeof imagesObj === 'object') {
				imageCount = Object.keys(imagesObj).length;
			}

			const fontList = Array.from(failedFontNames);
			if (fontList.length === 0 && imageCount === 0) {
				return; // 全 OK 不打扰
			}
			vscode.postMessage({
				kind: 'missingData',
				missingFontNames: fontList,
				missingImageCount: imageCount,
			});
		} catch (err) {
			console.warn(LOG_PREFIX, 'reportMissingData failed', err);
		}
	}

	/** @param {ArrayBuffer | undefined} bytes */
	function asArrayBuffer(bytes) {
		if (bytes instanceof ArrayBuffer) {
			return bytes;
		}
		if (ArrayBuffer.isView(bytes)) {
			return bytes.buffer;
		}
		// postMessage 在某些 Electron 版本会把 transferable 还原成 Uint8Array
		// 字面量；这里兜底处理。
		if (bytes && typeof bytes === 'object' && Array.isArray(/** @type {any} */ (bytes).data)) {
			return new Uint8Array(/** @type {any} */ (bytes).data).buffer;
		}
		return undefined;
	}

	/**
	 * 把当前 docManager 里的 db 序列化成 DXF 文本。
	 * cad-simple-viewer 没有直接的 "to DXF text" 出口，所以我们走两步：
	 *   1) 如果用户原本就传的是 .dxf，直接复用原文本（main 端也会附带）
	 *   2) 否则尝试调用 docManager 暴露的 `serializeAsDxf()` /
	 *      `database.serializeAsDxfText()`（v1.5+ 已计划）。当前 vendor bundle
	 *      若未实现，落回提示用户。
	 *
	 * 这里的设计预期 vendor 的 build entry 在 IIFE 里塞了 helper：
	 *   window.WfmCadBootstrap.serializeAsDxf(docManager) -> string
	 */
	function tryExportDxfText() {
		const w = /** @type {any} */ (window);
		const helper = w.WfmCadBootstrap && w.WfmCadBootstrap.serializeAsDxf;
		if (!helper || !docManager) {
			return undefined;
		}
		try {
			const out = helper(docManager);
			if (typeof out === 'string' && out.length > 0) {
				return out;
			}
		} catch (err) {
			console.warn(LOG_PREFIX, 'serializeAsDxf failed', err);
		}
		return undefined;
	}

	function refreshLayerPanel() {
		if (!docManager || !layerPanel) {
			return;
		}
		layerPanel.textContent = '';
		try {
			const doc = docManager.curDocument;
			const layers = doc?.database?.tables?.layerTable?.iter
				? Array.from(doc.database.tables.layerTable.iter())
				: [];
			const counts = {};
			for (const layer of layers) {
				const name = layer.name || '0';
				const row = document.createElement('div');
				row.className = 'wfm-cad-layer-row';

				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.checked = !(layer.isFrozen && layer.isFrozen());
				checkbox.addEventListener('change', () => {
					try {
						if (typeof layer.setIsFrozen === 'function') {
							layer.setIsFrozen(!checkbox.checked);
						}
					} catch (err) {
						console.warn(LOG_PREFIX, 'toggle layer failed', err);
					}
				});

				const label = document.createElement('label');
				label.textContent = name;

				const count = document.createElement('span');
				count.className = 'wfm-cad-layer-count';
				count.textContent = ''; // 实体计数留给 v0.3

				row.appendChild(checkbox);
				row.appendChild(label);
				row.appendChild(count);
				layerPanel.appendChild(row);

				counts[name] = 0;
			}
			vscode.postMessage({ kind: 'layerStats', counts });
		} catch (err) {
			console.warn(LOG_PREFIX, 'refreshLayerPanel failed', err);
		}
	}

	// ── 实体选中 ────────────────────────────────────────────────────────

	function buildEntityLookup() {
		entityLookup.clear();
		const db = docManager?.curDocument?.database;
		if (!db) return;
		try {
			const modelSpace = db.tables?.blockTable?.modelSpace;
			if (!modelSpace) return;
			const iter = modelSpace.newIterator();
			for (const entity of iter) {
				const handle = (entity.objectId || '').toUpperCase();
				if (handle) {
					entityLookup.set(handle, entity);
				}
			}
			reportDebug('entity-lookup', { count: entityLookup.size });
		} catch (err) {
			console.warn(LOG_PREFIX, 'buildEntityLookup failed', err);
		}
	}

	function extractEntityInfo(entity) {
		const info = {
			handle: entity.objectId || '',
			entityType: entity.dxfTypeName || 'UNKNOWN',
			layer: entity.layer || '0',
		};
		if (typeof entity.textString === 'string' && entity.textString) {
			info.textContent = entity.textString;
		}
		try {
			const c = entity.color;
			if (c && typeof c.colorIndex === 'number') {
				info.colorIndex = c.colorIndex;
			}
		} catch {}
		return info;
	}

	function handleSelectionChange() {
		const view = docManager?.curView;
		if (!view) return;
		const ids = view.selectionSet?.ids || [];
		const entities = [];
		for (const id of ids) {
			if (entities.length >= MAX_SEL_ENTITIES) break;
			const entity = entityLookup.get(id.toUpperCase());
			if (!entity) continue;
			entities.push(extractEntityInfo(entity));
		}
		lastSelectionEntities = entities;
		updateSelBadge();
	}

	function updateSelBadge() {
		if (!selBadgeEl) return;
		if (lastSelectionEntities.length > 0) {
			selBadgeEl.hidden = false;
			selBadgeEl.textContent = `已选中 ${lastSelectionEntities.length} 个实体（右键可操作）`;
		} else {
			selBadgeEl.hidden = true;
		}
	}

	let selectionListenersInstalled = false;
	function installSelectionListeners() {
		if (selectionListenersInstalled) return;
		const view = docManager?.curView;
		if (!view?.selectionSet?.events) return;
		try {
			view.selectionSet.events.selectionAdded.addEventListener(() => handleSelectionChange());
			view.selectionSet.events.selectionRemoved.addEventListener(() => handleSelectionChange());
			selectionListenersInstalled = true;
			reportDebug('selection-listeners-installed', {});
		} catch (err) {
			console.warn(LOG_PREFIX, 'installSelectionListeners failed', err);
		}
	}

	// ── 右键菜单 ────────────────────────────────────────────────────────

	function showContextMenu(x, y) {
		if (!ctxMenuEl || lastSelectionEntities.length === 0) return;
		const sendItem = ctxMenuEl.querySelector('[data-action="send-selection"]');
		if (sendItem) {
			sendItem.textContent = `发送选中到对话 (${lastSelectionEntities.length})`;
		}
		const delItem = ctxMenuEl.querySelector('[data-action="delete-selection"]');
		if (delItem) {
			delItem.textContent = `删除 (${lastSelectionEntities.length})`;
		}
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		ctxMenuEl.hidden = false;
		const rect = ctxMenuEl.getBoundingClientRect();
		ctxMenuEl.style.left = `${Math.min(x, vw - rect.width - 4)}px`;
		ctxMenuEl.style.top = `${Math.min(y, vh - rect.height - 4)}px`;
	}

	function hideContextMenu() {
		if (ctxMenuEl) ctxMenuEl.hidden = true;
	}

	// ── 删除实体 ────────────────────────────────────────────────────────

	function deleteSelectedEntities() {
		if (lastSelectionEntities.length === 0) return;
		let erased = 0;
		for (const info of lastSelectionEntities) {
			const entity = entityLookup.get(info.handle.toUpperCase());
			if (!entity) continue;
			try {
				entity.erase();
				entityLookup.delete(info.handle.toUpperCase());
				erased++;
			} catch (err) {
				console.warn(LOG_PREFIX, 'erase failed for handle', info.handle, err);
			}
		}

		lastSelectionEntities = [];
		updateSelBadge();
		hideContextMenu();

		if (erased > 0 && currentDoc) {
			const dxfText = tryExportDxfText();
			if (dxfText) {
				currentDoc.dxfText = dxfText;
				vscode.postMessage({
					kind: 'editsApplied',
					dxfText,
					sourceUri: currentDoc.sourceUri,
				});
			}
			reportDebug('entities-deleted', { erased });
		}
	}

	async function loadDocument(loadMessage) {
		const { fileName, fileKind, uri, bytes, isDark } = loadMessage;
		filenameEl.textContent = fileName;
		setBusy(true);
		setStatus('正在解析文件…', false);
		// 清空上一份图的字体缺失记录（webview 复用、依次打开多个 dwg 时关键）。
		failedFontNames.clear();

		const buffer = asArrayBuffer(bytes);
		if (!buffer) {
			showFatalError('Webview 收到的字节数据为空');
			setBusy(false);
			return;
		}

		try {
			const dm = await ensureViewer(!!isDark);
			const fileExt = (fileName.split('.').pop() || '').toLowerCase();

			// cad-simple-viewer 1.5 的 AcApDocument.openDocument 有概率（看起来跟
			// fontLoader 配合的某条 setOptions 分支相关）在 try/catch 里 silently
			// fail 返 false，但底层 AcDbDatabase.read() 事实上是成功的。
			// 这里采取防御性策略：先试 openDocument，如果它返 false 就直接绕到底
			// 层 _database.read() 重试一次。两条路径任一通过就当作打开成功。
			let openOk = false;
			let openSilentReason;
			try {
				openOk = await dm.openDocument(fileName, buffer, { minimumChunkSize: 1000 });
			} catch (err) {
				openSilentReason = err && err.message ? err.message : String(err);
			}
			if (!openOk) {
				try {
					const db = dm.curDocument && dm.curDocument.database;
					if (!db || typeof db.read !== 'function') {
						throw new Error('docManager.curDocument.database.read 不可用');
					}
					await db.read(
						buffer,
						{ readOnly: true, minimumChunkSize: 1000 },
						fileExt === 'dwg' ? 'dwg' : 'dxf',
					);
					console.warn(LOG_PREFIX, 'openDocument 返 false 但底层 read() 成功，使用底层路径继续。',
						'silentReason=', openSilentReason);
				} catch (probeErr) {
					console.error(LOG_PREFIX, 'database.read 也失败', probeErr);
					const probeMsg = probeErr && probeErr.message ? probeErr.message : String(probeErr);
					showFatalError(
						`CAD 引擎拒绝打开该文件: ${probeMsg}`,
						'若提示 worker / wasm 相关错误，请在 wfm-ide 重新跑 `node scripts/build-cad-viewer.mjs`。',
					);
					setBusy(false);
					return;
				}
			}

			// 缓存 DXF 文本（用于「AI 审图」按钮）。
			let dxfText;
			if (fileKind === 'dxf') {
				try {
					dxfText = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buffer));
				} catch (err) {
					console.warn(LOG_PREFIX, 'decode dxf bytes failed', err);
				}
			}
			if (!dxfText) {
				// DWG 路径或解码失败时，向 vendor helper 询问
				dxfText = tryExportDxfText();
			}

			currentDoc = { fileName, sourceUri: uri, dxfText };
			refreshLayerPanel();
			buildEntityLookup();
			// selectionListenersInstalled 只装一次；后续 load 会复用。
			installSelectionListeners();
			// 真正能拿到 activeLayoutView._cameraControls 的时机要等 layout 切换完毕。
			// 这里再 configure 一次，把 OrbitControls 的右键 pan 应用上。
			configureCanvasInteractions();
			setStatus('', false);
			scheduleAutoFit();
			// 渲染线程把 entities 灌进场景是 async 的，等 1 个 tick 再读 missedData
			// 才有完整的 fonts / images 缺失清单。1.5 秒留点余量。
			setTimeout(reportMissingData, 1500);
		} catch (err) {
			console.error(LOG_PREFIX, 'loadDocument failed', err);
			showFatalError(`解析文件失败: ${err && err.message ? err.message : err}`);
		} finally {
			setBusy(false);
		}
	}

	// --- 消息分发 -----------------------------------------------------------
	window.addEventListener('message', (evt) => {
		const msg = evt.data;
		if (!msg || typeof msg !== 'object') {
			return;
		}
		switch (msg.kind) {
			case 'load':
				void loadDocument(msg);
				break;
			case 'theme':
				applyTheme(!!msg.isDark);
				break;
		}
	});

	// --- 工具栏按钮 ---------------------------------------------------------
	if (zoomFitBtn) {
		zoomFitBtn.addEventListener('click', () => {
			try {
				docManager?.curView?.zoomToFitDrawing?.();
			} catch (err) {
				console.warn(LOG_PREFIX, 'zoomToFitDrawing failed', err);
			}
		});
	}

	if (modeBtn) {
		modeBtn.addEventListener('click', () => {
			setViewMode(currentViewMode === 'pan' ? 'select' : 'pan');
		});
	}

	if (layersBtn) {
		layersBtn.addEventListener('click', () => {
			if (!layerPanel) {
				return;
			}
			layerPanel.hidden = !layerPanel.hidden;
			if (!layerPanel.hidden) {
				refreshLayerPanel();
			}
		});
	}

	if (reviewBtn) {
		reviewBtn.addEventListener('click', () => {
			if (!currentDoc) {
				return;
			}
			const dxfText = currentDoc.dxfText || tryExportDxfText();
			if (!dxfText) {
				showFatalError(
					'当前文件还没有可审图的 DXF 文本。',
					'若打开的是 .dwg，请等 LibreDWG 完成解析；若仍失败，可先用桌面 CAD 软件导出 .dxf 后再载入。',
				);
				return;
			}
			vscode.postMessage({
				kind: 'reviewRequest',
				dxfText,
				sourceUri: currentDoc.sourceUri,
				fileName: currentDoc.fileName,
			});
		});
	}

	// 启动后立即声明状态——main 端收到 'ready' 才会判定 webview 真正活跃。
	setStatus('等待 CAD 引擎初始化…', false);
})();
