/*---------------------------------------------------------------------------------------------
 *  WFM Studio contributions.
 *--------------------------------------------------------------------------------------------*/

import './media/wfmChat.css';

import * as dom from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { Memento } from '../../../common/memento.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	IWfmAgentClientService,
	IWfmChatExtras,
	IWfmFileAttachment,
} from '../common/wfmAgentClient.js';

const $ = dom.$;

type WfmRole = 'user' | 'assistant' | 'error';

interface IMessageEntry {
	readonly role: WfmRole;
	readonly content: string;
	readonly workspacePath?: string;
	readonly originLabel?: string;
	readonly attachments?: IWfmFileAttachment[];
	readonly activitySummary?: string;
}

interface IWfmChatSession {
	readonly id: string;
	backendSessionId: string | undefined;
	title: string;
	readonly messages: IMessageEntry[];
	readonly createdAt: string;
}

interface IWfmChatSessionsState {
	sessions: IWfmChatSession[];
	activeSessionId: string;
}

const STORAGE_KEY = 'wfm.chat.sessions';

const TOOL_DISPLAY_NAMES: Record<string, string> = {
	workspace_read: '读取文件',
	workspace_write: '写入文件',
	cad_generate_step: '生成 STEP 模型',
	cad_inspect: '检查几何体',
	cad_render: '渲染预览',
	cad_export_dxf: '导出 DXF',
	cad_convert_format: '转换格式',
	cad_file_read: '读取 CAD 文件',
	cad_extract_texts: '提取文字',
	cad_extract_dims: '提取标注',
	cad_extract_blocks: '提取图块',
	cad_layer_inspect: '检查图层',
	cad_check_naming: '检查命名规范',
	cad_check_titleblock: '检查标题栏',
	cad_check_dim_accuracy: '检查标注精度',
	docx_read: '读取文档',
	text_to_cad: '生成 3D 模型',
};

const AGENT_DISPLAY_NAMES: Record<string, string> = {
	wfm_router: 'WFM 路由',
	text_to_cad: '3D 模型生成',
	cad_review: 'CAD 审图',
	docx_review: '文档审阅',
};

interface IStreamingMessageHandle {
	readonly rootEl: HTMLElement;
	readonly activityEl: HTMLElement;
	readonly bodyEl: HTMLElement;
	appendText(delta: string): void;
	addHandoffStep(agent: string): void;
	addToolStep(id: string, name: string): void;
	completeToolStep(id: string): void;
	finalize(text: string): void;
	showError(error: string): void;
	scrollToBottom(): void;
}

export class WfmChatViewPane extends ViewPane {

	static readonly ID = 'workbench.view.wfm.aiChat';

	private rootEl: HTMLElement | undefined;
	private messagesEl: HTMLElement | undefined;
	private statusEl: HTMLElement | undefined;
	private inputEl: HTMLTextAreaElement | undefined;
	private sendButton: HTMLButtonElement | undefined;
	private micButton: HTMLButtonElement | undefined;
	private agentSelector: HTMLButtonElement | undefined;
	private modelSelector: HTMLButtonElement | undefined;
	private attachmentsEl: HTMLElement | undefined;
	private tabStripEl: HTMLElement | undefined;
	private readonly tabBarDisposables = this._register(new DisposableStore());
	private readonly attachments: IWfmFileAttachment[] = [];
	private pendingCts: CancellationTokenSource | undefined;

	private static readonly AGENT_LIST = [
		{ id: 'wfm.router', label: 'WFM Router' },
		{ id: 'text_to_cad', label: 'Text-to-CAD' },
		{ id: 'cad_review', label: 'CAD 审图' },
		{ id: 'docx_review', label: 'DOCX 审阅' },
		{ id: 'openclaw', label: 'OpenClaw (即将推出)' },
	];

	// 模型列表对齐 wfm-agents/.env 里的实际配置：base_url 走阿里云 DashScope 兼容模式
	// (https://dashscope.aliyuncs.com/compatible-mode/v1)，默认模型 glm-5.1。
	// 当前 UI 选择尚未传递给后端 (见 docs/PLAN_AGENT_MODEL_SELECTOR.md §1)，
	// 占位项仅用于展示阿里云上可切换的候选，不会改变实际跑的模型。
	private static readonly MODEL_LIST = [
		{ id: 'glm-5.1', label: 'GLM-5.1 (阿里云)' },
		{ id: 'qwen-max', label: 'Qwen Max (即将推出)' },
		{ id: 'qwen-plus', label: 'Qwen Plus (即将推出)' },
		{ id: 'deepseek-v3', label: 'DeepSeek V3 (即将推出)' },
		{ id: 'deepseek-r1', label: 'DeepSeek R1 (即将推出)' },
	];

	private selectedAgent: string = WfmChatViewPane.AGENT_LIST[0].id;
	private selectedModel: string = WfmChatViewPane.MODEL_LIST[0].id;

	private sessions: IWfmChatSession[] = [];
	private activeSessionId: string = '';
	private readonly memento: Memento<IWfmChatSessionsState>;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IWfmAgentClientService private readonly agentClient: IWfmAgentClientService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.memento = new Memento(STORAGE_KEY, this.storageService);

		this._register(this.storageService.onWillSaveState(() => {
			this.persistSessions();
			this.memento.saveMemento();
		}));

		this._register(this.agentClient.onExternalChatSubmission(submission => {
			void this.runChat({
				text: submission.message,
				extras: submission.extras,
				originLabel: submission.originLabel,
			});
		}));

		this._register(this.agentClient.onExternalChatPrefill(text => {
			if (this.inputEl) {
				this.inputEl.value = text;
				this.inputEl.focus();
			}
		}));

		this._register(this.agentClient.onExternalChatAttach(files => {
			for (const f of files) {
				this.addAttachment(f);
			}
			if (this.inputEl) {
				this.inputEl.focus();
			}
		}));
	}

	protected override renderHeaderTitle(container: HTMLElement, _title: string): void {
		// Intentionally empty: ViewPane header is hidden when merged with
		// container (mergeViewWithContainerWhenSingleView). The tab strip
		// and action buttons are rendered inside the body instead.
	}

	private async openWfmSettings(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return;
		}
		const root = folders[0].uri;
		const settingsDir = URI.joinPath(root, '.wfm');
		const settingsUri = URI.joinPath(settingsDir, 'settings.json');

		try {
			const exists = await this.fileService.exists(settingsUri);
			if (!exists) {
				await this.fileService.createFolder(settingsDir);
				const defaultSettings = JSON.stringify({
					baseUrl: 'https://api.openai.com/v1',
					apiKey: '',
					model: 'gpt-4.1-mini',
				}, null, 2) + '\n';
				await this.fileService.writeFile(settingsUri, VSBuffer.fromString(defaultSettings));
			}
			await this.openerService.open(settingsUri, { fromUserGesture: true });
		} catch (err) {
			this.logService.warn(`[wfm] failed to open settings: ${err}`);
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.rootEl = dom.append(container, $('.wfm-chat-pane'));

		this.statusEl = dom.append(this.rootEl, $('.wfm-chat-status'));
		this.statusEl.textContent = localize('wfm.chat.status.idle', "正在检测后端…");
		void this.refreshStatus();

		// ── Session tab strip (inside body, not header) ──
		this.tabStripEl = dom.append(this.rootEl, $('.wfm-chat-header-tabs'));

		const newTabBtn = dom.append(this.tabStripEl, $('button.wfm-chat-tab-new')) as HTMLButtonElement;
		newTabBtn.type = 'button';
		newTabBtn.textContent = '+';
		newTabBtn.title = localize('wfm.chat.newTab.tooltip', '新建对话');
		// VS Code 的 PaneView 在 mousedown 阶段会拦截事件 (拖拽/折叠), click 也会冒泡到外层；
		// 这两个 button 必须自己 stopPropagation, 否则点击事件被吞掉看不到反应。
		this._register(dom.addDisposableListener(newTabBtn, 'mousedown', (e: MouseEvent) => {
			e.stopPropagation();
		}));
		this._register(dom.addDisposableListener(newTabBtn, 'click', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this.createSession();
			this.inputEl?.focus();
		}));

		const settingsBtn = dom.append(this.tabStripEl, $('button.wfm-chat-tab-settings')) as HTMLButtonElement;
		settingsBtn.type = 'button';
		settingsBtn.textContent = '⚙';
		settingsBtn.title = localize('wfm.chat.settings.tooltip', '打开 WFM 设置');
		this._register(dom.addDisposableListener(settingsBtn, 'mousedown', (e: MouseEvent) => {
			e.stopPropagation();
		}));
		this._register(dom.addDisposableListener(settingsBtn, 'click', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this.openWfmSettings();
		}));

		this.messagesEl = dom.append(this.rootEl, $('.wfm-chat-messages'));

		const composer = dom.append(this.rootEl, $('.wfm-chat-composer'));

		this.attachmentsEl = dom.append(composer, $('.wfm-chat-attachments'));
		this.attachmentsEl.style.display = 'none';

		// ── Cursor-style rounded input container ──
		const inputContainer = dom.append(composer, $('.wfm-chat-input-container'));

		this.inputEl = dom.append(inputContainer, $('textarea.wfm-chat-input')) as HTMLTextAreaElement;
		this.inputEl.placeholder = localize('wfm.chat.placeholder', "描述当前任务… (Enter 发送, Shift+Enter 换行)");
		this.inputEl.rows = 2;

		// Bottom toolbar inside the rounded container
		const toolbar = dom.append(inputContainer, $('.wfm-chat-toolbar'));

		// Left side: Agent + Model selectors
		const toolbarLeft = dom.append(toolbar, $('.wfm-chat-toolbar-left'));

		this.agentSelector = dom.append(toolbarLeft, $('button.wfm-chat-selector.wfm-chat-agent-selector')) as HTMLButtonElement;
		dom.append(this.agentSelector, $('span.selector-icon')).textContent = '∞';
		dom.append(this.agentSelector, $('span.selector-label'));
		dom.append(this.agentSelector, $('span.selector-chevron')).textContent = '▾';
		this.updateAgentLabel();
		this._register(dom.addDisposableListener(this.agentSelector, 'click', (e) => {
			e.stopPropagation();
			this.showAgentPicker(this.agentSelector!);
		}));

		this.modelSelector = dom.append(toolbarLeft, $('button.wfm-chat-selector.wfm-chat-model-selector')) as HTMLButtonElement;
		dom.append(this.modelSelector, $('span.selector-icon')).textContent = '⚙';
		dom.append(this.modelSelector, $('span.selector-label'));
		dom.append(this.modelSelector, $('span.selector-chevron')).textContent = '▾';
		this.updateModelLabel();
		this._register(dom.addDisposableListener(this.modelSelector, 'click', (e) => {
			e.stopPropagation();
			this.showModelPicker(this.modelSelector!);
		}));

		// Right side: Mic + Send
		const toolbarRight = dom.append(toolbar, $('.wfm-chat-toolbar-right'));

		this.micButton = dom.append(toolbarRight, $('button.wfm-chat-mic')) as HTMLButtonElement;
		this.micButton.textContent = '\u{1F3A4}';
		this.micButton.title = localize('wfm.chat.mic.tooltip', "语音输入");

		this.sendButton = dom.append(toolbarRight, $('button.wfm-chat-send')) as HTMLButtonElement;
		this.sendButton.textContent = '↑';
		this.sendButton.title = localize('wfm.chat.send.tooltip', "发送");

		this._register(dom.addDisposableListener(this.sendButton, 'click', () => this.onSend()));
		this._register(dom.addDisposableListener(this.inputEl, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
				e.preventDefault();
				this.onSend();
			}
		}));

		this.loadSessions();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.rootEl) {
			this.rootEl.style.height = `${height}px`;
			this.rootEl.style.width = `${width}px`;
		}
	}

	// ── Session lifecycle ────────────────────────────────────────────────

	private getActiveSession(): IWfmChatSession | undefined {
		return this.sessions.find(s => s.id === this.activeSessionId);
	}

	private createSession(): IWfmChatSession {
		const session: IWfmChatSession = {
			id: generateUuid(),
			backendSessionId: undefined,
			title: localize('wfm.chat.newTab', "新对话"),
			messages: [],
			createdAt: new Date().toISOString(),
		};
		this.sessions.push(session);
		this.activeSessionId = session.id;
		this.renderTabBar();
		this.renderMessages();
		this.persistSessions();
		return session;
	}

	private switchToSession(sessionId: string): void {
		if (this.activeSessionId === sessionId) {
			return;
		}
		if (this.pendingCts) {
			this.pendingCts.dispose(true);
			this.pendingCts = undefined;
			this.setBusy(false);
		}
		this.activeSessionId = sessionId;
		this.renderTabBar();
		this.renderMessages();
		this.persistSessions();
	}

	private closeSession(sessionId: string): void {
		const idx = this.sessions.findIndex(s => s.id === sessionId);
		if (idx === -1) {
			return;
		}
		this.sessions.splice(idx, 1);
		if (this.sessions.length === 0) {
			this.createSession();
			return;
		}
		if (this.activeSessionId === sessionId) {
			const newIdx = Math.min(idx, this.sessions.length - 1);
			this.activeSessionId = this.sessions[newIdx].id;
		}
		this.renderTabBar();
		this.renderMessages();
		this.persistSessions();
	}

	private autoTitleIfNeeded(session: IWfmChatSession, text: string): void {
		const defaultTitle = localize('wfm.chat.newTab', "新对话");
		if (session.title === defaultTitle && text.trim()) {
			session.title = text.length > 20 ? text.substring(0, 20) + '…' : text;
		}
	}

	// ── Persistence ──────────────────────────────────────────────────────

	private loadSessions(): void {
		const state = this.memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE) as Partial<IWfmChatSessionsState>;
		if (state?.sessions?.length) {
			this.sessions = state.sessions;
			this.activeSessionId = state.activeSessionId ?? this.sessions[0].id;
			if (!this.sessions.find(s => s.id === this.activeSessionId)) {
				this.activeSessionId = this.sessions[0].id;
			}
		} else {
			this.createSession();
			return;
		}
		this.renderTabBar();
		this.renderMessages();
	}

	private persistSessions(): void {
		const state: IWfmChatSessionsState = {
			sessions: this.sessions,
			activeSessionId: this.activeSessionId,
		};
		const mementoObj = this.memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE);
		Object.assign(mementoObj, state);
	}

	override saveState(): void {
		this.persistSessions();
		super.saveState();
	}

	// ── Tab bar rendering ────────────────────────────────────────────────

	private renderTabBar(): void {
		if (!this.tabStripEl) {
			return;
		}
		this.tabBarDisposables.clear();

		// Preserve "+" and settings buttons (they are the last two children)
		const children = Array.from(this.tabStripEl.children);
		const newBtn = children.find(c => c.classList.contains('wfm-chat-tab-new'));
		const settingsBtn = children.find(c => c.classList.contains('wfm-chat-tab-settings'));
		dom.clearNode(this.tabStripEl);

		for (const session of this.sessions) {
			const tab = dom.append(this.tabStripEl, $('div.wfm-chat-tab'));
			tab.classList.toggle('active', session.id === this.activeSessionId);
			const label = dom.append(tab, $('span.wfm-chat-tab-label'));
			label.textContent = session.title;

			if (this.sessions.length > 1) {
				const closeBtn = dom.append(tab, $('span.wfm-chat-tab-close'));
				closeBtn.textContent = '×';
				this.tabBarDisposables.add(dom.addDisposableListener(closeBtn, 'mousedown', (e) => {
					e.stopPropagation();
				}));
				this.tabBarDisposables.add(dom.addDisposableListener(closeBtn, 'click', (e) => {
					e.preventDefault();
					e.stopPropagation();
					this.closeSession(session.id);
				}));
			}

			this.tabBarDisposables.add(dom.addDisposableListener(tab, 'mousedown', (e) => {
				e.stopPropagation();
			}));
			this.tabBarDisposables.add(dom.addDisposableListener(tab, 'click', (e) => {
				e.stopPropagation();
				this.switchToSession(session.id);
			}));
		}

		if (newBtn) {
			this.tabStripEl.appendChild(newBtn);
		}
		if (settingsBtn) {
			this.tabStripEl.appendChild(settingsBtn);
		}
	}

	// ── Message rendering ────────────────────────────────────────────────

	private renderMessages(): void {
		if (!this.messagesEl) {
			return;
		}
		dom.clearNode(this.messagesEl);
		const session = this.getActiveSession();
		if (!session) {
			return;
		}
		for (const entry of session.messages) {
			this.renderSingleMessage(entry);
		}
	}

	private appendMessage(entry: IMessageEntry): void {
		const session = this.getActiveSession();
		if (!session) {
			return;
		}
		session.messages.push(entry);
		if (entry.role === 'user') {
			this.autoTitleIfNeeded(session, entry.content);
			this.renderTabBar();
		}
		this.renderSingleMessage(entry);
		this.persistSessions();
	}

	private renderSingleMessage(entry: IMessageEntry): void {
		if (!this.messagesEl) {
			return;
		}

		const cls = `wfm-msg wfm-msg-${entry.role}`;
		const item = dom.append(this.messagesEl, $(`div.${cls.split(' ').join('.')}`));
		const header = dom.append(item, $('.wfm-msg-role'));
		header.textContent = this.roleLabel(entry.role);
		const body = dom.append(item, $('div.wfm-msg-body'));
		body.textContent = entry.content;
		if (entry.role === 'user' && entry.originLabel) {
			const meta = dom.append(item, $('div.wfm-msg-origin'));
			meta.textContent = localize(
				'wfm.chat.originMeta',
				"来自: {0}",
				entry.originLabel,
			);
		}
		if (entry.role === 'user' && entry.attachments?.length) {
			const attContainer = dom.append(item, $('div.wfm-msg-attachments'));
			for (const att of entry.attachments) {
				const tag = dom.append(attContainer, $('span.wfm-msg-att-item'));
				tag.textContent = att.relPath ?? att.name;
			}
		}
		if (entry.role === 'assistant' && entry.workspacePath) {
			const meta = dom.append(item, $('div.wfm-msg-ws'));
			meta.textContent = localize(
				'wfm.chat.workspaceMeta',
				"工作区: {0}",
				entry.workspacePath,
			);
		}

		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	// ── Status / attachments / send pipeline ─────────────────────────────

	private async refreshStatus(): Promise<void> {
		if (!this.statusEl) {
			return;
		}
		const ok = await this.agentClient.ping();
		if (!this.statusEl) {
			return;
		}
		if (ok) {
			this.statusEl.textContent = localize(
				'wfm.chat.status.connected',
				"WFM Studio 后端已连接 {0}",
				this.agentClient.baseUrl,
			);
		} else {
			this.statusEl.textContent = localize(
				'wfm.chat.status.unreachable',
				"WFM Studio 后端未响应 ({0})",
				this.agentClient.baseUrl,
			);
		}
	}

	private addAttachment(file: IWfmFileAttachment): void {
		if (this.attachments.some(a => a.uri === file.uri)) {
			return;
		}
		this.attachments.push(file);
		this.renderAttachments();
	}

	private removeAttachment(index: number): void {
		if (index >= 0 && index < this.attachments.length) {
			this.attachments.splice(index, 1);
			this.renderAttachments();
		}
	}

	private renderAttachments(): void {
		if (!this.attachmentsEl) {
			return;
		}
		dom.clearNode(this.attachmentsEl);

		if (this.attachments.length === 0) {
			this.attachmentsEl.style.display = 'none';
			return;
		}
		this.attachmentsEl.style.display = 'flex';

		this.attachments.forEach((att, i) => {
			const tag = dom.append(this.attachmentsEl!, $('.wfm-attachment-tag'));
			const name = dom.append(tag, $('span.name'));
			name.textContent = att.relPath ?? att.name;
			const remove = dom.append(tag, $('span.remove'));
			remove.textContent = '×';
			this._register(dom.addDisposableListener(remove, 'click', () => {
				this.removeAttachment(i);
			}));
		});
	}

	private async onSend(): Promise<void> {
		if (!this.inputEl) {
			return;
		}
		const text = this.inputEl.value.trim();
		if (!text && this.attachments.length === 0) {
			return;
		}
		this.inputEl.value = '';

		const currentAttachments = [...this.attachments];
		this.attachments.length = 0;
		this.renderAttachments();

		await this.runChat({ text, attachments: currentAttachments });
	}

	private async runChat(args: {
		readonly text: string;
		readonly extras?: IWfmChatExtras;
		readonly originLabel?: string;
		readonly attachments?: IWfmFileAttachment[];
	}): Promise<void> {
		const text = args.text.trim();
		if (!text && (!args.attachments || args.attachments.length === 0)) {
			return;
		}
		if (this.pendingCts) {
			return;
		}

		const session = this.getActiveSession();
		if (!session) {
			return;
		}

		const extras: IWfmChatExtras = {
			...args.extras,
			...(args.attachments?.length ? { attachments: args.attachments } : {}),
		};

		const displayText = text || `\u{1F4CE} ${args.attachments?.map(a => a.name).join(', ')}`;

		this.appendMessage({
			role: 'user',
			content: displayText,
			originLabel: args.originLabel,
			attachments: args.attachments,
		});
		this.setBusy(true);

		const cts = new CancellationTokenSource();
		this.pendingCts = cts;

		const handle = this.createStreamingAssistantMessage();
		let streamedDone = false;

		try {
			await this.agentClient.chatStream(
				text || '(附件文件)',
				extras,
				cts.token,
				session.backendSessionId,
				{
					onSession: (sid) => {
						if (sid && !session.backendSessionId) {
							session.backendSessionId = sid;
							this.persistSessions();
						}
					},
					onTextDelta: (delta) => {
						handle.appendText(delta);
						handle.scrollToBottom();
					},
					onToolCallStarted: (id, name) => {
						handle.addToolStep(id, name);
						handle.scrollToBottom();
					},
					onToolCallDone: (id) => {
						handle.completeToolStep(id);
					},
					onAgentHandoff: (agent) => {
						handle.addHandoffStep(agent);
						handle.scrollToBottom();
					},
					onDone: (sid, finalText) => {
						streamedDone = true;
						if (sid && !session.backendSessionId) {
							session.backendSessionId = sid;
							this.persistSessions();
						}
						handle.finalize(finalText);
						const stepItems = handle.activityEl.querySelectorAll('.wfm-activity-item');
						this.appendMessage({
							role: 'assistant',
							content: finalText,
							activitySummary: stepItems.length > 0 ? `${stepItems.length} 步完成` : undefined,
						});
						handle.rootEl.remove();
					},
					onError: (error) => {
						handle.showError(error);
						this.logService.warn(`[wfm] chat stream error: ${error}`);
					},
				},
				this.selectedModel,
			);

			if (!streamedDone) {
				handle.rootEl.remove();
				this.logService.info('[wfm] stream ended without done event, falling back to sync');
				const reply = await this.agentClient.chat(
					text || '(附件文件)',
					extras,
					cts.token,
					session.backendSessionId,
				);
				if (reply.sessionId && !session.backendSessionId) {
					session.backendSessionId = reply.sessionId;
					this.persistSessions();
				}
				this.appendMessage({
					role: 'assistant',
					content: reply.content,
					workspacePath: reply.workspaceRoot,
				});
			}
		} catch (err) {
			if (!streamedDone && handle.rootEl.isConnected) {
				handle.rootEl.remove();
			}
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[wfm] chat failed: ${msg}`);
			this.appendMessage({ role: 'error', content: msg });
		} finally {
			cts.dispose();
			if (this.pendingCts === cts) {
				this.pendingCts = undefined;
			}
			this.setBusy(false);
			void this.refreshStatus();
		}
	}

	private setBusy(busy: boolean): void {
		if (this.sendButton) {
			this.sendButton.disabled = busy;
			dom.clearNode(this.sendButton);
			if (busy) {
				dom.append(this.sendButton, $('span.send-spinner'));
			} else {
				this.sendButton.textContent = '↑';
			}
		}
		if (this.inputEl) {
			this.inputEl.disabled = busy;
		}
	}

	// ── Agent / Model selectors ──────────────────────────────────────────

	private updateAgentLabel(): void {
		if (!this.agentSelector) { return; }
		const label = this.agentSelector.querySelector('.selector-label');
		const item = WfmChatViewPane.AGENT_LIST.find(a => a.id === this.selectedAgent);
		if (label) { label.textContent = item?.label ?? this.selectedAgent; }
	}

	private updateModelLabel(): void {
		if (!this.modelSelector) { return; }
		const label = this.modelSelector.querySelector('.selector-label');
		const item = WfmChatViewPane.MODEL_LIST.find(m => m.id === this.selectedModel);
		if (label) { label.textContent = item?.label ?? this.selectedModel; }
	}

	private showAgentPicker(anchor: HTMLElement): void {
		this.showSelectorPicker(anchor, WfmChatViewPane.AGENT_LIST, this.selectedAgent, (id) => {
			this.selectedAgent = id;
			this.updateAgentLabel();
		});
	}

	private showModelPicker(anchor: HTMLElement): void {
		this.showSelectorPicker(anchor, WfmChatViewPane.MODEL_LIST, this.selectedModel, (id) => {
			this.selectedModel = id;
			this.updateModelLabel();
		});
	}

	private showSelectorPicker(
		anchor: HTMLElement,
		items: readonly { readonly id: string; readonly label: string }[],
		currentId: string,
		onSelect: (id: string) => void,
	): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => items.map(item => ({
				id: item.id,
				label: item.label,
				tooltip: '',
				class: undefined,
				enabled: true,
				checked: item.id === currentId,
				run: () => { onSelect(item.id); return Promise.resolve(); },
				dispose: () => { },
			})),
			getActionsContext: () => undefined,
		});
	}

	// ── Streaming message handle ─────────────────────────────────────────

	private createStreamingAssistantMessage(): IStreamingMessageHandle {
		if (!this.messagesEl) {
			throw new Error('messagesEl not initialized');
		}

		const msgEl = dom.append(this.messagesEl, $('div.wfm-msg.wfm-msg-assistant.wfm-msg-streaming'));
		const roleEl = dom.append(msgEl, $('.wfm-msg-role'));
		roleEl.textContent = this.roleLabel('assistant');
		const activityEl = dom.append(msgEl, $('.wfm-msg-activity'));
		const bodyEl = dom.append(msgEl, $('div.wfm-msg-body'));

		this.scrollToBottom();

		const pendingToolSteps = new Map<string, HTMLElement>();
		const messagesEl = this.messagesEl;

		return {
			rootEl: msgEl,
			activityEl,
			bodyEl,

			appendText(delta: string): void {
				bodyEl.textContent = (bodyEl.textContent ?? '') + delta;
			},

			addHandoffStep(agent: string): void {
				const step = dom.append(activityEl, $('div.wfm-activity-item.wfm-activity-handoff'));
				const icon = dom.append(step, $('span.codicon.codicon-arrow-right'));
				icon.textContent = '→';
				const label = dom.append(step, $('span.wfm-activity-label'));
				label.textContent = `调用 Agent: ${AGENT_DISPLAY_NAMES[agent] ?? agent}`;
			},

			addToolStep(id: string, name: string): void {
				const displayName = TOOL_DISPLAY_NAMES[name] ?? name;
				const step = dom.append(activityEl, $('div.wfm-activity-item.wfm-activity-tool-start'));
				step.dataset.toolCallId = id;
				dom.append(step, $('span.codicon.codicon-loading'));
				const label = dom.append(step, $('span.wfm-activity-label'));
				label.textContent = `${displayName}...`;
				pendingToolSteps.set(id, step);
			},

			completeToolStep(id: string): void {
				const step = pendingToolSteps.get(id);
				if (!step) { return; }
				step.classList.remove('wfm-activity-tool-start');
				step.classList.add('wfm-activity-tool-done');
				const icon = step.querySelector('.codicon');
				if (icon) {
					icon.classList.remove('codicon-loading');
					icon.classList.add('codicon-check');
				}
				const label = step.querySelector('.wfm-activity-label');
				if (label?.textContent) {
					label.textContent = label.textContent.replace(/\.\.\.+$/, ' ✓');
				}
				pendingToolSteps.delete(id);
			},

			finalize(text: string): void {
				msgEl.classList.remove('wfm-msg-streaming');
				if (text) {
					bodyEl.textContent = text;
				}
				const steps = activityEl.children;
				const count = steps.length;
				if (count > 0) {
					activityEl.classList.add('wfm-activity-collapsed');
					const stepsContainer = $('div.wfm-activity-steps');
					while (activityEl.firstChild) {
						stepsContainer.appendChild(activityEl.firstChild);
					}
					dom.append(activityEl, stepsContainer);
					const summary = dom.prepend(activityEl, $('div.wfm-activity-summary'));
					summary.textContent = `${count} 步完成`;
					msgEl.onclick = () => activityEl.classList.toggle('expanded');
				} else {
					activityEl.remove();
				}
			},

			showError(error: string): void {
				msgEl.classList.remove('wfm-msg-streaming');
				msgEl.classList.add('wfm-msg-error');
				roleEl.textContent = '错误';
				bodyEl.textContent = error;
				activityEl.remove();
			},

			scrollToBottom(): void {
				if (messagesEl) {
					messagesEl.scrollTop = messagesEl.scrollHeight;
				}
			},
		};
	}

	private scrollToBottom(): void {
		if (this.messagesEl) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}

	private roleLabel(role: WfmRole): string {
		switch (role) {
			case 'user':
				return localize('wfm.chat.role.user', "你");
			case 'assistant':
				return localize('wfm.chat.role.assistant', "WFM Studio");
			case 'error':
				return localize('wfm.chat.role.error', "错误");
		}
	}

	override dispose(): void {
		this.pendingCts?.dispose(true);
		this.pendingCts = undefined;
		super.dispose();
	}

	static readonly ICON = Codicon.commentDiscussion;
}
