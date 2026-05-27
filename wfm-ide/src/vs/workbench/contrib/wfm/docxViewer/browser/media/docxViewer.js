/*---------------------------------------------------------------------------------------------
 *  WFM Studio DOCX viewer — Webview script.
 *
 *  Runs inside the webview iframe.  Uses docx-preview to render .docx files.
 *  P2: adds selection tracking + floating toolbar for "send to chat".
 *--------------------------------------------------------------------------------------------*/
(function () {
	'use strict';

	var vscodeApi = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
	var container = document.getElementById('wfm-docx-container');
	var errorEl = document.getElementById('wfm-docx-error');
	var filenameEl = document.getElementById('wfm-docx-filename');
	var loadingEl = document.getElementById('wfm-docx-loading');
	var toolbar = document.getElementById('wfm-selection-toolbar');
	var sendBtn = document.getElementById('wfm-send-selection');
	var ctxMenu = document.getElementById('wfm-docx-ctx-menu');
	var refreshBtn = document.getElementById('wfm-docx-refresh');

	if (refreshBtn) {
		refreshBtn.addEventListener('click', function () {
			postMain({ kind: 'reloadRequest' });
		});
	}

	var RENDER_TIMEOUT_MS = 60000;
	var renderTimer = null;

	function postMain(msg) {
		if (vscodeApi) { vscodeApi.postMessage(msg); }
		else { window.parent.postMessage(msg, '*'); }
	}

	function showError(text) {
		if (errorEl) { errorEl.textContent = text; errorEl.style.display = 'block'; }
		if (loadingEl) { loadingEl.style.display = 'none'; }
		if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
	}

	// ── Paragraph index injection ───────────────────────────────

	function injectParagraphIndices() {
		if (!container) { return; }
		var paraIndex = 0;
		var paragraphs = container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
		paragraphs.forEach(function (p) {
			p.setAttribute('data-para-index', String(paraIndex++));
		});
	}

	// ── Selection resolution ────────────────────────────────────

	function findParaIndex(node) {
		var el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
		while (el) {
			var idx = el.getAttribute('data-para-index');
			if (idx !== null) { return parseInt(idx, 10); }
			el = el.parentElement;
		}
		return null;
	}

	function resolveSelection() {
		var sel = window.getSelection();
		if (!sel || sel.isCollapsed) { return null; }

		var anchor = findParaIndex(sel.anchorNode);
		var focus = findParaIndex(sel.focusNode);
		if (anchor === null || focus === null) { return null; }

		var startPara = Math.min(anchor, focus);
		var endPara = Math.max(anchor, focus);

		return {
			startPara: startPara,
			endPara: endPara,
			selectedText: sel.toString()
		};
	}

	// ── Floating toolbar ────────────────────────────────────────

	function showToolbar() {
		var sel = window.getSelection();
		if (!sel || sel.isCollapsed || !toolbar) {
			hideToolbar();
			return;
		}

		var data = resolveSelection();
		if (!data) {
			hideToolbar();
			return;
		}

		try {
			var range = sel.getRangeAt(0);
			var rect = range.getBoundingClientRect();
			var scrollX = window.scrollX || window.pageXOffset;
			var scrollY = window.scrollY || window.pageYOffset;

			var top = rect.top + scrollY - 40;
			var left = rect.left + scrollX + rect.width / 2;

			// Clamp to viewport
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
		if (toolbar) {
			toolbar.classList.remove('visible');
		}
	}

	var selectionTimer = null;
	document.addEventListener('mouseup', function (e) {
		// Only show floating toolbar on left-button mouseup — right-button
		// should not trigger the toolbar (it would reappear 80 ms after
		// right-click and steal focus from the custom context menu).
		if (e.button !== 0) { return; }
		// Small delay to let the browser finalize selection
		clearTimeout(selectionTimer);
		selectionTimer = setTimeout(showToolbar, 80);
	});

	document.addEventListener('mousedown', function (e) {
		// Hide toolbar when clicking outside it
		if (toolbar && !toolbar.contains(e.target)) {
			hideToolbar();
		}
	});

	function sendCurrentSelection() {
		var data = resolveSelection();
		if (data) {
			postMain({
				kind: 'selectionToChat',
				startPara: data.startPara,
				endPara: data.endPara,
				selectedText: data.selectedText
			});
		}
		hideToolbar();
		hideContextMenu();
		var sel = window.getSelection();
		if (sel) { sel.removeAllRanges(); }
	}

	if (sendBtn) {
		sendBtn.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			sendCurrentSelection();
		});
	}

	// ── Right-click context menu ────────────────────────────────

	function showContextMenu(x, y) {
		if (!ctxMenu) { return; }
		var data = resolveSelection();
		if (!data) { return; }
		ctxMenu.hidden = false;
		// Record the moment the context menu was shown so the blur
		// handler can avoid closing it immediately (VS Code webviews
		// may fire a short blur on right-click).
		ctxMenuShowTime = Date.now();
		// Position with viewport clamping
		var vw = window.innerWidth;
		var vh = window.innerHeight;
		var rect = ctxMenu.getBoundingClientRect();
		ctxMenu.style.left = Math.min(x, vw - rect.width - 4) + 'px';
		ctxMenu.style.top = Math.min(y, vh - rect.height - 4) + 'px';
	}

	function hideContextMenu() {
		if (ctxMenu) { ctxMenu.hidden = true; }
	}

	var ctxMenuShowTime = 0;

	document.addEventListener('contextmenu', function (e) {
		// 只有当存在文字选区时才接管右键。无选区放行（保留浏览器/webview 默认行为）。
		var sel = window.getSelection();
		if (!sel || sel.isCollapsed) { return; }
		var data = resolveSelection();
		if (!data) { return; }
		e.preventDefault();
		// Cancel any pending toolbar show — without this the toolbar would
		// reappear 80 ms after right-click, overlapping the context menu.
		clearTimeout(selectionTimer);
		showContextMenu(e.clientX, e.clientY);
		hideToolbar();
	});

	document.addEventListener('mousedown', function (e) {
		if (ctxMenu && !ctxMenu.hidden && !ctxMenu.contains(e.target)) {
			hideContextMenu();
		}
	}, true);

	document.addEventListener('scroll', function () { hideContextMenu(); }, true);
	window.addEventListener('blur', function () {
		// In VS Code webviews a right-click can cause a momentary blur.
		// Guard: if the context menu was opened less than 300 ms ago,
		// ignore the blur so the menu stays visible.
		if (ctxMenuShowTime && (Date.now() - ctxMenuShowTime < 300)) { return; }
		hideContextMenu();
	});

	if (ctxMenu) {
		ctxMenu.addEventListener('click', function (e) {
			var target = e.target;
			var item = target && target.closest ? target.closest('.wfm-docx-ctx-item') : null;
			if (!item) { return; }
			var action = item.getAttribute('data-action');
			if (action === 'send-selection') {
				sendCurrentSelection();
			}
		});
	}

	// ── Message handling ────────────────────────────────────────

	window.addEventListener('message', function (event) {
		var msg = event.data || {};
		if (typeof msg !== 'object' || typeof msg.kind !== 'string') { return; }

		switch (msg.kind) {
			case 'load':
				if (filenameEl) { filenameEl.textContent = msg.fileName || ''; }
				if (msg.isDark) { document.body.classList.add('is-dark'); }
				else { document.body.classList.remove('is-dark'); }

				var data = msg.bytes;
				if (!data || !data.byteLength) {
					showError('文档内容为空');
					return;
				}

				if (typeof docx !== 'undefined' && typeof docx.renderAsync === 'function') {
					container.innerHTML = '';

					renderTimer = setTimeout(function () {
						showError('渲染超时，文档可能过于复杂。请尝试使用其他查看器打开。');
					}, RENDER_TIMEOUT_MS);

					docx.renderAsync(data, container, null, {
						className: 'docx-wrapper',
						inWrapper: true,
						ignoreWidth: false,
						ignoreHeight: false,
						ignoreFonts: false,
						breakPages: true,
						ignoreLastRenderedPageBreak: true,
						experimental: false,
					}).then(function () {
						if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
						if (loadingEl) { loadingEl.style.display = 'none'; }
						injectParagraphIndices();
						// 显式上报"渲染完成"——main 端 watchdog 等的就是这个，
						// 仅靠 `ready`（脚本加载即触发）区分不出"渲染卡死"。
						postMain({ kind: 'rendered' });
					}).catch(function (err) {
						postMain({ kind: 'error', message: '渲染失败: ' + (err && err.message ? err.message : err) });
						showError('渲染失败: ' + (err.message || err));
					});
				} else {
					showError('docx-preview 库加载失败');
				}
				break;

			case 'theme':
				if (msg.isDark) { document.body.classList.add('is-dark'); }
				else { document.body.classList.remove('is-dark'); }
				break;
		}
	});

	// Signal readiness to the host
	postMain({ kind: 'ready' });
})();
