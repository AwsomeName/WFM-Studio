/*---------------------------------------------------------------------------------------------
 *  WFM Studio contributions.
 *--------------------------------------------------------------------------------------------*/

import './media/wfmChat.css';

import * as dom from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IWfmAgentClientService } from '../common/wfmAgentClient.js';

const $ = dom.$;

type WfmRole = 'user' | 'assistant' | 'error';

interface IMessageEntry {
	readonly role: WfmRole;
	readonly content: string;
	/** From chat reply: backend-resolved workspace (Step D 验收). */
	readonly workspacePath?: string;
}

export class WfmChatViewPane extends ViewPane {

	static readonly ID = 'workbench.view.wfm.aiChat';

	private rootEl: HTMLElement | undefined;
	private messagesEl: HTMLElement | undefined;
	private statusEl: HTMLElement | undefined;
	private inputEl: HTMLTextAreaElement | undefined;
	private sendButton: HTMLButtonElement | undefined;
	private readonly messages: IMessageEntry[] = [];
	private pendingCts: CancellationTokenSource | undefined;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.rootEl = dom.append(container, $('.wfm-chat-pane'));

		this.statusEl = dom.append(this.rootEl, $('.wfm-chat-status'));
		this.statusEl.textContent = localize('wfm.chat.status.idle', "未连接");
		void this.refreshStatus();

		this.messagesEl = dom.append(this.rootEl, $('.wfm-chat-messages'));

		const composer = dom.append(this.rootEl, $('.wfm-chat-composer'));
		this.inputEl = dom.append(composer, $('textarea.wfm-chat-input')) as HTMLTextAreaElement;
		this.inputEl.placeholder = localize('wfm.chat.placeholder', "说点什么 (Cmd/Ctrl+Enter 发送)");
		this.inputEl.rows = 3;

		const actions = dom.append(composer, $('.wfm-chat-actions'));
		this.sendButton = dom.append(actions, $('button.wfm-chat-send')) as HTMLButtonElement;
		this.sendButton.textContent = localize('wfm.chat.send', "发送");

		this._register(dom.addDisposableListener(this.sendButton, 'click', () => this.onSend()));
		this._register(dom.addDisposableListener(this.inputEl, 'keydown', (e: KeyboardEvent) => {
			// Cmd/Ctrl+Enter submits; plain Enter keeps newline for multi-line prompts.
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.onSend();
			}
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.rootEl) {
			this.rootEl.style.height = `${height}px`;
			this.rootEl.style.width = `${width}px`;
		}
	}

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
				"已连接 {0}",
				this.agentClient.baseUrl,
			);
		} else {
			this.statusEl.textContent = localize(
				'wfm.chat.status.unreachable',
				"后端未响应 ({0})",
				this.agentClient.baseUrl,
			);
		}
	}

	private async onSend(): Promise<void> {
		if (!this.inputEl || !this.sendButton) {
			return;
		}
		const text = this.inputEl.value.trim();
		if (!text) {
			return;
		}
		if (this.pendingCts) {
			return;
		}

		this.appendMessage({ role: 'user', content: text });
		this.inputEl.value = '';
		this.setBusy(true);

		const cts = new CancellationTokenSource();
		this.pendingCts = cts;
		try {
			const reply = await this.agentClient.chat(text, cts.token);
			this.appendMessage({
				role: 'assistant',
				content: reply.content,
				workspacePath: reply.workspaceRoot,
			});
		} catch (err) {
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
			this.sendButton.textContent = busy
				? localize('wfm.chat.sending', "发送中…")
				: localize('wfm.chat.send', "发送");
		}
		if (this.inputEl) {
			this.inputEl.disabled = busy;
		}
	}

	private appendMessage(entry: IMessageEntry): void {
		this.messages.push(entry);
		if (!this.messagesEl) {
			return;
		}

		const cls = `wfm-msg wfm-msg-${entry.role}`;
		const item = dom.append(this.messagesEl, $(`div.${cls.split(' ').join('.')}`));
		const header = dom.append(item, $('.wfm-msg-role'));
		header.textContent = this.roleLabel(entry.role);
		const body = dom.append(item, $('div.wfm-msg-body'));
		body.textContent = entry.content;
		if (entry.role === 'assistant' && entry.workspacePath) {
			const meta = dom.append(item, $('div.wfm-msg-ws'));
			meta.textContent = localize(
				'wfm.chat.workspaceMeta',
				"工作区: {0}",
				entry.workspacePath,
			);
		}

		// Auto-scroll to bottom; matches typical chat UX.
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private roleLabel(role: WfmRole): string {
		switch (role) {
			case 'user':
				return localize('wfm.chat.role.user', "你");
			case 'assistant':
				return localize('wfm.chat.role.assistant', "助手");
			case 'error':
				return localize('wfm.chat.role.error', "错误");
		}
	}

	override dispose(): void {
		this.pendingCts?.dispose(true);
		this.pendingCts = undefined;
		super.dispose();
	}

	// Referenced in contribution icon registration; kept for future use.
	static readonly ICON = Codicon.commentDiscussion;
}
