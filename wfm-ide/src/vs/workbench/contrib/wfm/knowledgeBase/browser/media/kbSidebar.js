/*---------------------------------------------------------------------------------------------
 *  WFM Studio – Knowledge Base sidebar view (runs inside webview).
 *
 *  Three-level navigation:
 *    config form → datasets list → documents list → segments view
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable no-undef */

// @ts-check

const vscode = acquireVsCodeApi();

const DEFAULT_API_URL = 'https://api.dify.ai/v1';

// ── DOM helpers ──────────────────────────────────────────

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

// ── State ────────────────────────────────────────────────

/** @type {{apiUrl: string, apiKey: string} | null} */
let savedConfig = null;
/** @type {{id: string, name: string} | null} */
let currentDataset = null;

// ── Render entrypoint ────────────────────────────────────

function render(state) {
	const root = $('.kb-root');
	if (!root) { return; }

	switch (state.type) {
		case 'config':
			savedConfig = { apiUrl: state.apiUrl, apiKey: state.apiKey };
			renderConfigForm(root, state, /*saving*/ false);
			return;

		case 'loading':
			renderLoading(root, state.scope);
			return;

		case 'error':
			renderError(root, state.message);
			return;

		case 'datasets':
			currentDataset = null;
			renderDatasets(root, state.datasets);
			return;

		case 'documents':
			currentDataset = { id: state.datasetId, name: state.datasetName };
			renderDocuments(root, state.datasetName, state.docs);
			return;

		case 'segments':
			renderSegments(root, state.docName, state.segments, state.datasetId, state.datasetName);
			return;

		case 'searchResults':
			renderSearchResults(root, state.datasetId, state.datasetName, state.query, state.results);
			return;
	}
}

// ── Config form ──────────────────────────────────────────

function renderConfigForm(root, cfg, saving) {
	const apiUrl = cfg.apiUrl || DEFAULT_API_URL;
	const apiKey = cfg.apiKey || '';
	const isFirstTime = !apiKey;
	const errorBanner = cfg.errorMessage
		? `<div class="kb-form-error">${escapeHtml(cfg.errorMessage)}</div>`
		: '';
	const cancelBtn = isFirstTime
		? ''
		: `<button id="kb-cancel" class="kb-btn-ghost" type="button">取消</button>`;

	root.innerHTML = `
		<div class="kb-form">
			<div class="kb-form-title">${isFirstTime ? '配置远程知识库' : '编辑知识库配置'}</div>
			<div class="kb-form-hint">连接 Dify，浏览所有知识库与其中的文档。</div>
			${errorBanner}
			<label class="kb-field">
				<span>API 基础地址</span>
				<input id="kb-apiUrl" type="text" autocomplete="off" spellcheck="false" value="${escapeAttr(apiUrl)}" />
			</label>
			<label class="kb-field">
				<span>API Key (Dataset 类型)</span>
				<input id="kb-apiKey" type="password" autocomplete="off" spellcheck="false" value="${escapeAttr(apiKey)}" placeholder="dataset-xxxxxxxx" />
			</label>
			<div class="kb-form-actions">
				<button id="kb-save" class="kb-btn-primary" type="button" ${saving ? 'disabled' : ''}>${saving ? '保存中…' : '保存并连接'}</button>
				${cancelBtn}
			</div>
			<div class="kb-form-foot">
				<a id="kb-open-settings">在设置面板编辑</a>
			</div>
		</div>`;

	$('#kb-apiKey')?.focus();

	$('#kb-save')?.addEventListener('click', () => {
		const apiUrlVal = /** @type {HTMLInputElement} */ ($('#kb-apiUrl'))?.value.trim() || DEFAULT_API_URL;
		const apiKeyVal = /** @type {HTMLInputElement} */ ($('#kb-apiKey'))?.value.trim() || '';
		if (!apiKeyVal) {
			renderConfigForm(root, {
				apiUrl: apiUrlVal,
				apiKey: apiKeyVal,
				errorMessage: '请填写 API Key。',
			}, /*saving*/ false);
			return;
		}
		renderConfigForm(root, { apiUrl: apiUrlVal, apiKey: apiKeyVal }, /*saving*/ true);
		post({ type: 'saveConfig', apiUrl: apiUrlVal, apiKey: apiKeyVal });
	});

	$('#kb-cancel')?.addEventListener('click', () => post({ type: 'listDatasets' }));

	$('#kb-open-settings')?.addEventListener('click', () => post({ type: 'openSettings' }));
}

// ── Loading / error ──────────────────────────────────────

function renderLoading(root, scope) {
	const label = ({
		datasets: '加载知识库列表...',
		documents: '加载文档...',
		segments: '加载分段内容...',
		search: '搜索中...',
	})[scope] || '加载中...';
	root.innerHTML = `<div class="kb-loading"><span class="kb-spinner"></span>${label}</div>`;
}

function renderError(root, message) {
	const cfg = savedConfig ?? { apiUrl: DEFAULT_API_URL, apiKey: '' };
	// Recoverable errors (4xx, network) → fall back to config form so user can fix creds.
	const isAuthLike = /\b(401|403|invalid|unauthor)/i.test(message || '');
	if (isAuthLike) {
		renderConfigForm(root, { ...cfg, errorMessage: message }, /*saving*/ false);
		return;
	}
	root.innerHTML = `
		<div class="kb-error-pane">
			<div class="kb-error">${escapeHtml(message)}</div>
			<div class="kb-error-actions">
				<button id="kb-retry" class="kb-btn-ghost" type="button">重试</button>
				<button id="kb-edit" class="kb-btn-ghost" type="button">编辑配置</button>
			</div>
		</div>`;
	$('#kb-retry')?.addEventListener('click', () => post({
		type: currentDataset ? 'listDocuments' : 'listDatasets',
		datasetId: currentDataset?.id,
		datasetName: currentDataset?.name,
	}));
	$('#kb-edit')?.addEventListener('click', () => post({ type: 'editConfig' }));
}

// ── Datasets list (level 1) ──────────────────────────────

function renderDatasets(root, datasets) {
	const header = `
		<div class="kb-toolbar">
			<span class="kb-toolbar-title">知识库</span>
			<button id="kb-edit-config" class="kb-icon-btn" title="编辑配置" type="button">${gearSvg()}</button>
		</div>`;

	if (!datasets || datasets.length === 0) {
		root.innerHTML = `${header}
			<div class="kb-empty">未找到任何知识库。请先在 Dify 平台创建一个。</div>
			${statusBar(`0 个知识库`)}`;
		bindToolbar();
		return;
	}

	let html = `${header}<div class="kb-list">`;
	for (const ds of datasets) {
		const desc = ds.description ? `<div class="kb-item-desc">${escapeHtml(ds.description)}</div>` : '';
		html += `
			<div class="kb-item kb-dataset" data-id="${escapeAttr(ds.id)}" data-name="${escapeAttr(ds.name)}">
				${folderSvg()}
				<div class="kb-item-body">
					<div class="kb-item-name">${escapeHtml(ds.name)}</div>
					${desc}
					<div class="kb-item-meta">
						<span>${ds.document_count} 篇文档</span>
						<span>${formatWordCount(ds.word_count)} 字</span>
					</div>
				</div>
			</div>`;
	}
	html += `</div>${statusBar(`${datasets.length} 个知识库`)}`;
	root.innerHTML = html;

	$$('.kb-dataset').forEach(el => {
		el.addEventListener('click', () => {
			const id = /** @type {HTMLElement} */ (el).dataset.id || '';
			const name = /** @type {HTMLElement} */ (el).dataset.name || '';
			post({ type: 'listDocuments', datasetId: id, datasetName: name });
		});
	});
	bindToolbar();
}

// ── Documents list (level 2) ─────────────────────────────

function renderDocuments(root, datasetName, docs) {
	const header = `
		<div class="kb-toolbar">
			<button id="kb-back" class="kb-back" type="button">← 知识库</button>
			<span class="kb-toolbar-title" title="${escapeAttr(datasetName)}">${escapeHtml(datasetName)}</span>
			<button id="kb-edit-config" class="kb-icon-btn" title="编辑配置" type="button">${gearSvg()}</button>
		</div>
		<div class="kb-search">
			<input id="kb-search-input" type="text" placeholder="在该知识库中搜索..." />
		</div>`;

	if (!docs || docs.length === 0) {
		root.innerHTML = `${header}
			<div class="kb-empty">该知识库为空，请在 Dify 上传文档。</div>
			${statusBar('0 篇文档')}`;
		bindToolbar();
		bindSearch();
		bindBack(() => post({ type: 'listDatasets' }));
		return;
	}

	let html = `${header}<div class="kb-list">`;
	for (const doc of docs) {
		const statusClass = doc.indexing_status || 'completed';
		const statusText = ({ completed: '已索引', error: '错误', indexing: '索引中', waiting: '等待中', parsing: '解析中', cleaning: '清理中', splitting: '分段中' })[statusClass] || statusClass;
		html += `
			<div class="kb-item kb-doc" data-id="${escapeAttr(doc.id)}" data-name="${escapeAttr(doc.name)}">
				${fileSvg()}
				<div class="kb-item-body">
					<div class="kb-item-name">${escapeHtml(doc.name)}</div>
					<div class="kb-item-meta">
						<span>${formatWordCount(doc.word_count)} 字</span>
						<span class="kb-status-tag ${escapeAttr(statusClass)}">${statusText}</span>
					</div>
				</div>
			</div>`;
	}
	html += `</div>${statusBar(`${docs.length} 篇文档`)}`;
	root.innerHTML = html;

	$$('.kb-doc').forEach(el => {
		el.addEventListener('click', () => {
			const id = /** @type {HTMLElement} */ (el).dataset.id || '';
			const name = /** @type {HTMLElement} */ (el).dataset.name || '';
			post({
				type: 'getSegments',
				datasetId: currentDataset?.id,
				documentId: id,
				documentName: name,
			});
		});
	});
	bindToolbar();
	bindSearch();
	bindBack(() => post({ type: 'listDatasets' }));
}

// ── Segments view (level 3) ──────────────────────────────

function renderSegments(root, docName, segments, datasetId, datasetName) {
	const dsName = datasetName || currentDataset?.name || '';
	const header = `
		<div class="kb-toolbar">
			<button id="kb-back" class="kb-back" type="button">← ${escapeHtml(dsName || '文档列表')}</button>
			<span class="kb-toolbar-title" title="${escapeAttr(docName)}">${escapeHtml(docName)}</span>
		</div>`;

	let html = `${header}<div class="kb-segments">`;
	if (!segments || segments.length === 0) {
		html += `<div class="kb-empty">该文档暂无分段内容。</div>`;
	} else {
		for (const seg of segments) {
			html += `
				<div class="kb-segment">
					<div class="kb-segment-pos">分段 #${seg.position} · ${seg.word_count} 字</div>
					${escapeHtml(seg.content)}
				</div>`;
		}
	}
	html += `</div>${statusBar(`${segments?.length ?? 0} 个分段`)}`;
	root.innerHTML = html;

	bindBack(() => post({
		type: 'listDocuments',
		datasetId: datasetId || currentDataset?.id,
		datasetName: dsName,
	}));
}

// ── Search results (in current dataset) ──────────────────

function renderSearchResults(root, datasetId, datasetName, query, results) {
	const dsName = datasetName || currentDataset?.name || '';
	const header = `
		<div class="kb-toolbar">
			<button id="kb-back" class="kb-back" type="button">← ${escapeHtml(dsName)}</button>
			<span class="kb-toolbar-title">搜索: ${escapeHtml(query)}</span>
		</div>
		<div class="kb-search">
			<input id="kb-search-input" type="text" value="${escapeAttr(query)}" placeholder="在该知识库中搜索..." />
		</div>`;

	let html = `${header}<div class="kb-list">`;
	if (!results || results.length === 0) {
		html += `<div class="kb-empty">未找到相关内容。</div>`;
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
	html += `</div>${statusBar(`${results?.length ?? 0} 个结果`)}`;
	root.innerHTML = html;

	bindSearch();
	bindBack(() => post({
		type: 'listDocuments',
		datasetId: datasetId || currentDataset?.id,
		datasetName: dsName,
	}));
}

// ── Bindings ─────────────────────────────────────────────

function bindToolbar() {
	$('#kb-edit-config')?.addEventListener('click', () => post({ type: 'editConfig' }));
	$('#kb-edit-config-link')?.addEventListener('click', () => post({ type: 'editConfig' }));
}

function bindBack(handler) {
	$('#kb-back')?.addEventListener('click', handler);
}

function bindSearch() {
	const input = /** @type {HTMLInputElement|null} */ ($('#kb-search-input'));
	if (!input) { return; }
	input.focus();
	let timer;
	input.addEventListener('input', () => {
		clearTimeout(timer);
		const q = input.value.trim();
		if (!q) { return; }
		timer = setTimeout(() => post({
			type: 'search',
			datasetId: currentDataset?.id,
			datasetName: currentDataset?.name,
			query: q,
		}), 600);
	});
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			input.value = '';
			post({
				type: 'listDocuments',
				datasetId: currentDataset?.id,
				datasetName: currentDataset?.name,
			});
		}
	});
}

// ── Status bar ───────────────────────────────────────────

function statusBar(text) {
	return `<div class="kb-status"><span>${escapeHtml(text)}</span><a id="kb-edit-config-link">编辑配置</a></div>`;
}

// ── Inline SVG icons ─────────────────────────────────────

function folderSvg() {
	return `<svg class="kb-item-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
		<path fill="currentColor" d="M14.5 3H7.71l-2-2H1.5A1.5 1.5 0 0 0 0 2.5v11A1.5 1.5 0 0 0 1.5 15h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 3Z"/>
	</svg>`;
}

function fileSvg() {
	return `<svg class="kb-item-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
		<path fill="currentColor" d="M9.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5L9.5 1Zm-.5 4V2l3 3H9Z"/>
	</svg>`;
}

function gearSvg() {
	return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
		<path fill="currentColor" d="M9.405 1.05c-.413-.21-.873-.21-1.286 0l-.469.238a.715.715 0 0 1-.692-.029l-.452-.27a1.435 1.435 0 0 0-1.46.014l-.486.296a1.435 1.435 0 0 0-.687 1.293l.024.527a.715.715 0 0 1-.346.6l-.452.27a1.435 1.435 0 0 0-.692 1.287l.024.567a.715.715 0 0 1-.346.6l-.452.27a1.435 1.435 0 0 0-.692 1.286v.567c0 .505.265.972.692 1.232l.452.275a.715.715 0 0 1 .346.6l-.024.566c-.018.527.247 1.027.692 1.287l.452.27a.715.715 0 0 1 .346.6l-.024.527c-.018.527.247 1.026.687 1.293l.486.296c.444.27 1.005.275 1.46.014l.452-.27a.715.715 0 0 1 .692-.029l.469.238c.413.21.873.21 1.286 0l.469-.238a.715.715 0 0 1 .692.029l.452.27a1.435 1.435 0 0 0 1.46-.014l.486-.296a1.435 1.435 0 0 0 .687-1.293l-.024-.527a.715.715 0 0 1 .346-.6l.452-.27a1.435 1.435 0 0 0 .692-1.287l-.024-.566a.715.715 0 0 1 .346-.6l.452-.275A1.435 1.435 0 0 0 16 8.566v-.567a1.435 1.435 0 0 0-.692-1.286l-.452-.27a.715.715 0 0 1-.346-.6l.024-.567a1.435 1.435 0 0 0-.692-1.287l-.452-.27a.715.715 0 0 1-.346-.6l.024-.527a1.435 1.435 0 0 0-.687-1.293l-.486-.296a1.435 1.435 0 0 0-1.46-.014l-.452.27a.715.715 0 0 1-.692-.029l-.469-.238ZM8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"/>
	</svg>`;
}

// ── Utils ────────────────────────────────────────────────

function formatWordCount(n) {
	if (typeof n !== 'number' || isNaN(n)) { return '0'; }
	if (n >= 1000000) { return (n / 1000000).toFixed(1) + 'm'; }
	if (n >= 1000) { return (n / 1000).toFixed(1) + 'k'; }
	return String(n);
}

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
	if (msg && msg.type) { render(msg); }
});

post({ type: 'ready' });
