/*---------------------------------------------------------------------------------------------
 *  WFM Studio PPTX viewer — Webview script.
 *
 *  在 webview iframe 内运行。使用 @aiden0z/pptx-renderer 渲染 PPTX，渲染后注入
 *  `data-wfm-slide-index` / `data-wfm-shape-index` / `data-wfm-shape-name`
 *  / `data-wfm-run-index` 等属性，使用户文本选区和右键能解析到具体的 slide/shape/run。
 *--------------------------------------------------------------------------------------------*/
(function () {
	'use strict';

	var vscodeApi = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
	var container = document.getElementById('wfm-pptx-container');
	var errorEl = document.getElementById('wfm-pptx-error');
	var filenameEl = document.getElementById('wfm-pptx-filename');
	var statusEl = document.getElementById('wfm-pptx-status');
	var loadingEl = document.getElementById('wfm-pptx-loading');
	var toolbar = document.getElementById('wfm-selection-toolbar');
	var sendBtn = document.getElementById('wfm-send-selection');
	var ctxMenu = document.getElementById('wfm-pptx-ctx-menu');
	var refreshBtn = document.getElementById('wfm-pptx-refresh');

	if (refreshBtn) {
		refreshBtn.addEventListener('click', function () { postMain({ kind: 'reloadRequest' }); });
	}

	var RENDER_TIMEOUT_MS = 120000;
	var renderTimer = null;

	/** 当前活跃的 viewer 实例（用于切换文档时 destroy 旧的） */
	var currentViewer = null;
	/** 当前 PPTX 的 serialized model，按 slideIndex 缓存 nodes（含递归 children） */
	var serializedSlides = [];
	/** EMU → pt 转换比；OOXML 内部单位是 EMU (1 pt = 12700 EMU)，但 aiden0z 模型里 position/size 已经是 pt（96 DPI 下经常作为 px 直出）；做一次 logical→DOM bbox 对齐 */

	function postMain(msg) {
		if (vscodeApi) { vscodeApi.postMessage(msg); }
		else { window.parent.postMessage(msg, '*'); }
	}

	function showError(text) {
		if (errorEl) { errorEl.textContent = text; errorEl.style.display = 'block'; }
		if (loadingEl) { loadingEl.style.display = 'none'; }
		if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
	}

	function setStatus(text) {
		if (statusEl) { statusEl.textContent = text || ''; }
	}

	// ── 数据模型对齐：DOM bbox ↔ model node ────────────────────

	/**
	 * 把 model 的 (position.x, position.y, size.w, size.h) 转换成"相对 slide 容器"的归一化矩形。
	 * pptx-renderer 把 EMU 转 px 后内联到 style.left/top/width/height，但还有一层
	 * viewer scale。这里用相对 slide root 的 offsetLeft/offsetTop/offsetWidth/offsetHeight
	 * 来匹配，能容忍 scale 变化。
	 */
	function getRelRect(el, slideRoot) {
		var x = 0, y = 0, w = el.offsetWidth, h = el.offsetHeight;
		var n = el;
		while (n && n !== slideRoot) {
			x += n.offsetLeft;
			y += n.offsetTop;
			n = n.offsetParent;
		}
		return { x: x, y: y, w: w, h: h };
	}

	/**
	 * 从 model 的 EMU 坐标（注意 aiden0z 已转 px，pos/size 单位是 EMU→px 的 px）反向
	 * 匹配回 DOM 元素。简化策略：用归一化中心点对比，最接近的 model node 即可。
	 */
	function findBestNodeMatch(domRect, candidateNodes, scale) {
		if (!candidateNodes || candidateNodes.length === 0) return -1;
		var domCx = domRect.x + domRect.w / 2;
		var domCy = domRect.y + domRect.h / 2;
		var bestIdx = -1;
		var bestDist = Infinity;
		for (var i = 0; i < candidateNodes.length; i++) {
			var n = candidateNodes[i];
			if (!n.position || !n.size) continue;
			// aiden0z 模型 position/size 在 EMU 单位，渲染时按 (96/72)/9525 等系数转 px。
			// 这里不强求绝对值匹配，只匹配中心点的相对接近度。
			var nCx = (n.position.x + n.size.w / 2) * scale;
			var nCy = (n.position.y + n.size.h / 2) * scale;
			var d = Math.hypot(domCx - nCx, domCy - nCy);
			if (d < bestDist) {
				bestDist = d;
				bestIdx = i;
			}
		}
		// 距离阈值：> max(w, h) 视为没匹配上（避免给完全无关的形状打错标签）
		var threshold = Math.max(domRect.w, domRect.h);
		return bestDist < threshold ? bestIdx : -1;
	}

	/**
	 * 注入 data-wfm-* 属性。在 onSlideRendered 回调里逐 slide 处理。
	 *
	 * 策略：递归遍历 slideEl 的子元素，把所有"看起来是形状"（绝对定位 + 有边界）的元素
	 * 当成候选；用 bbox 中心匹配回 model 的 nodes。group 节点递归进入。
	 *
	 * 注：master/layout 的 shape 也会渲染到 slideEl 内，但它们不在 model.slides[i].nodes 里。
	 * bbox 匹配如果距离太远会被 threshold 滤掉，那些 shape 不会拿到 data-wfm-shape-index，
	 * 用户选中也会被识别为"slide 级"。
	 */
	function tagSlide(slideIndex, slideEl) {
		if (!slideEl) return;
		slideEl.setAttribute('data-wfm-slide-index', String(slideIndex));

		var model = serializedSlides[slideIndex];
		if (!model || !model.nodes) return;

		// 计算 px-per-EMU 比例：从已渲染 slide 的总尺寸 vs serialized presentation 的尺寸
		// （pres.width/height 单位是 EMU；slideEl.offsetWidth 单位是 px）
		var pres = currentViewer && currentViewer.presentationData ? currentViewer.presentationData : null;
		var scale = 1;
		if (pres && pres.width && slideEl.offsetWidth) {
			scale = slideEl.offsetWidth / pres.width;
		}

		// 直接收集所有可能是 shape 的 DOM 元素（绝对定位、有尺寸）
		// 限定第一/二层深度避免误抓到子文本元素
		var candidates = [];
		(function walk(parent, depth) {
			if (depth > 3) return;
			for (var i = 0; i < parent.children.length; i++) {
				var c = parent.children[i];
				if (!(c instanceof HTMLElement)) continue;
				var cs = window.getComputedStyle(c);
				if (cs.position === 'absolute' && c.offsetWidth > 0 && c.offsetHeight > 0) {
					candidates.push(c);
				}
				// 递归进 group（也是 absolute div）
				walk(c, depth + 1);
			}
		})(slideEl, 0);

		// 对 model.nodes 做扁平化（递归展开 group children），按文档顺序
		var flatNodes = [];
		(function flatten(nodes) {
			for (var i = 0; i < nodes.length; i++) {
				flatNodes.push(nodes[i]);
				if (nodes[i].children && nodes[i].children.length) {
					flatten(nodes[i].children);
				}
			}
		})(model.nodes);

		// 给每个候选 DOM 找最近的 model node
		var usedNodeIndices = Object.create(null);
		for (var k = 0; k < candidates.length; k++) {
			var el = candidates[k];
			var rect = getRelRect(el, slideEl);
			var nodeIdx = findBestNodeMatch(rect, flatNodes, scale);
			if (nodeIdx < 0 || usedNodeIndices[nodeIdx]) continue;
			usedNodeIndices[nodeIdx] = true;
			var node = flatNodes[nodeIdx];
			el.setAttribute('data-wfm-shape-index', String(nodeIdx));
			el.setAttribute('data-wfm-shape-id', node.id || '');
			el.setAttribute('data-wfm-shape-name', node.name || ('Shape ' + (nodeIdx + 1)));
			if (node.nodeType) {
				el.setAttribute('data-wfm-shape-type', node.nodeType);
			}

			// 给文本 run 注入 data-wfm-run-index：按文档顺序数 <span>
			if (node.textBody && node.textBody.paragraphs && node.textBody.paragraphs.length) {
				var runEls = el.querySelectorAll('span');
				// pptx-renderer 用 <span> 包 run，但也可能有非 run 的 span（比如 list marker）
				// 简化：按出现顺序顺次编号。少数偏差不影响主流程，agent 会拿到 selectedText 兜底。
				for (var r = 0; r < runEls.length; r++) {
					runEls[r].setAttribute('data-wfm-run-index', String(r));
				}
			}
		}
	}

	// ── Selection resolution ────────────────────────────────────

	function findClosestAttr(node, attr) {
		var el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
		while (el) {
			if (el.hasAttribute && el.hasAttribute(attr)) {
				return el;
			}
			el = el.parentElement;
		}
		return null;
	}

	/**
	 * 解析选区到 {slideIndex, shapeIndex, shapeName, runStart, runEnd, selectedText}。
	 * 如果只是单击形状（无文本选区），返回 runStart=runEnd=-1。
	 * 如果连一个 shape 都找不到，返回 null。
	 */
	function resolveSelection(triggerEl) {
		var sel = window.getSelection();
		var hasTextSel = sel && !sel.isCollapsed && sel.toString().trim().length > 0;

		var anchorEl = null, focusEl = null;
		if (hasTextSel) {
			anchorEl = sel.anchorNode;
			focusEl = sel.focusNode;
		} else if (triggerEl) {
			anchorEl = triggerEl;
			focusEl = triggerEl;
		}

		if (!anchorEl) return null;

		var shapeA = findClosestAttr(anchorEl, 'data-wfm-shape-index');
		var shapeB = findClosestAttr(focusEl || anchorEl, 'data-wfm-shape-index');
		var shape = shapeA || shapeB;
		if (!shape) {
			// 选中的内容不在我们能识别的 shape 上——回退到 slide 级
			var slideEl = findClosestAttr(anchorEl, 'data-wfm-slide-index');
			if (!slideEl) return null;
			return {
				slideIndex: parseInt(slideEl.getAttribute('data-wfm-slide-index'), 10),
				shapeIndex: -1,
				shapeName: '',
				runStart: -1,
				runEnd: -1,
				selectedText: hasTextSel ? sel.toString() : '',
			};
		}
		var slideEl2 = findClosestAttr(shape, 'data-wfm-slide-index');
		if (!slideEl2) return null;

		var slideIndex = parseInt(slideEl2.getAttribute('data-wfm-slide-index'), 10);
		var shapeIndex = parseInt(shape.getAttribute('data-wfm-shape-index'), 10);
		var shapeName = shape.getAttribute('data-wfm-shape-name') || '';

		var runStart = -1, runEnd = -1;
		if (hasTextSel) {
			var runA = findClosestAttr(sel.anchorNode, 'data-wfm-run-index');
			var runB = findClosestAttr(sel.focusNode, 'data-wfm-run-index');
			if (runA && runB) {
				var ra = parseInt(runA.getAttribute('data-wfm-run-index'), 10);
				var rb = parseInt(runB.getAttribute('data-wfm-run-index'), 10);
				runStart = Math.min(ra, rb);
				runEnd = Math.max(ra, rb);
			}
		}

		return {
			slideIndex: slideIndex,
			shapeIndex: shapeIndex,
			shapeName: shapeName,
			runStart: runStart,
			runEnd: runEnd,
			selectedText: hasTextSel ? sel.toString() : '',
		};
	}

	// ── Floating toolbar ────────────────────────────────────────

	function showToolbar() {
		var sel = window.getSelection();
		if (!sel || sel.isCollapsed || !toolbar) { hideToolbar(); return; }

		var data = resolveSelection(null);
		if (!data) { hideToolbar(); return; }

		try {
			var range = sel.getRangeAt(0);
			var rect = range.getBoundingClientRect();
			var scrollX = window.scrollX || window.pageXOffset;
			var scrollY = window.scrollY || window.pageYOffset;

			var top = rect.top + scrollY - 40;
			var left = rect.left + scrollX + rect.width / 2;

			top = Math.max(scrollY + 4, top);
			left = Math.max(60, Math.min(left, window.innerWidth + scrollX - 60));

			toolbar.style.top = top + 'px';
			toolbar.style.left = left + 'px';
			toolbar.classList.add('visible');
		} catch (e) {
			hideToolbar();
		}
	}

	function hideToolbar() {
		if (toolbar) toolbar.classList.remove('visible');
	}

	var selectionTimer = null;
	document.addEventListener('mouseup', function () {
		clearTimeout(selectionTimer);
		selectionTimer = setTimeout(showToolbar, 80);
	});

	document.addEventListener('mousedown', function (e) {
		if (toolbar && !toolbar.contains(e.target)) hideToolbar();
	});

	function sendCurrentSelection(triggerEl) {
		var data = resolveSelection(triggerEl);
		if (data) {
			postMain({
				kind: 'selectionToChat',
				slideIndex: data.slideIndex,
				shapeIndex: data.shapeIndex,
				shapeName: data.shapeName,
				runStart: data.runStart,
				runEnd: data.runEnd,
				selectedText: data.selectedText,
			});
		}
		hideToolbar();
		hideContextMenu();
		var sel = window.getSelection();
		if (sel) sel.removeAllRanges();
	}

	if (sendBtn) {
		sendBtn.addEventListener('click', function (e) {
			e.preventDefault(); e.stopPropagation();
			sendCurrentSelection(null);
		});
	}

	// ── Right-click context menu ────────────────────────────────

	/** 上下文菜单关联到当前右键点击的目标 DOM（用于无文本选区时识别 shape） */
	var ctxTargetEl = null;

	function buildCtxTargetLabel(data) {
		if (!data) return '';
		var slideLabel = '第 ' + (data.slideIndex + 1) + ' 页';
		if (data.shapeIndex < 0) return slideLabel;
		var shapeLabel = data.shapeName || ('形状 ' + (data.shapeIndex + 1));
		var runLabel = '';
		if (data.runStart >= 0 && data.selectedText) {
			var preview = data.selectedText.length > 24 ? data.selectedText.slice(0, 22) + '…' : data.selectedText;
			runLabel = ' · "' + preview + '"';
		}
		return slideLabel + ' · ' + shapeLabel + runLabel;
	}

	function showContextMenu(x, y, target) {
		if (!ctxMenu) return;
		ctxTargetEl = target;
		var data = resolveSelection(target);
		if (!data) return;

		// 渲染目标提示行（"第 3 页 · Title 1 · '项目汇报'"）
		var oldTarget = ctxMenu.querySelector('.wfm-pptx-ctx-target');
		if (oldTarget) oldTarget.remove();
		var targetEl = document.createElement('div');
		targetEl.className = 'wfm-pptx-ctx-target';
		targetEl.textContent = buildCtxTargetLabel(data);
		ctxMenu.insertBefore(targetEl, ctxMenu.firstChild);

		ctxMenu.hidden = false;
		var vw = window.innerWidth;
		var vh = window.innerHeight;
		var rect = ctxMenu.getBoundingClientRect();
		ctxMenu.style.left = Math.min(x, vw - rect.width - 4) + 'px';
		ctxMenu.style.top = Math.min(y, vh - rect.height - 4) + 'px';
	}

	function hideContextMenu() {
		if (ctxMenu) ctxMenu.hidden = true;
		ctxTargetEl = null;
	}

	document.addEventListener('contextmenu', function (e) {
		// 找鼠标位置下方最近的 wfm 元素：text 选区时优先用选区，否则用 elementFromPoint
		var triggerEl = e.target;
		var hasShape = findClosestAttr(triggerEl, 'data-wfm-shape-index');
		var hasSlide = findClosestAttr(triggerEl, 'data-wfm-slide-index');
		if (!hasShape && !hasSlide) {
			// 不在我们识别的渲染区域内，放行系统默认菜单
			return;
		}
		e.preventDefault();
		showContextMenu(e.clientX, e.clientY, triggerEl);
		hideToolbar();
	});

	document.addEventListener('mousedown', function (e) {
		if (ctxMenu && !ctxMenu.hidden && !ctxMenu.contains(e.target)) {
			hideContextMenu();
		}
	}, true);

	document.addEventListener('scroll', function () { hideContextMenu(); }, true);
	window.addEventListener('blur', function () { hideContextMenu(); });

	if (ctxMenu) {
		ctxMenu.addEventListener('click', function (e) {
			var target = e.target;
			var item = target && target.closest ? target.closest('.wfm-pptx-ctx-item') : null;
			if (!item) return;
			var action = item.getAttribute('data-action');
			if (action === 'send-selection') {
				sendCurrentSelection(ctxTargetEl);
			}
		});
	}

	// ── Renderer lifecycle ──────────────────────────────────────

	function destroyCurrent() {
		if (currentViewer) {
			try { currentViewer.destroy && currentViewer.destroy(); } catch (e) { /* ignore */ }
			currentViewer = null;
		}
		serializedSlides = [];
		if (container) container.innerHTML = '';
	}

	function rendererReady() {
		return !!(window.__wfmPptx && window.__wfmPptx.PptxViewer);
	}

	function waitForRenderer() {
		return new Promise(function (resolve, reject) {
			if (rendererReady()) { resolve(); return; }
			var timer = setTimeout(function () {
				reject(new Error('PPT 渲染库未在 30s 内加载完成（可能是 module import 失败 / CSP 拦截）'));
			}, 30000);
			window.addEventListener('wfm-pptx-renderer-ready', function once() {
				window.removeEventListener('wfm-pptx-renderer-ready', once);
				clearTimeout(timer);
				resolve();
			});
		});
	}

	function setLoadingText(text) {
		if (loadingEl) {
			loadingEl.textContent = text;
			loadingEl.style.display = 'block';
		}
	}

	/**
	 * 让出主线程一帧，避免 UI 文字更新被同步任务吞掉。
	 * (parseZip / buildPresentation 内部有同步重型循环，必须给浏览器机会渲染状态文字)
	 */
	function yieldFrame() {
		return new Promise(function (r) {
			requestAnimationFrame(function () { setTimeout(r, 0); });
		});
	}

	/**
	 * 防重入：标记当前是否有 loadPptx 正在跑。EditorPane 在 tab 切换 / 重新激活时
	 * 可能多次发 `load` 消息，串行调用会让两个 viewer 实例同时往 container 里写，
	 * 导致状态混乱、container 被清空但旧的 renderList 还在 await。
	 */
	var loadInFlight = false;
	/** 记录最近一次 load 的字节签名（size 拼 fingerprint），相同字节直接跳过避免重渲。 */
	var lastLoadKey = null;

	async function loadPptx(arrayBuffer) {
		var key = arrayBuffer.byteLength + ':' + (currentViewer ? '1' : '0');
		if (loadInFlight) {
			console.log('[wfm-pptx] loadPptx called while in-flight, ignored');
			return;
		}
		// 同样字节 + 已有 viewer 跑过：用户大概率是 tab 切换触发的二次 load，直接复用。
		if (lastLoadKey === key && currentViewer && container.querySelector('[data-wfm-slide-index]')) {
			console.log('[wfm-pptx] same bytes already rendered, skipping reload');
			return;
		}
		loadInFlight = true;
		lastLoadKey = key;

		await waitForRenderer();
		destroyCurrent();

		setLoadingText('正在准备 PPT 渲染器…');
		if (errorEl) errorEl.style.display = 'none';

		// 总超时：5 分钟（解析 + 渲染合在一起算）
		var TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
		renderTimer = setTimeout(function () {
			showError('总超时（5 分钟），PPT 太复杂或库卡死了。请尝试用 omni-viewer 打开。');
		}, TOTAL_TIMEOUT_MS);

		var Pptx = window.__wfmPptx;
		var bytes = (arrayBuffer instanceof ArrayBuffer) ? arrayBuffer : arrayBuffer.buffer;
		var sizeMb = (bytes.byteLength / 1024 / 1024).toFixed(1);

		try {
			// ── 阶段 1：解压 PPTX（zip 解开） ─────────────────────
			setLoadingText('阶段 1/3：正在解压 PPTX (' + sizeMb + ' MB)…');
			setStatus('解压中');
			await yieldFrame();
			var t0 = performance.now();
			var pptxFiles = await Pptx.parseZip(bytes);
			var t1 = performance.now();
			console.log('[wfm-pptx] parseZip', ((t1 - t0) / 1000).toFixed(2) + 's');

			// ── 阶段 2：解析 OOXML 模型 ───────────────────────────
			setLoadingText('阶段 2/3：正在解析 PPTX 结构（理论上几秒）…');
			setStatus('解析中');
			await yieldFrame();
			var presentation = Pptx.buildPresentation(pptxFiles);
			var t2 = performance.now();
			console.log('[wfm-pptx] buildPresentation', ((t2 - t1) / 1000).toFixed(2) + 's');
			var totalSlides = (presentation && presentation.slides ? presentation.slides.length : 0);
			setLoadingText('已解析 ' + totalSlides + ' 页幻灯片，开始渲染…');
			setStatus('解析完成');
			await yieldFrame();

			// 提前序列化模型，给 tagSlide 用
			try {
				var ser0 = Pptx.serializePresentation(presentation);
				serializedSlides = ser0.slides || [];
			} catch (e) {
				console.warn('[wfm-pptx] serializePresentation failed (will retry after render):', e);
				serializedSlides = [];
			}

			// ── 阶段 3：渲染 ─────────────────────────────────────
			setLoadingText('阶段 3/3：正在渲染 (0/' + totalSlides + ' 页)…');
			var renderedCount = 0;

			var ViewerCls = Pptx.PptxViewer;
			currentViewer = new ViewerCls(container, {
				fitMode: 'contain',
				zoomPercent: 100,
				onSlideRendered: function (index, el) {
					try {
						tagSlide(index, el);
					} catch (e) {
						postMain({ kind: 'error', message: '标注 slide ' + (index + 1) + ' 失败: ' + (e && e.message ? e.message : e) });
					}
					renderedCount++;
					setLoadingText('阶段 3/3：正在渲染 (' + renderedCount + '/' + totalSlides + ' 页)…');
					setStatus('已渲染 ' + renderedCount + '/' + totalSlides);
				},
				onSlideError: function (index, err) {
					postMain({ kind: 'error', message: 'slide ' + (index + 1) + ' 渲染失败: ' + (err && err.message ? err.message : err) });
				},
				onNodeError: function (nodeId, err) {
					console.warn('[wfm-pptx] node ' + nodeId + ' failed:', err);
				},
				onRenderStart: function () { console.log('[wfm-pptx] renderStart'); },
				onRenderComplete: function () { console.log('[wfm-pptx] renderComplete'); },
			});
			currentViewer.load(presentation);
			// 关键：用 windowed: false 一次性渲染所有页。
			// 原因：windowed=true 依赖 IntersectionObserver 监听滚动；webview 被切到
			// 后台 hidden 时，所有 entry 报告 intersectionRatio=0，library 可能进入
			// 坏状态（renderList 内部 await 永远不解决），再切回来不会自动恢复。
			// 一次渲完代价是首次稍慢 + 内存高一些，但对正常 PPT (10-100 页) 完全可接受，
			// 且消除了"切回 tab 不刷新"这类难调的 bug。
			await currentViewer.renderList({
				windowed: false,
				showSlideLabels: true,
				batchSize: 6,
			});

			var t3 = performance.now();
			console.log('[wfm-pptx] renderList (initial)', ((t3 - t2) / 1000).toFixed(2) + 's');

			// renderList 解析后，windowed 模式下可能只渲染了 initialSlides 个；后续靠滚动触发。
			// 重新刷一遍已渲染 slide 的标注（兜底，处理 serializedSlides 之前为空的情况）
			if (serializedSlides.length === 0 && currentViewer.presentationData) {
				try {
					var ser = Pptx.serializePresentation(currentViewer.presentationData);
					serializedSlides = ser.slides || [];
				} catch (e) {/* ignore */}
			}
			var rendered = container.querySelectorAll('[data-wfm-slide-index]');
			rendered.forEach(function (el) {
				if (!el.querySelector('[data-wfm-shape-index]')) {
					var idx = parseInt(el.getAttribute('data-wfm-slide-index'), 10);
					if (!isNaN(idx)) tagSlide(idx, el);
				}
			});

			postMain({ kind: 'rendered', slideCount: totalSlides });
			if (loadingEl) loadingEl.style.display = 'none';
			setStatus('已渲染 ' + renderedCount + ' / ' + totalSlides + ' 页');
			if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
		} catch (err) {
			if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
			var emsg = err && err.message ? err.message : String(err);
			var estack = err && err.stack ? '\n' + err.stack.split('\n').slice(0, 3).join('\n') : '';
			postMain({ kind: 'error', message: 'PPT 渲染失败: ' + emsg });
			showError('PPT 渲染失败: ' + emsg + estack);
			console.error('[wfm-pptx] loadPptx failed', err);
			lastLoadKey = null;  // 失败后重置，让重试 / 重新打开能再次进入流程
		} finally {
			loadInFlight = false;
		}
	}

	// ── Message handling ────────────────────────────────────────

	window.addEventListener('message', function (event) {
		var msg = event.data || {};
		if (typeof msg !== 'object' || typeof msg.kind !== 'string') return;

		switch (msg.kind) {
			case 'load':
				if (filenameEl) filenameEl.textContent = msg.fileName || '';
				if (msg.isDark) document.body.classList.add('is-dark');
				else document.body.classList.remove('is-dark');

				var data = msg.bytes;
				if (!data || !data.byteLength) { showError('文档内容为空'); return; }
				loadPptx(data);
				break;
			case 'theme':
				if (msg.isDark) document.body.classList.add('is-dark');
				else document.body.classList.remove('is-dark');
				break;
		}
	});

	postMain({ kind: 'ready' });
})();
