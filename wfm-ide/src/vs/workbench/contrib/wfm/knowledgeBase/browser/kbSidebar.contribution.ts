/*---------------------------------------------------------------------------------------------
 *  WFM Studio – Knowledge Base sidebar contribution.
 *
 *  Registers a ViewContainer (activity bar icon), a webview-based view for
 *  browsing a remote Dify knowledge base, and configuration settings.
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

// ── 1. Settings ──────────────────────────────────────────

const configRegistry = Registry.as<IConfigurationRegistry>(ConfigExt.Configuration);
configRegistry.registerConfiguration({
	id: 'wfm.knowledgeBase',
	title: localize('kbConfigTitle', "WFM Knowledge Base"),
	type: 'object',
	properties: {
		'wfm.knowledgeBase.apiUrl': {
			type: 'string',
			default: 'https://api.dify.ai/v1',
			description: localize('kb.apiUrl', "Dify API base URL"),
			order: 1,
		},
		'wfm.knowledgeBase.apiKey': {
			type: 'string',
			default: '',
			description: localize('kb.apiKey', "Dify API Key"),
			order: 2,
		},
		'wfm.knowledgeBase.datasetId': {
			type: 'string',
			default: '',
			description: localize('kb.datasetId', "Dify Dataset / Knowledge Base ID"),
			order: 3,
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
	) {
		super();

		this._register(
			this.webviewViewService.register(KB_VIEW_ID, {
				resolve: async (webviewView) => {
					const wv = webviewView.webview;

					// Allow scripts and load local media files
					wv.contentOptions = {
						enableScripts: true,
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

					// Handle messages from the webview
					this._register(
						wv.onMessage((evt) => this.onMessage(wv, evt.message)),
					);
				},
			}),
		);
	}

	// ── Message handler ───────────────────────────────────

	private async onMessage(wv: any, msg: any): Promise<void> {
		if (!msg || !msg.type) { return; }

		// Config-related messages don't require existing config
		if (msg.type === 'getConfig') {
			this.sendConfig(wv);
			return;
		}
		if (msg.type === 'saveConfig') {
			await this.saveConfig(wv, msg.apiUrl, msg.apiKey, msg.datasetId);
			return;
		}
		if (msg.type === 'editConfig') {
			this.sendConfig(wv, /*forceForm*/ true);
			return;
		}
		if (msg.type === 'openSettings') {
			this.commandService.executeCommand('workbench.action.openSettings', 'wfm.knowledgeBase');
			return;
		}

		const apiUrl = this.configService.getValue<string>('wfm.knowledgeBase.apiUrl') || '';
		const apiKey = this.configService.getValue<string>('wfm.knowledgeBase.apiKey') || '';
		const datasetId = this.configService.getValue<string>('wfm.knowledgeBase.datasetId') || '';

		if (!apiUrl || !apiKey || !datasetId) {
			if (msg.type === 'ready' || msg.type === 'listDocuments') {
				this.sendConfig(wv);
			}
			return;
		}

		try {
			switch (msg.type) {
				case 'ready':
				case 'listDocuments':
					await this.loadDocuments(wv, apiUrl, apiKey, datasetId);
					break;
				case 'getSegments':
					await this.loadSegments(wv, apiUrl, apiKey, datasetId, msg.documentId);
					break;
				case 'search':
					await this.search(wv, apiUrl, apiKey, datasetId, msg.query);
					break;
			}
		} catch (err: any) {
			wv.postMessage({ type: 'error', message: err?.message ?? String(err) });
		}
	}

	// ── Config helpers ────────────────────────────────────

	private sendConfig(wv: any, forceForm: boolean = false): void {
		const apiUrl = this.configService.getValue<string>('wfm.knowledgeBase.apiUrl') || 'https://api.dify.ai/v1';
		const apiKey = this.configService.getValue<string>('wfm.knowledgeBase.apiKey') || '';
		const datasetId = this.configService.getValue<string>('wfm.knowledgeBase.datasetId') || '';
		wv.postMessage({ type: 'config', apiUrl, apiKey, datasetId, forceForm });
	}

	private async saveConfig(wv: any, apiUrl: string, apiKey: string, datasetId: string): Promise<void> {
		try {
			await this.configService.updateValue('wfm.knowledgeBase.apiUrl', (apiUrl || '').trim() || 'https://api.dify.ai/v1', ConfigurationTarget.USER);
			await this.configService.updateValue('wfm.knowledgeBase.apiKey', (apiKey || '').trim(), ConfigurationTarget.USER);
			await this.configService.updateValue('wfm.knowledgeBase.datasetId', (datasetId || '').trim(), ConfigurationTarget.USER);
			// Immediately load documents with the new config
			const url = (apiUrl || '').trim() || 'https://api.dify.ai/v1';
			await this.loadDocuments(wv, url, (apiKey || '').trim(), (datasetId || '').trim());
		} catch (err: any) {
			wv.postMessage({ type: 'error', message: err?.message ?? String(err) });
		}
	}

	// ── Dify API calls ────────────────────────────────────

	private async loadDocuments(wv: any, apiUrl: string, apiKey: string, datasetId: string): Promise<void> {
		wv.postMessage({ type: 'loading' });
		const url = `${apiUrl}/datasets/${datasetId}/documents?page=1&limit=100`;
		const res = await this.difyFetch(url, apiKey);
		const data = await res.json();
		const docs = (data.data ?? []).map((d: any) => ({
			id: d.id,
			name: d.name,
			word_count: d.word_count ?? 0,
			hit_count: d.hit_count ?? 0,
			indexing_status: d.indexing_status ?? 'completed',
			created_at: d.created_at,
			updated_at: d.updated_at,
		}));
		wv.postMessage({ type: 'documents', docs });
	}

	private async loadSegments(wv: any, apiUrl: string, apiKey: string, datasetId: string, docId: string): Promise<void> {
		const url = `${apiUrl}/datasets/${datasetId}/documents/${docId}/segments`;
		const res = await this.difyFetch(url, apiKey);
		const data = await res.json();
		const segments = (data.data ?? []).map((s: any) => ({
			id: s.id,
			content: s.content,
			position: s.position ?? 0,
			word_count: s.word_count ?? 0,
		}));
		const docName = data.doc_name ?? (data.document?.name ?? docId);
		wv.postMessage({ type: 'segments', docId, docName, segments });
	}

	private async search(wv: any, apiUrl: string, apiKey: string, datasetId: string, query: string): Promise<void> {
		const url = `${apiUrl}/datasets/${datasetId}/retrieve`;
		const res = await this.difyFetch(url, apiKey, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query }),
		});
		const data = await res.json();
		const results = (data.records ?? []).map((r: any) => ({
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
		wv.postMessage({ type: 'searchResults', query, results });
	}

	private async difyFetch(url: string, apiKey: string, init?: RequestInit): Promise<Response> {
		const headers: Record<string, string> = {
			'Authorization': `Bearer ${apiKey}`,
			...(init?.headers as Record<string, string> ?? {}),
		};
		const response = await fetch(url, { ...init, headers });
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`Dify API ${response.status}: ${text || response.statusText}`);
		}
		return response;
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
		`connect-src https:`,  // allow Dify API calls
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
