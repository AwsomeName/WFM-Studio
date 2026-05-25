/*---------------------------------------------------------------------------------------------
 *  WFM Studio – Knowledge Base sidebar contribution.
 *
 *  Two-level navigation backed by Dify HTTP APIs:
 *    1. Datasets (knowledge bases) — `GET /v1/datasets`
 *    2. Documents inside a dataset — `GET /v1/datasets/{id}/documents`
 *    3. Segments inside a document — `GET /v1/datasets/{id}/documents/{doc}/segments`
 *
 *  All HTTP traffic goes through `IRequestService` (electron-net in the
 *  main process), bypassing the renderer fetch + CORS preflight that fails
 *  against api.dify.ai from the `vscode-file://` origin.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IViewContainersRegistry, ViewContainerLocation, Extensions as ViewExt, IViewsRegistry } from '../../../../common/views.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { WebviewViewPane } from '../../../webviewView/browser/webviewViewPane.js';
import { IWebviewViewService } from '../../../webviewView/browser/webviewViewService.js';
import { IConfigurationRegistry, Extensions as ConfigExt } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IRequestService, asText } from '../../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { asWebviewUri, webviewGenericCspSource } from '../../../webview/common/webview.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { KB_VIEWLET_ID, KB_VIEW_ID } from '../common/kbConstants.js';

// ── Icon ─────────────────────────────────────────────────

const kbViewIcon = registerIcon('wfm-knowledge-base-view-icon', Codicon.book,
	localize('kbViewIcon', 'View icon for the Knowledge Base sidebar.'));

// ── Media root for webview resources ──────────────────────

const MEDIA_ROOT = FileAccess.asFileUri(
	'vs/workbench/contrib/wfm/knowledgeBase/browser/media/',
);

const DEFAULT_API_URL = 'https://api.dify.ai/v1';

// ── 1. Settings ──────────────────────────────────────────

const configRegistry = Registry.as<IConfigurationRegistry>(ConfigExt.Configuration);
configRegistry.registerConfiguration({
	id: 'wfm.knowledgeBase',
	title: localize('kbConfigTitle', "WFM Knowledge Base"),
	type: 'object',
	properties: {
		'wfm.knowledgeBase.apiUrl': {
			type: 'string',
			default: DEFAULT_API_URL,
			description: localize('kb.apiUrl', "Dify API base URL"),
			order: 1,
		},
		'wfm.knowledgeBase.apiKey': {
			type: 'string',
			default: '',
			description: localize('kb.apiKey', "Dify API Key (must be a Dataset-scoped key)"),
			order: 2,
		},
	},
});

// ── 2. ViewContainer (activity bar icon) ─────────────────

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExt.ViewContainersRegistry);
const viewContainer = viewContainerRegistry.registerViewContainer({
	id: KB_VIEWLET_ID,
	title: localize2('kb.containerTitle', "Knowledge Base"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [KB_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'workbench.wfm.kb.views.state',
	icon: kbViewIcon,
	order: 5,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar);

// ── 3. View (WebviewViewPane) ─────────────────────────────

const viewsRegistry = Registry.as<IViewsRegistry>(ViewExt.ViewsRegistry);
viewsRegistry.registerViews([{
	id: KB_VIEW_ID,
	name: localize2('kb.viewTitle', "Documents"),
	ctorDescriptor: new SyncDescriptor(WebviewViewPane),
	canToggleVisibility: false,
	canMoveView: true,
	containerIcon: kbViewIcon,
	order: 1,
}], viewContainer);

// ── 4. Webview resolver (workbench contribution for DI) ──

class KbWebviewResolverContribution extends Disposable {

	constructor(
		@IWebviewViewService private readonly webviewViewService: IWebviewViewService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IRequestService private readonly requestService: IRequestService,
	) {
		super();

		this._register(
			this.webviewViewService.register(KB_VIEW_ID, {
				resolve: async (webviewView) => {
					const wv = webviewView.webview;

					wv.contentOptions = {
						allowScripts: true,
						localResourceRoots: [MEDIA_ROOT],
					};

					const nonce = generateUuid().replace(/-/g, '');
					const mediaUri = (file: string) =>
						asWebviewUri(joinPath(MEDIA_ROOT, file)).toString(true);

					const html = buildKbHtml({
						nonce,
						cspSource: webviewGenericCspSource,
						cssUri: mediaUri('kbSidebar.css'),
						jsUri: mediaUri('kbSidebar.js'),
					});
					wv.setHtml(html);

					this._register(
						wv.onMessage((evt) => this.onMessage(wv, evt.message)),
					);
				},
			}),
		);
	}

	// ── Message router ────────────────────────────────────

	private async onMessage(wv: any, msg: any): Promise<void> {
		if (!msg || !msg.type) { return; }

		switch (msg.type) {
			case 'getConfig':
			case 'editConfig':
				this.sendConfig(wv);
				return;

			case 'saveConfig':
				await this.handleSaveConfig(wv, msg.apiUrl, msg.apiKey);
				return;

			case 'openSettings':
				this.commandService.executeCommand('workbench.action.openSettings', 'wfm.knowledgeBase');
				return;
		}

		const apiUrl = (this.configService.getValue<string>('wfm.knowledgeBase.apiUrl') || DEFAULT_API_URL).replace(/\/+$/, '');
		const apiKey = this.configService.getValue<string>('wfm.knowledgeBase.apiKey') || '';

		if (!apiUrl || !apiKey) {
			this.sendConfig(wv);
			return;
		}

		try {
			switch (msg.type) {
				case 'ready':
				case 'listDatasets':
					await this.loadDatasets(wv, apiUrl, apiKey);
					break;
				case 'listDocuments':
					await this.loadDocuments(wv, apiUrl, apiKey, msg.datasetId, msg.datasetName);
					break;
				case 'getSegments':
					await this.loadSegments(wv, apiUrl, apiKey, msg.datasetId, msg.documentId, msg.documentName);
					break;
				case 'search':
					await this.search(wv, apiUrl, apiKey, msg.datasetId, msg.datasetName, msg.query);
					break;
			}
		} catch (err: any) {
			wv.postMessage({ type: 'error', message: err?.message ?? String(err) });
		}
	}

	// ── Config helpers ────────────────────────────────────

	private sendConfig(wv: any): void {
		const apiUrl = this.configService.getValue<string>('wfm.knowledgeBase.apiUrl') || DEFAULT_API_URL;
		const apiKey = this.configService.getValue<string>('wfm.knowledgeBase.apiKey') || '';
		wv.postMessage({ type: 'config', apiUrl, apiKey });
	}

	private async handleSaveConfig(wv: any, apiUrl: string, apiKey: string): Promise<void> {
		const cleanedUrl = ((apiUrl || '').trim() || DEFAULT_API_URL).replace(/\/+$/, '');
		const cleanedKey = (apiKey || '').trim();
		try {
			await this.configService.updateValue('wfm.knowledgeBase.apiUrl', cleanedUrl, ConfigurationTarget.USER);
			await this.configService.updateValue('wfm.knowledgeBase.apiKey', cleanedKey, ConfigurationTarget.USER);
			await this.loadDatasets(wv, cleanedUrl, cleanedKey);
		} catch (err: any) {
			wv.postMessage({ type: 'error', message: err?.message ?? String(err) });
		}
	}

	// ── Dify API calls ────────────────────────────────────

	private async loadDatasets(wv: any, apiUrl: string, apiKey: string): Promise<void> {
		wv.postMessage({ type: 'loading', scope: 'datasets' });
		const data = await this.difyJson<any>(`${apiUrl}/datasets?page=1&limit=100`, apiKey);
		const datasets = (data?.data ?? []).map((d: any) => ({
			id: d.id,
			name: d.name,
			description: d.description ?? '',
			document_count: d.document_count ?? 0,
			word_count: d.word_count ?? 0,
			indexing_technique: d.indexing_technique ?? '',
		}));
		wv.postMessage({ type: 'datasets', datasets });
	}

	private async loadDocuments(wv: any, apiUrl: string, apiKey: string, datasetId: string, datasetName: string): Promise<void> {
		wv.postMessage({ type: 'loading', scope: 'documents' });
		const data = await this.difyJson<any>(`${apiUrl}/datasets/${datasetId}/documents?page=1&limit=100`, apiKey);
		const docs = (data?.data ?? []).map((d: any) => ({
			id: d.id,
			name: d.name,
			word_count: d.word_count ?? 0,
			hit_count: d.hit_count ?? 0,
			indexing_status: d.indexing_status ?? 'completed',
			created_at: d.created_at,
		}));
		wv.postMessage({ type: 'documents', datasetId, datasetName, docs });
	}

	private async loadSegments(wv: any, apiUrl: string, apiKey: string, datasetId: string, docId: string, docName: string): Promise<void> {
		wv.postMessage({ type: 'loading', scope: 'segments' });
		const data = await this.difyJson<any>(`${apiUrl}/datasets/${datasetId}/documents/${docId}/segments`, apiKey);
		const segments = (data?.data ?? []).map((s: any) => ({
			id: s.id,
			content: s.content,
			position: s.position ?? 0,
			word_count: s.word_count ?? 0,
		}));
		const resolvedName = data?.doc_name ?? data?.document?.name ?? docName ?? docId;
		wv.postMessage({ type: 'segments', datasetId, docId, docName: resolvedName, segments });
	}

	private async search(wv: any, apiUrl: string, apiKey: string, datasetId: string, datasetName: string, query: string): Promise<void> {
		wv.postMessage({ type: 'loading', scope: 'search' });
		const data = await this.difyJson<any>(`${apiUrl}/datasets/${datasetId}/retrieve`, apiKey, {
			method: 'POST',
			body: JSON.stringify({ query }),
		});
		const results = (data?.records ?? []).map((r: any) => ({
			segment: {
				id: r.segment?.id ?? '',
				content: r.segment?.content ?? '',
				position: r.segment?.position ?? 0,
				word_count: r.segment?.word_count ?? 0,
			},
			score: r.score ?? 0,
			document: r.segment?.document
				? { id: r.segment.document.id, name: r.segment.document.name }
				: undefined,
		}));
		wv.postMessage({ type: 'searchResults', datasetId, datasetName, query, results });
	}

	// ── Low-level HTTP via IRequestService (electron-net, no CORS) ──

	private async difyJson<T>(url: string, apiKey: string, init?: { method?: string; body?: string }): Promise<T> {
		const ctx = await this.requestService.request({
			type: init?.method ?? 'GET',
			url,
			data: init?.body,
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				...(init?.body ? { 'Content-Type': 'application/json' } : {}),
				'Accept': 'application/json',
			},
			callSite: 'WfmKnowledgeBase',
		}, CancellationToken.None);

		const status = ctx.res.statusCode ?? 0;
		const body = (await asText(ctx)) ?? '';

		if (status < 200 || status >= 300) {
			let detail = body;
			try {
				const j = body ? JSON.parse(body) : null;
				detail = j?.message || j?.error_msg || body;
			} catch { /* keep raw body */ }
			throw new Error(`Dify API ${status || 'no-status'}: ${detail || 'request failed'}`);
		}

		if (!body) {
			throw new Error('Dify API returned empty response');
		}

		try {
			return JSON.parse(body) as T;
		} catch (err: any) {
			throw new Error(`Dify API returned invalid JSON: ${err?.message ?? String(err)}`);
		}
	}
}

// ── HTML builder ──────────────────────────────────────────

interface IKbHtmlArgs {
	nonce: string;
	cspSource: string;
	cssUri: string;
	jsUri: string;
}

function buildKbHtml(args: IKbHtmlArgs): string {
	const { nonce, cspSource, cssUri, jsUri } = args;
	const csp = [
		`default-src 'none'`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		`img-src ${cspSource} data:`,
	].join('; ');

	return /*html*/ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${cssUri}">
	<title>Knowledge Base</title>
</head>
<body>
	<div class="kb-root"><div class="kb-loading">加载中...</div></div>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

// ── Register workbench contribution ───────────────────────

const workbenchContributions = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchContributions.registerWorkbenchContribution(KbWebviewResolverContribution, LifecyclePhase.Eventually);
