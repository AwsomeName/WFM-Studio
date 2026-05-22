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

	function postMain(msg) {
		if (vscodeApi) { vscodeApi.postMessage(msg); }
		else { window.parent.postMessage(msg, '*'); }
	}

	function showError(text) {
		if (errorEl) { errorEl.textContent = text; errorEl.style.display = 'block'; }
		if (loadingEl) { loadingEl.style.display = 'none'; }
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
	document.addEventListener('mouseup', function () {
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

	if (sendBtn) {
		sendBtn.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
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
			window.getSelection().removeAllRanges();
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
						if (loadingEl) { loadingEl.style.display = 'none'; }
						injectParagraphIndices();
					}).catch(function (err) {
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
