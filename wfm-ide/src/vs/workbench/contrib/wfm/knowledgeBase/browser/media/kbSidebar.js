/*---------------------------------------------------------------------------------------------
 *  WFM Studio – Knowledge Base sidebar view (runs inside webview).
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable no-undef */

// @ts-check

const vscode = acquireVsCodeApi();

const DEFAULT_API_URL = 'https://api.dify.ai/v1';

// ── DOM helpers ──────────────────────────────────────────

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

// ── State ────────────────────────────────────────────────

/** @type {{apiUrl: string, apiKey: string, datasetId: string} | null} */
let savedConfig = null;

// ── Render ───────────────────────────────────────────────

function render(state) {
	const root = $('.kb-root');
	if (!root) { return; }

	if (state.type === 'config') {
		savedConfig = { apiUrl: state.apiUrl, apiKey: state.apiKey, datasetId: state.datasetId };
		renderConfigForm(root, state, /*saving*/ false);
		return;
	}

	if (state.type === 'loading') {
		root.innerHTML = `<div class="kb-loading"><span class="kb-spinner"></span>加载中...</div>`;
		return;
	}

	if (state.type === 'error') {
		// On error, fall back to config form so user can fix credentials.
		const cfg = savedConfig ?? { apiUrl: DEFAULT_API_URL, apiKey: '', datasetId: '' };
		renderConfigForm(root, { ...cfg, errorMessage: state.message }, /*saving*/ false);
		return;
	}

	if (state.type === 'documents') {
		renderDocList(root, state.docs);
		return;
	}

	if (state.type === 'segments') {
		renderSegments(root, state.docName, state.segments);
		return;
	}

	if (state.type === 'searchResults') {
		renderSearchResults(root, state.query, state.results);
		return;
	}
}

// ── Config form ──────────────────────────────────────────

function renderConfigForm(root, cfg, saving) {
	const apiUrl = cfg.apiUrl || DEFAULT_API_URL;
	const apiKey = cfg.apiKey || '';
	const datasetId = cfg.datasetId || '';
	const isFirstTime = !apiKey && !datasetId;
	const errorBanner = cfg.errorMessage
		? `<div class="kb-form-error">${escapeHtml(cfg.errorMessage)}</div>`
		: '';
	const cancelBtn = isFirstTime
		? ''
		: `<button id="kb-cancel" class="kb-btn-ghost" type="button">取消</button>`;

	root.innerHTML = `
		<div class="kb-form">
			<div class="kb-form-title">${isFirstTime ? '配置远程知识库' : '编辑知识库配置'}</div>
			<div class="kb-form-hint">连接 Dify 知识库，浏览文档与片段。</div>
			${errorBanner}
			<label class="kb-field">
				<span>API 基础地址</span>
				<input id="kb-apiUrl" type="text" autocomplete="off" spellcheck="false" value="${escapeAttr(apiUrl)}" />
			</label>
			<label class="kb-field">
				<span>API Key</span>
				<input id="kb-apiKey" type="password" autocomplete="off" spellcheck="false" value="${escapeAttr(apiKey)}" placeholder="dataset-xxxxxxxx" />
			</label>
			<label class="kb-field">
				<span>Dataset ID</span>
				<input id="kb-datasetId" type="text" autocomplete="off" spellcheck="false" value="${escapeAttr(datasetId)}" placeholder="知识库 / Dataset 的 UUID" />
			</label>
			<div class="kb-form-actions">
				<button id="kb-save" class="kb-btn-primary" type="button" ${saving ? 'disabled' : ''}>${saving ? '保存中…' : '保存并连接'}</button>
				${cancelBtn}
			</div>
			<div class="kb-form-foot">
				<a id="kb-open-settings">在设置面板编辑</a>
			</div>
		</div>`;

	$('#kb-apiUrl')?.focus();

	$('#kb-save')?.addEventListener('click', () => {
		const apiUrlVal = /** @type {HTMLInputElement} */ ($('#kb-apiUrl'))?.value.trim() || DEFAULT_API_URL;
		const apiKeyVal = /** @type {HTMLInputElement} */ ($('#kb-apiKey'))?.value.trim() || '';
		const datasetIdVal = /** @type {HTMLInputElement} */ ($('#kb-datasetId'))?.value.trim() || '';
		if (!apiKeyVal || !datasetIdVal) {
			renderConfigForm(root, {
				apiUrl: apiUrlVal,
				apiKey: apiKeyVal,
				datasetId: datasetIdVal,
				errorMessage: '请填写 API Key 与 Dataset ID。',
			}, /*saving*/ false);
			return;
		}
		// Re-render in saving state
		renderConfigForm(root, { apiUrl: apiUrlVal, apiKey: apiKeyVal, datasetId: datasetIdVal }, /*saving*/ true);
		post({ type: 'saveConfig', apiUrl: apiUrlVal, apiKey: apiKeyVal, datasetId: datasetIdVal });
	});

	$('#kb-cancel')?.addEventListener('click', () => {
		post({ type: 'listDocuments' });
	});

	$('#kb-open-settings')?.addEventListener('click', () => post({ type: 'openSettings' }));
}

// ── Document list ────────────────────────────────────────

function renderDocList(root, docs) {
	const header = `
		<div class="kb-search">
			<input id="kb-search-input" type="text" placeholder="搜索知识库..." />
			<button id="kb-edit-config" class="kb-icon-btn" title="编辑配置" type="button">${gearSvg()}</button>
		</div>`;

	if (!docs || docs.length === 0) {
		root.innerHTML = `${header}
			<div class="kb-empty">知识库为空，请在 Dify 平台上传文档。</div>
			${statusBar(0)}`;
		bindListEvents();
		return;
	}

	let html = `${header}<div class="kb-docs">`;

	for (const doc of docs) {
		const statusClass = doc.indexing_status || 'completed';
		const statusText = { completed: '已索引', error: '错误', indexing: '索引中' }[statusClass] || statusClass;
		const size = doc.word_count > 1000
			? (doc.word_count / 1000).toFixed(1) + 'k'
			: doc.word_count;
		html += `
			<div class="kb-doc" data-id="${escapeAttr(doc.id)}">
				<svg class="kb-doc-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
					<path fill="currentColor" d="M9.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5L9.5 1Zm-.5 4V2l3 3H9Z"/>
				</svg>
				<div class="kb-doc-body">
					<div class="kb-doc-name">${escapeHtml(doc.name)}</div>
					<div class="kb-doc-meta">
						<span>${size} 字</span>
						<span class="kb-doc-status ${escapeAttr(statusClass)}">${statusText}</span>
					</div>
				</div>
			</div>`;
	}

	html += `</div>${statusBar(docs.length)}`;
	root.innerHTML = html;

	$$('.kb-doc').forEach(el => {
		el.addEventListener('click', () => {
			const id = /** @type {HTMLElement} */ (el).dataset.id;
			post({ type: 'getSegments', documentId: id });
		});
	});
	bindListEvents();
}

function renderSegments(root, docName, segments) {
	let html = `
		<div class="kb-segments-header">
			<span class="back" id="kb-back">&larr; 返回列表</span>
			<span class="kb-doc-title">${escapeHtml(docName)}</span>
		</div>
		<div class="kb-segments">`;

	if (!segments || segments.length === 0) {
		html += `<div class="kb-empty">该文档暂无分段内容</div>`;
	} else {
		for (const seg of segments) {
			html += `
				<div class="kb-segment">
					<div class="kb-segment-pos">分段 #${seg.position} · ${seg.word_count} 字</div>
					${escapeHtml(seg.content)}
				</div>`;
		}
	}

	html += `</div>`;
	root.innerHTML = html;
	$('#kb-back')?.addEventListener('click', () => post({ type: 'listDocuments' }));
}

function renderSearchResults(root, query, results) {
	let html = `
		<div class="kb-search">
			<input id="kb-search-input" type="text" value="${escapeAttr(query)}" placeholder="搜索知识库..." />
			<button id="kb-edit-config" class="kb-icon-btn" title="编辑配置" type="button">${gearSvg()}</button>
		</div>
		<div class="kb-segments-header">
			<span class="back" id="kb-back">&larr; 返回列表</span>
			<span>搜索结果 (${results?.length ?? 0})</span>
		</div>
		<div class="kb-segments">`;

	if (!results || results.length === 0) {
		html += `<div class="kb-empty">未找到相关内容</div>`;
	} else {
		for (const r of results) {
			const docName = r.document?.name ?? '未知文档';
			html += `
				<div class="kb-result">
					<div class="kb-result-doc">${escapeHtml(docName)}</div>
					<div class="kb-result-content">${escapeHtml(r.segment?.content ?? '')}</div>
					<div class="kb-result-score">相关度: ${(r.score * 100).toFixed(1)}%</div>
				</div>`;
		}
	}

	html += `</div>`;
	root.innerHTML = html;
	$('#kb-back')?.addEventListener('click', () => post({ type: 'listDocuments' }));
	bindListEvents();
}

function statusBar(count) {
	return `<div class="kb-status"><span>${count} 篇文档</span><a id="kb-edit-config-link">编辑配置</a></div>`;
}

// ── Common bindings ──────────────────────────────────────

function bindListEvents() {
	const input = /** @type {HTMLInputElement|null} */ ($('#kb-search-input'));
	if (input) {
		input.focus();
		let timer;
		input.addEventListener('input', () => {
			clearTimeout(timer);
			const q = input.value.trim();
			if (!q) { return; }
			timer = setTimeout(() => post({ type: 'search', query: q }), 600);
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				input.value = '';
				post({ type: 'listDocuments' });
			}
		});
	}
	$('#kb-edit-config')?.addEventListener('click', () => post({ type: 'editConfig' }));
	$('#kb-edit-config-link')?.addEventListener('click', () => post({ type: 'editConfig' }));
}

function gearSvg() {
	return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
		<path fill="currentColor" d="M9.405 1.05c-.413-.21-.873-.21-1.286 0l-.469.238a.715.715 0 0 1-.692-.029l-.452-.27a1.435 1.435 0 0 0-1.46.014l-.486.296a1.435 1.435 0 0 0-.687 1.293l.024.527a.715.715 0 0 1-.346.6l-.452.27a1.435 1.435 0 0 0-.692 1.287l.024.567a.715.715 0 0 1-.346.6l-.452.27a1.435 1.435 0 0 0-.692 1.286v.567c0 .505.265.972.692 1.232l.452.275a.715.715 0 0 1 .346.6l-.024.566c-.018.527.247 1.027.692 1.287l.452.27a.715.715 0 0 1 .346.6l-.024.527c-.018.527.247 1.026.687 1.293l.486.296c.444.27 1.005.275 1.46.014l.452-.27a.715.715 0 0 1 .692-.029l.469.238c.413.21.873.21 1.286 0l.469-.238a.715.715 0 0 1 .692.029l.452.27a1.435 1.435 0 0 0 1.46-.014l.486-.296a1.435 1.435 0 0 0 .687-1.293l-.024-.527a.715.715 0 0 1 .346-.6l.452-.27a1.435 1.435 0 0 0 .692-1.287l-.024-.566a.715.715 0 0 1 .346-.6l.452-.275A1.435 1.435 0 0 0 16 8.566v-.567a1.435 1.435 0 0 0-.692-1.286l-.452-.27a.715.715 0 0 1-.346-.6l.024-.567a1.435 1.435 0 0 0-.692-1.287l-.452-.27a.715.715 0 0 1-.346-.6l.024-.527a1.435 1.435 0 0 0-.687-1.293l-.486-.296a1.435 1.435 0 0 0-1.46-.014l-.452.27a.715.715 0 0 1-.692.029l-.469-.238ZM8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"/>
	</svg>`;
}

// ── Message helpers ──────────────────────────────────────

function post(msg) { vscode.postMessage(msg); }

function escapeHtml(s) {
	if (s === null || s === undefined) { return ''; }
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) {
	if (s === null || s === undefined) { return ''; }
	return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Boot ─────────────────────────────────────────────────

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg && msg.type) {
		render(msg);
	}
});

post({ type: 'ready' });
