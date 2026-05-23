/*---------------------------------------------------------------------------------------------
 *  WFM Studio — Claude Code CLI bridge service (interface).
 *
 *  Runs the locally installed `claude` CLI in stream-json mode and surfaces
 *  per-turn NDJSON events to the renderer. The renderer maps these events
 *  onto IChatProgress parts so the upstream Chat UI can render them.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IWfmClaudeService = createDecorator<IWfmClaudeService>('wfmClaudeService');

/** A single run of the claude CLI for one user turn. */
export interface IWfmClaudeRunOptions {
	/** Caller-side correlation id; main process echoes it back on every event. */
	readonly turnId: string;
	/** User prompt (text only; attachments are stitched in by caller). */
	readonly prompt: string;
	/** cwd for the claude process; also exposed to MCP server via env. */
	readonly workspaceRoot: string;
	/** Optional Claude session id (passed via --resume to continue a thread). */
	readonly sessionId?: string;
	/** Optional claude model id (`sonnet`, `opus`, …). Default: env / 'sonnet'. */
	readonly model?: string;
	/** Optional CAD source URI exposed to MCP server via env (cad_modify_colors etc.). */
	readonly cadSourceUri?: string;
}

/**
 * Events emitted by the main-process runner.
 *
 * Shapes mirror Claude Code's NDJSON output but flattened/translated for the
 * renderer so the renderer never has to parse `claude` formats.
 */
export type IWfmClaudeEvent =
	| { readonly turnId: string; readonly kind: 'session'; readonly sessionId: string }
	| { readonly turnId: string; readonly kind: 'thinking_delta'; readonly delta: string }
	| { readonly turnId: string; readonly kind: 'text_delta'; readonly delta: string }
	| {
		readonly turnId: string;
		readonly kind: 'tool_started';
		readonly toolCallId: string;
		readonly toolName: string;
		readonly toolInput: string;
	}
	| {
		readonly turnId: string;
		readonly kind: 'tool_done';
		readonly toolCallId: string;
		readonly outputSummary: string;
	}
	| {
		readonly turnId: string;
		readonly kind: 'done';
		readonly sessionId: string | undefined;
		readonly finalText: string;
	}
	| { readonly turnId: string; readonly kind: 'error'; readonly message: string };

export interface IWfmClaudeService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires for every NDJSON event from any active claude run.
	 * Subscribers filter by `event.turnId`.
	 */
	readonly onEvent: Event<IWfmClaudeEvent>;

	/**
	 * Starts a new claude turn. Resolves once the subprocess has been spawned
	 * (NOT when the turn completes). Real completion is delivered via the
	 * `done` event on `onEvent`.
	 *
	 * Throws if `claude` is not on PATH or workspaceRoot doesn't exist.
	 */
	runTurn(options: IWfmClaudeRunOptions): Promise<void>;

	/**
	 * Cancels an in-flight turn. SIGTERM then SIGKILL the underlying process.
	 * No-op if `turnId` is unknown.
	 */
	cancelTurn(turnId: string): Promise<void>;
}
