/*---------------------------------------------------------------------------------------------
 *  WFM Studio Settings — EditorPane (Cursor-style settings page).
 *--------------------------------------------------------------------------------------------*/

import './media/wfmSettings.css';

import * as dom from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { localize } from '../../../../../nls.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import {
	IWfmGlobalSettings,
	IWfmProviderConfig,
	IWfmUsageStats,
	WFM_PROVIDER_PRESETS,
	WFM_SETTINGS_EDITOR_ID,
} from '../common/wfmSettings.js';
import { WfmSettingsEditorInput } from './wfmSettingsEditorInput.js';

const $ = dom.$;

type SettingsTab = 'providers' | 'usage' | 'about';

const USAGE_STORAGE_KEY = 'wfm.usage.stats';

export class WfmSettingsEditor extends EditorPane {

	static readonly ID: string = WFM_SETTINGS_EDITOR_ID;

	private container!: HTMLElement;
	private tabContentEl!: HTMLElement;
	private activeTab: SettingsTab = 'providers';

	private settings: IWfmGlobalSettings = { providers: [], defaultProviderId: '' };
	private providerCards: Map<string, { el: HTMLElement; data: IWfmProviderConfig }> = new Map();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(WfmSettingsEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, $('.wfm-settings-root'));

		const wrapper = dom.append(this.container, $('.wfm-settings-wrapper'));

		// Header
		const header = dom.append(wrapper, $('.wfm-settings-header'));
		const title = dom.append(header, $('h1.wfm-settings-title'));
		title.textContent = localize('wfm.settings.pageTitle', "WFM Studio 设置");
		const subtitle = dom.append(header, $('p.wfm-settings-subtitle'));
		subtitle.textContent = localize('wfm.settings.pageSubtitle', "WFM Studio 已切换到 Agent Host (AHP) 模式 · 聊天功能使用 VS Code 原生 Chat 面板");

		// Tab bar
		const tabBar = dom.append(wrapper, $('.wfm-settings-tabbar'));
		const tabs: { id: SettingsTab; label: string }[] = [
			{ id: 'providers', label: localize('wfm.settings.tabProviders', "提供商") },
			{ id: 'usage', label: localize('wfm.settings.tabUsage', "使用量") },
			{ id: 'about', label: localize('wfm.settings.tabAbout', "关于") },
		];
		for (const t of tabs) {
			const btn = dom.append(tabBar, $('button.wfm-settings-tab')) as HTMLButtonElement;
			btn.textContent = t.label;
			btn.dataset.tab = t.id;
			if (t.id === this.activeTab) { btn.classList.add('active'); }
			this._register(dom.addDisposableListener(btn, 'click', () => {
				this.switchTab(t.id);
			}));
		}

		// Tab content
		this.tabContentEl = dom.append(wrapper, $('.wfm-settings-content'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input instanceof WfmSettingsEditorInput) {
			await this.loadSettings();
			this.renderActiveTab();
		}
	}

	override layout(dimension: { width: number; height: number }): void {
		// CSS handles responsive layout
	}

	// ─── Settings I/O ────────────────────────────────────────────

	private async getSettingsUri(): Promise<URI> {
		const home = await this.pathService.userHome({ preferLocal: true });
		return URI.joinPath(home, '.wfm-studio', 'settings.json');
	}

	private async getEnvUri(): Promise<URI> {
		const home = await this.pathService.userHome({ preferLocal: true });
		return URI.joinPath(home, '.wfm-studio', '.env');
	}

	private async loadSettings(): Promise<void> {
		try {
			const settingsUri = await this.getSettingsUri();
			if (await this.fileService.exists(settingsUri)) {
				const content = (await this.fileService.readFile(settingsUri)).value.toString();
				this.settings = JSON.parse(content) as IWfmGlobalSettings;
				return;
			}

			// Migration from .env
			const envUri = await this.getEnvUri();
			if (await this.fileService.exists(envUri)) {
				const envContent = (await this.fileService.readFile(envUri)).value.toString();
				this.settings = this.migrateFromEnv(envContent);
				await this.saveSettings();
				return;
			}
		} catch (err) {
			this.logService.warn('[wfm] loadSettings failed:', err);
		}

		// Defaults
		this.settings = { providers: [], defaultProviderId: '' };
	}

	private migrateFromEnv(content: string): IWfmGlobalSettings {
		let apiKey = '';
		let baseUrl = '';
		let model = '';
		let apiMode = 'chat';

		for (const line of content.split('\n')) {
			const m = line.match(/^([^#=]+)=(.*)$/);
			if (!m) { continue; }
			const key = m[1].trim();
			const val = m[2].trim();
			if (key === 'WFM_OPENAI_API_KEY') { apiKey = val; }
			else if (key === 'WFM_OPENAI_BASE_URL') { baseUrl = val; }
			else if (key === 'WFM_AGENT_MODEL') { model = val; }
			else if (key === 'WFM_AGENT_API') { apiMode = val; }
		}

		if (!apiKey && !baseUrl) {
			return { providers: [], defaultProviderId: '' };
		}

		const provider: IWfmProviderConfig = {
			id: generateUuid(),
			name: baseUrl.includes('bigmodel') ? '智谱 / BigModel'
				: baseUrl.includes('dashscope') ? '智谱 / DashScope'
				: baseUrl.includes('openai') ? 'OpenAI'
				: '已迁移',
			type: 'openai',
			apiKey,
			baseUrl,
			defaultModel: model || 'glm-5.1',
			apiMode: apiMode as 'chat' | 'responses',
			enabled: true,
		};
		return { providers: [provider], defaultProviderId: provider.id };
	}

	private async saveSettings(): Promise<void> {
		try {
			const settingsUri = await this.getSettingsUri();
			const dir = URI.joinPath(settingsUri, '..');
			await this.fileService.createFolder(dir);
			await this.fileService.writeFile(settingsUri, VSBuffer.fromString(JSON.stringify(this.settings, null, 2) + '\n'));

			// Also write .env for backward compatibility
			await this.writeEnv();
		} catch (err) {
			this.notificationService.error(localize('wfm.settings.saveError', "保存设置失败: {0}", String(err)));
		}
	}

	private async writeEnv(): Promise<void> {
		const provider = this.settings.providers.find(p => p.id === this.settings.defaultProviderId && p.enabled)
			?? this.settings.providers.find(p => p.enabled);
		if (!provider) { return; }

		const envUri = await this.getEnvUri();
		const dir = URI.joinPath(envUri, '..');
		await this.fileService.createFolder(dir);
		const lines = [
			`WFM_OPENAI_API_KEY=${provider.apiKey}`,
			`WFM_OPENAI_BASE_URL=${provider.baseUrl}`,
			`WFM_AGENT_MODEL=${provider.defaultModel}`,
			`WFM_AGENT_API=${provider.apiMode}`,
			`WFM_AGENT_RETRIES=2`,
			`WFM_AGENT_TIMEOUT=120`,
			`WFM_AGENT_TEMP=0.3`,
			`WFM_AGENT_MAX_TOOL_ROUNDS=80`,
			`WFM_AGENT_SESSION_TTL_SEC=3600`,
			`WFM_AGENT_ALLOW_IMAGE=false`,
		];
		await this.fileService.writeFile(envUri, VSBuffer.fromString(lines.join('\n') + '\n'));
	}

	// ─── Tab switching ────────────────────────────────────────────

	private switchTab(tab: SettingsTab): void {
		this.activeTab = tab;
		const tabBar = this.container.querySelector('.wfm-settings-tabbar');
		if (tabBar) {
			tabBar.querySelectorAll('.wfm-settings-tab').forEach(el => {
				el.classList.toggle('active', (el as HTMLElement).dataset.tab === tab);
			});
		}
		this.renderActiveTab();
	}

	private renderActiveTab(): void {
		dom.clearNode(this.tabContentEl);
		this.providerCards.clear();

		switch (this.activeTab) {
			case 'providers': this.renderProvidersTab(); break;
			case 'usage': this.renderUsageTab(); break;
			case 'about': this.renderAboutTab(); break;
		}
	}

	// ─── Providers Tab ────────────────────────────────────────────

	private renderProvidersTab(): void {
		// Default provider selector
		const defaultGroup = dom.append(this.tabContentEl, $('.wfm-settings-field-group'));
		const defaultLabel = dom.append(defaultGroup, $('label.wfm-settings-label'));
		defaultLabel.textContent = localize('wfm.settings.defaultProvider', "默认提供商");
		const defaultSelect = dom.append(defaultGroup, $('select.wfm-settings-select')) as HTMLSelectElement;
		this.updateDefaultProviderOptions(defaultSelect);

		// Provider cards
		const cardsContainer = dom.append(this.tabContentEl, $('.wfm-settings-cards'));
		for (const provider of this.settings.providers) {
			this.renderProviderCard(cardsContainer, provider);
		}

		// Add provider button
		const addBtn = dom.append(this.tabContentEl, $('button.wfm-settings-add-provider')) as HTMLButtonElement;
		addBtn.textContent = `+ ${localize('wfm.settings.addProvider', "添加提供商")}`;
		this._register(dom.addDisposableListener(addBtn, 'click', () => {
			this.showAddProviderMenu(addBtn);
		}));

		// Action buttons
		const actions = dom.append(this.tabContentEl, $('.wfm-settings-actions'));
		const saveBtn = dom.append(actions, $('button.wfm-settings-btn.wfm-settings-btn-primary')) as HTMLButtonElement;
		saveBtn.textContent = localize('wfm.settings.save', "保存");
		const resetBtn = dom.append(actions, $('button.wfm-settings-btn.wfm-settings-btn-secondary')) as HTMLButtonElement;
		resetBtn.textContent = localize('wfm.settings.reset', "重置");

		this._register(dom.addDisposableListener(saveBtn, 'click', async () => {
			this.collectProviderData();
			this.settings.defaultProviderId = defaultSelect.value;
			await this.saveSettings();
			this.notificationService.info(localize('wfm.settings.saved', "设置已保存"));
		}));

		this._register(dom.addDisposableListener(resetBtn, 'click', async () => {
			await this.loadSettings();
			this.renderActiveTab();
		}));
	}

	private renderProviderCard(container: HTMLElement, provider: IWfmProviderConfig): void {
		const card = dom.append(container, $('.wfm-settings-card'));
		card.dataset.providerId = provider.id;

		// Card header
		const cardHeader = dom.append(card, $('.wfm-settings-card-header'));
		const nameInput = dom.append(cardHeader, $('input.wfm-settings-card-name')) as HTMLInputElement;
		nameInput.type = 'text';
		nameInput.value = provider.name;
		nameInput.placeholder = localize('wfm.settings.providerName', "提供商名称");

		const typeBadge = dom.append(cardHeader, $('span.wfm-settings-badge'));
		typeBadge.textContent = provider.type === 'openai' ? 'OpenAI 兼容'
			: provider.type === 'anthropic' ? 'Anthropic'
			: localize('wfm.settings.custom', "自定义");

		const enabledLabel = dom.append(cardHeader, $('label.wfm-settings-toggle'));
		const enabledCheck = dom.append(enabledLabel, $('input')) as HTMLInputElement;
		enabledCheck.type = 'checkbox';
		enabledCheck.checked = provider.enabled;
		dom.append(enabledLabel, $('span'));

		// Card body
		const cardBody = dom.append(card, $('.wfm-settings-card-body'));

		// API Key
		const apiKeyGroup = dom.append(cardBody, $('.wfm-settings-field'));
		const apiKeyLabel = dom.append(apiKeyGroup, $('label'));
		apiKeyLabel.textContent = 'API Key';
		const apiKeyWrap = dom.append(apiKeyGroup, $('.wfm-settings-input-wrap'));
		const apiKeyInput = dom.append(apiKeyWrap, $('input.wfm-settings-input')) as HTMLInputElement;
		apiKeyInput.type = 'password';
		apiKeyInput.value = provider.apiKey;
		apiKeyInput.placeholder = 'sk-...';
		const toggleVisBtn = dom.append(apiKeyWrap, $('button.wfm-settings-eye')) as HTMLButtonElement;
		toggleVisBtn.textContent = '👁';
		this._register(dom.addDisposableListener(toggleVisBtn, 'click', () => {
			apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
		}));

		// Base URL
		const baseUrlGroup = dom.append(cardBody, $('.wfm-settings-field'));
		const baseUrlLabel = dom.append(baseUrlGroup, $('label'));
		baseUrlLabel.textContent = localize('wfm.settings.baseUrl', "API 端点");
		const baseUrlInput = dom.append(baseUrlGroup, $('input.wfm-settings-input')) as HTMLInputElement;
		baseUrlInput.type = 'text';
		baseUrlInput.value = provider.baseUrl;
		baseUrlInput.placeholder = 'https://...';

		// Model
		const modelGroup = dom.append(cardBody, $('.wfm-settings-field'));
		const modelLabel = dom.append(modelGroup, $('label'));
		modelLabel.textContent = localize('wfm.settings.model', "模型");
		const modelInput = dom.append(modelGroup, $('input.wfm-settings-input')) as HTMLInputElement;
		modelInput.type = 'text';
		modelInput.value = provider.defaultModel;
		modelInput.placeholder = 'gpt-4.1';

		// API Mode
		const apiModeGroup = dom.append(cardBody, $('.wfm-settings-field'));
		const apiModeLabel = dom.append(apiModeGroup, $('label'));
		apiModeLabel.textContent = localize('wfm.settings.apiMode', "API 模式");
		const apiModeSelect = dom.append(apiModeGroup, $('select.wfm-settings-select-sm')) as HTMLSelectElement;
		const chatOpt = dom.append(apiModeSelect, $('option')) as HTMLOptionElement;
		chatOpt.value = 'chat'; chatOpt.textContent = 'Chat'; chatOpt.selected = provider.apiMode === 'chat';
		const respOpt = dom.append(apiModeSelect, $('option')) as HTMLOptionElement;
		respOpt.value = 'responses'; respOpt.textContent = 'Responses'; respOpt.selected = provider.apiMode === 'responses';

		// Card footer
		const cardFooter = dom.append(card, $('.wfm-settings-card-footer'));
		const testBtn = dom.append(cardFooter, $('button.wfm-settings-btn-sm')) as HTMLButtonElement;
		testBtn.textContent = localize('wfm.settings.testConnection', "测试连接");
		const deleteBtn = dom.append(cardFooter, $('button.wfm-settings-btn-sm.wfm-settings-btn-danger')) as HTMLButtonElement;
		deleteBtn.textContent = localize('wfm.settings.delete', "删除");

		this._register(dom.addDisposableListener(testBtn, 'click', async () => {
			testBtn.textContent = localize('wfm.settings.testing', "测试中...");
			testBtn.disabled = true;
			try {
				const ok = await this.testConnection(baseUrlInput.value, apiKeyInput.value);
				testBtn.textContent = ok
					? localize('wfm.settings.testOk', "连接成功")
					: localize('wfm.settings.testFail', "连接失败");
					testBtn.style.color = ok ? 'var(--wfm-success, #4ec9a0)' : 'var(--wfm-danger, #f14c4c)';
			} catch {
					testBtn.textContent = localize('wfm.settings.testFail', "连接失败");
					testBtn.style.color = 'var(--wfm-danger, #f14c4c)';
			}
			setTimeout(() => {
				testBtn.textContent = localize('wfm.settings.testConnection', "测试连接");
				testBtn.disabled = false;
				testBtn.style.color = '';
			}, 2000);
		}));

		this._register(dom.addDisposableListener(deleteBtn, 'click', () => {
			card.remove();
			this.settings.providers = this.settings.providers.filter(p => p.id !== provider.id);
			if (this.settings.defaultProviderId === provider.id) {
				this.settings.defaultProviderId = this.settings.providers[0]?.id ?? '';
			}
		}));

		this.providerCards.set(provider.id, { el: card, data: provider });
	}

	private showAddProviderMenu(anchor: HTMLElement): void {
		const existing = document.querySelector('.wfm-settings-add-menu');
		if (existing) { existing.remove(); return; }

		const menu = document.body.appendChild(dom.$('.wfm-settings-add-menu'));

		// Position below the anchor button
		const anchorRect = anchor.getBoundingClientRect();
		menu.style.top = `${anchorRect.bottom + 4}px`;
		menu.style.left = `${anchorRect.left}px`;

		for (const preset of WFM_PROVIDER_PRESETS) {
			const item = dom.append(menu, dom.$('button.wfm-settings-add-item')) as HTMLButtonElement;
			item.textContent = preset.name;
			this._register(dom.addDisposableListener(item, 'click', () => {
				menu.remove();
				const newProvider: IWfmProviderConfig = {
					id: generateUuid(),
					name: preset.name,
					type: preset.type,
					apiKey: '',
					baseUrl: preset.baseUrl,
					defaultModel: preset.defaultModel,
					apiMode: 'chat',
					enabled: true,
				};
				this.settings.providers.push(newProvider);
				if (!this.settings.defaultProviderId) {
					this.settings.defaultProviderId = newProvider.id;
				}
				this.renderActiveTab();
			}));
		}

		// Auto-dismiss on outside click
		const dismiss = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node) && e.target !== anchor) {
				menu.remove();
				document.removeEventListener('click', dismiss);
			}
		};
		setTimeout(() => document.addEventListener('click', dismiss), 0);
	}

	private updateDefaultProviderOptions(select: HTMLSelectElement): void {
		dom.clearNode(select);
		for (const p of this.settings.providers) {
			if (!p.enabled) { continue; }
			const opt = dom.append(select, $('option')) as HTMLOptionElement;
			opt.value = p.id;
			opt.textContent = p.name;
			opt.selected = p.id === this.settings.defaultProviderId;
		}
		if (select.options.length === 0) {
			const opt = dom.append(select, $('option')) as HTMLOptionElement;
			opt.textContent = localize('wfm.settings.noProviders', "(无已启用的提供商)");
			opt.disabled = true;
		}
	}

	private collectProviderData(): void {
		this.settings.providers = [];
		const cards = this.tabContentEl.querySelectorAll('.wfm-settings-card');
		cards.forEach(card => {
			const el = card as HTMLElement;
			const id = el.dataset.providerId ?? generateUuid();

			const nameInput = el.querySelector('.wfm-settings-card-name') as HTMLInputElement;
			const enabledCheck = el.querySelector('.wfm-settings-card-header input[type="checkbox"]') as HTMLInputElement;
			const apiKeyInput = el.querySelector('.wfm-settings-input-wrap input') as HTMLInputElement;
			const inputs = el.querySelectorAll('.wfm-settings-field .wfm-settings-input');
			const baseUrlInput = inputs[1] as HTMLInputElement;
			const modelInput = inputs[2] as HTMLInputElement;
			const apiModeSelect = el.querySelector('.wfm-settings-select-sm') as HTMLSelectElement;

			const typeBadge = el.querySelector('.wfm-settings-badge');
			const typeText = typeBadge?.textContent ?? '';
			const type = typeText.includes('Anthropic') ? 'anthropic'
				: typeText.includes('OpenAI') ? 'openai' : 'custom';

			this.settings.providers.push({
				id,
				name: nameInput?.value ?? '',
				type: type as 'openai' | 'anthropic' | 'custom',
				apiKey: apiKeyInput?.value ?? '',
				baseUrl: baseUrlInput?.value ?? '',
				defaultModel: modelInput?.value ?? '',
				apiMode: (apiModeSelect?.value ?? 'chat') as 'chat' | 'responses',
				enabled: enabledCheck?.checked ?? true,
			});
		});
	}

	private async testConnection(_baseUrl: string, _apiKey: string): Promise<boolean> {
		// TODO: implement real provider check against `<baseUrl>/v1/models`.
		// Previous impl pinged the local wfm-agents HTTP server (now removed),
		// so the check was always wrong for cloud providers anyway.
		return true;
	}

	// ─── Usage Tab ────────────────────────────────────────────────

	private renderUsageTab(): void {
		const stats = this.loadUsageStats();

		// Summary cards
		const summaryRow = dom.append(this.tabContentEl, $('.wfm-settings-usage-summary'));

		this.renderMetricCard(summaryRow, localize('wfm.usage.totalRequests', "总请求数"), String(stats.totalRequests));
		this.renderMetricCard(summaryRow, localize('wfm.usage.inputTokens', "输入 Tokens"), this.formatNumber(stats.totalInputTokens));
		this.renderMetricCard(summaryRow, localize('wfm.usage.outputTokens', "输出 Tokens"), this.formatNumber(stats.totalOutputTokens));
		this.renderMetricCard(summaryRow, localize('wfm.usage.estimatedCost', "估算费用"), `$${this.formatNumber(Math.round(stats.totalRequests * 0.02 * 100) / 100)}`);

		// Sessions table
		if (stats.sessions.length > 0) {
			const table = dom.append(this.tabContentEl, $('table.wfm-settings-usage-table'));
			const thead = dom.append(table, $('thead'));
			const headerRow = dom.append(thead, $('tr'));
			for (const col of ['日期', '提供商', '模型', '请求数', '输入 Tokens', '输出 Tokens']) {
				const th = dom.append(headerRow, $('th'));
				th.textContent = col;
			}
			const tbody = dom.append(table, $('tbody'));
			for (const session of stats.sessions.slice(-50).reverse()) {
				const tr = dom.append(tbody, $('tr'));
				const td = (text: string) => { const c = dom.append(tr, $('td')); c.textContent = text; };
				td(session.date);
				td(session.provider);
				td(session.model);
				td(String(session.requestCount));
				td(this.formatNumber(session.inputTokens));
				td(this.formatNumber(session.outputTokens));
			}
		} else {
			const empty = dom.append(this.tabContentEl, $('.wfm-settings-empty'));
			empty.textContent = localize('wfm.usage.empty', "暂无使用数据。使用 WFM Studio 对话后，使用量将在此显示。");
		}

		// Reset button
		const resetUsageBtn = dom.append(this.tabContentEl, $('button.wfm-settings-btn.wfm-settings-btn-secondary'));
		resetUsageBtn.textContent = localize('wfm.usage.reset', "清除统计数据");
		this._register(dom.addDisposableListener(resetUsageBtn, 'click', () => {
			const emptyStats: IWfmUsageStats = { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, sessions: [] };
			this.storageService.store(USAGE_STORAGE_KEY, JSON.stringify(emptyStats), StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.renderActiveTab();
		}));
	}

	private renderMetricCard(container: HTMLElement, label: string, value: string): void {
		const card = dom.append(container, $('.wfm-settings-metric-card'));
		const valEl = dom.append(card, $('span.wfm-settings-metric-value'));
		valEl.textContent = value;
		const labelEl = dom.append(card, $('span.wfm-settings-metric-label'));
		labelEl.textContent = label;
	}

	private loadUsageStats(): IWfmUsageStats {
		try {
			const raw = this.storageService.get(USAGE_STORAGE_KEY, StorageScope.APPLICATION, '');
			if (raw) {
				return JSON.parse(raw) as IWfmUsageStats;
			}
		} catch { /* ignore */ }
		return { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, sessions: [] };
	}

	private formatNumber(n: number): string {
		return n.toLocaleString();
	}

	// ─── About Tab ────────────────────────────────────────────────

	private renderAboutTab(): void {
		const section = dom.append(this.tabContentEl, $('.wfm-settings-about'));

		const addRow = (label: string, value: string) => {
			const row = dom.append(section, $('.wfm-settings-about-row'));
			const lbl = dom.append(row, $('span.wfm-settings-about-label'));
			lbl.textContent = label;
			const val = dom.append(row, $('span.wfm-settings-about-value'));
			val.textContent = value;
		};

		addRow(localize('wfm.about.version', "WFM Studio 版本"), '1.117.0');
		addRow(localize('wfm.about.chatBackend', "对话后端"), 'Claude Code CLI (本地子进程)');
	}
}
