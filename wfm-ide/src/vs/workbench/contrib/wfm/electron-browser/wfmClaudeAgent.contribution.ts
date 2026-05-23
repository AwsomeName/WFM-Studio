/*---------------------------------------------------------------------------------------------
 *  WFM Studio — Claude Code chat agent contribution.
 *
 *  Registers a core, default chat agent that proxies the upstream ChatUI to a
 *  local `claude` CLI subprocess (via IWfmClaudeService → main process).
 *
 *  This is the *only* default chat agent in WFM Studio; we deliberately do not
 *  rely on GitHub Copilot or any cloud login. The setup-related context keys
 *  are also force-bound here so the upstream ChatSetup gates resolve to "ready"
 *  without a chat extension installed.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWfmClaudeEvent, IWfmClaudeService } from '../../../../platform/wfmClaude/common/wfmClaude.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import {
	IChatAgentData,
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	IChatAgentService,
} from '../../chat/common/participants/chatAgents.js';
import { IChatRequestVariableEntry, isImplicitVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import {
	IChatMarkdownContent,
	IChatProgress,
	IChatThinkingPart,
	IChatToolInvocationSerialized,
	ToolConfirmKind,
} from '../../chat/common/chatService/chatService.js';
import { ToolDataSource } from '../../chat/common/tools/languageModelToolsService.js';

const WFM_PUBLISHER = 'wfm';
const WFM_EXTENSION_DISPLAY = 'WFM Studio';
const WFM_EXTENSION_ID = new ExtensionIdentifier('wfm.studio.core');

/** One agent per chat mode. Same impl underneath. */
const AGENT_DEFS: Array<{ id: string; mode: ChatModeKind; fullName: string }> = [
	{ id: 'wfm.claude.ask', mode: ChatModeKind.Ask, fullName: 'WFM Claude (Ask)' },
	{ id: 'wfm.claude.edit', mode: ChatModeKind.Edit, fullName: 'WFM Claude (Edit)' },
	{ id: 'wfm.claude.agent', mode: ChatModeKind.Agent, fullName: 'WFM Claude (Agent)' },
];

export class WfmClaudeAgentContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.wfmClaudeAgent';

	constructor(
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IWfmClaudeService private readonly claudeService: IWfmClaudeService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._bypassChatSetupGates();
		this._registerAgents();
	}

	/**
	 * Forces the chat-setup context keys to a "ready" state so the upstream
	 * ChatViewPane renders without nagging the user to install/sign in.
	 *
	 * These are best-effort overrides; if the upstream ChatSetupContribution
	 * later flips them back we just re-apply on next request via _ensureBypass.
	 */
	private _bypassChatSetupGates(): void {
		const ctx = this.contextKeyService;
		ChatContextKeys.Setup.completed.bindTo(ctx).set(true);
		ChatContextKeys.Setup.hidden.bindTo(ctx).set(false);
		ChatContextKeys.Setup.disabled.bindTo(ctx).set(false);
		ChatContextKeys.Setup.disabledInWorkspace.bindTo(ctx).set(false);
		ChatContextKeys.Setup.untrusted.bindTo(ctx).set(false);
		ChatContextKeys.Entitlement.signedOut.bindTo(ctx).set(false);
		// installed=true so any "install extension" prompts disappear. We are
		// the "installed" chat experience.
		ChatContextKeys.Setup.installed.bindTo(ctx).set(true);
		// Upstream only flips `chatIsEnabled` inside `registerAgentImplementation`,
		// but we register via `registerDynamicAgent` which never touches it.
		// Without this, the title-bar menu items "New Chat" / "New Chat Editor"
		// / "New Chat Window" stay greyed out (their precondition is
		// `ChatContextKeys.enabled`) and the history (`workbench.action.chat.history`)
		// button doesn't render in the chat view title.
		ChatContextKeys.enabled.bindTo(ctx).set(true);
	}

	private _registerAgents(): void {
		for (const def of AGENT_DEFS) {
			const data: IChatAgentData = {
				id: def.id,
				name: def.id,
				fullName: def.fullName,
				description: localize('wfmClaudeAgent.description', "WFM Studio local chat assistant powered by Claude Code CLI"),
				extensionId: WFM_EXTENSION_ID,
				extensionVersion: '1.0.0',
				extensionPublisherId: WFM_PUBLISHER,
				extensionDisplayName: WFM_EXTENSION_DISPLAY,
				publisherDisplayName: WFM_EXTENSION_DISPLAY,
				isDefault: true,
				isCore: true,
				isDynamic: true,
				metadata: {
					themeIcon: Codicon.sparkle,
					// isSticky 故意不开：WFM 只有一个默认 agent，sticky 回填会在每次发送
					// 后把输入框重置成 `@wfm.claude.agent `，纯噪音，还会扰乱光标。
					// 触发点：chatInputEditorContrib.ts InputEditorSlashCommandMode.repopulateAgentCommand
					isSticky: false,
				},
				slashCommands: [],
				locations: [ChatAgentLocation.Chat],
				modes: [def.mode],
				disambiguation: [],
			};

			const impl: IChatAgentImplementation = {
				invoke: (request, progress, history, token) =>
					this._invoke(request, progress, history, token),
			};

			this._register(this.chatAgentService.registerDynamicAgent(data, impl));
		}
	}

	private async _invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: ReadonlyArray<{ result: IChatAgentResult }>,
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		// Re-apply ctx keys on every turn — defensive in case other contributions reset them.
		this._bypassChatSetupGates();

		const workspaceRoot = this._resolveWorkspaceRoot();
		if (!workspaceRoot) {
			progress([this._md('请先打开一个工作区文件夹后再使用对话功能。')]);
			return { errorDetails: { message: 'No workspace folder open.' } };
		}

		const previousSessionId = this._lastSessionIdFromHistory(history);
		const turnId = generateUuid();

		const pendingTools = new Map<string, { toolName: string; toolInput: string }>();
		let assistantStarted = false;
		let resolvedSessionId: string | undefined = previousSessionId;

		const completed = new Promise<IChatAgentResult>((resolve) => {
			const sub: IDisposable = this.claudeService.onEvent((evt: IWfmClaudeEvent) => {
				if (evt.turnId !== turnId) {
					return;
				}

				switch (evt.kind) {
					case 'session':
						resolvedSessionId = evt.sessionId;
						break;
					case 'thinking_delta':
						if (evt.delta) {
							progress([{ kind: 'thinking', value: evt.delta } satisfies IChatThinkingPart]);
						}
						break;
					case 'text_delta':
						if (evt.delta) {
							assistantStarted = true;
							progress([this._md(evt.delta)]);
						}
						break;
					case 'tool_started':
						pendingTools.set(evt.toolCallId, { toolName: evt.toolName, toolInput: evt.toolInput });
						break;
					case 'tool_done': {
						const meta = pendingTools.get(evt.toolCallId);
						if (meta) {
							progress([this._toolInvocationSerialized(evt.toolCallId, meta.toolName, meta.toolInput, evt.outputSummary)]);
							pendingTools.delete(evt.toolCallId);
						}
						break;
					}
					case 'done':
						if (evt.sessionId) {
							resolvedSessionId = evt.sessionId;
						}
						if (!assistantStarted && evt.finalText) {
							progress([this._md(evt.finalText)]);
						}
						sub.dispose();
						resolve({
							metadata: resolvedSessionId ? { claudeSessionId: resolvedSessionId } : undefined,
						});
						break;
					case 'error':
						sub.dispose();
						progress([this._md(`\n\n**[claude error]** ${evt.message}`)]);
						resolve({ errorDetails: { message: evt.message } });
						break;
				}
			});

			const cancelSub = token.onCancellationRequested(() => {
				cancelSub.dispose();
				this.claudeService.cancelTurn(turnId).catch((err) =>
					this.logService.warn(`[wfm-claude-agent] cancelTurn failed: ${err}`),
				);
			});

			this.claudeService.runTurn({
				turnId,
				prompt: this._stitchAttachments(request, workspaceRoot),
				workspaceRoot,
				sessionId: previousSessionId,
				model: request.userSelectedModelId,
			}).catch((err) => {
				sub.dispose();
				const msg = err instanceof Error ? err.message : String(err);
				progress([this._md(`\n\n**[wfm-claude]** 无法启动本地 claude CLI: ${msg}\n请确认 \`claude\` 命令在 PATH 中。`)]);
				resolve({ errorDetails: { message: msg } });
			});
		});

		return completed;
	}

	/**
	 * Convert chat-UI attachments (files / directories / implicit current file)
	 * into Claude Code `@path` references and prepend them to the user prompt.
	 *
	 * Without this, the `claude` CLI never learns which file(s) the user pinned
	 * to the message, and ends up scanning the whole workspace via tool calls
	 * just to guess what "this document" refers to.
	 */
	private _stitchAttachments(request: IChatAgentRequest, workspaceRoot: string): string {
		const userText = request.message ?? '';
		const entries = request.variables?.variables ?? [];
		if (entries.length === 0) {
			return userText;
		}

		const wsUri = URI.file(workspaceRoot);
		// 同 (path, range) 组合去重；纯 path 也单独去重一次。
		const seenWithRange = new Set<string>();
		const refs: string[] = [];
		// docx 这种二进制文件，"行号"实际上是 webview 注入的段落 index；
		// 给 Claude 的 @path 后面单独跟一条人类语义的提示，agent 拿到能直接理解。
		const docxNotes: string[] = [];

		for (const entry of entries as readonly IChatRequestVariableEntry[]) {
			if (isImplicitVariableEntry(entry) && entry.enabled === false) {
				continue;
			}
			if (entry.kind !== 'file' && entry.kind !== 'directory' && entry.kind !== 'implicit') {
				continue;
			}
			const uri = IChatRequestVariableEntry.toUri(entry);
			if (!uri || uri.scheme !== 'file') {
				continue;
			}
			const rel = relativePath(wsUri, uri);
			// Workspace-relative when possible, else absolute; Claude Code resolves both.
			const refPath = rel ?? uri.fsPath;

			// range 仅在文件附件 + Location 形式 (value: { uri, range }) 时存在。
			const rawValue = (entry as { value?: unknown }).value as { range?: { startLineNumber?: number; endLineNumber?: number } } | undefined;
			const range = rawValue && typeof rawValue === 'object' && rawValue.range
				&& typeof rawValue.range.startLineNumber === 'number'
				&& typeof rawValue.range.endLineNumber === 'number'
				? { start: rawValue.range.startLineNumber, end: rawValue.range.endLineNumber }
				: undefined;

			const isDocx = /\.docx$/i.test(refPath);
			const dedupeKey = range ? `${refPath}#${range.start}-${range.end}` : refPath;
			if (seenWithRange.has(dedupeKey)) {
				continue;
			}
			seenWithRange.add(dedupeKey);

			const quote = (s: string) => /\s/.test(s) ? `"${s}"` : s;

			if (range && isDocx) {
				// docx：@路径不带 # 行号（避免 Claude 误以为是文本文件行号），
				// 用独立一行的语义提示告诉它"这是第 X-Y 段"。
				refs.push(`@${quote(refPath)}`);
				const label = range.start === range.end
					? `第 ${range.start} 段`
					: `第 ${range.start}-${range.end} 段`;
				docxNotes.push(`[Word 选区 · ${refPath} · ${label}]`);
			} else if (range) {
				// 文本类（dxf、源码、md …）：Claude Code CLI 接受 `@path#L3-L5` 行号语法。
				refs.push(`@${quote(refPath)}#L${range.start}-L${range.end}`);
			} else {
				refs.push(`@${quote(refPath)}`);
			}
		}

		if (refs.length === 0 && docxNotes.length === 0) {
			return userText;
		}
		const head = [refs.join(' '), ...docxNotes].filter(s => s.length > 0).join('\n');
		return `${head}\n\n${userText}`;
	}

	private _md(text: string): IChatMarkdownContent {
		return { kind: 'markdownContent', content: new MarkdownString(text, { supportHtml: true }) };
	}

	private _toolInvocationSerialized(
		toolCallId: string,
		toolName: string,
		toolInput: string,
		outputSummary: string,
	): IChatToolInvocationSerialized {
		return {
			kind: 'toolInvocationSerialized',
			toolCallId,
			toolId: toolName,
			source: ToolDataSource.Internal,
			invocationMessage: new MarkdownString(`\`${toolName}\``),
			originMessage: undefined,
			pastTenseMessage: new MarkdownString(`\`${toolName}\``),
			isConfirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
			isComplete: true,
			presentation: undefined,
			toolSpecificData: {
				kind: 'simpleToolInvocation',
				input: toolInput,
				output: outputSummary,
			},
		};
	}

	private _resolveWorkspaceRoot(): string | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		return folders[0].uri.fsPath;
	}

	private _lastSessionIdFromHistory(history: ReadonlyArray<{ result: IChatAgentResult }>): string | undefined {
		for (let i = history.length - 1; i >= 0; i--) {
			const meta = history[i].result?.metadata;
			const id = meta && typeof meta['claudeSessionId'] === 'string' ? meta['claudeSessionId'] as string : undefined;
			if (id) {
				return id;
			}
		}
		return undefined;
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(WfmClaudeAgentContribution, LifecyclePhase.Restored);
