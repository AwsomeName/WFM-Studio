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

/**
 * Inline image attachment (pasted into the chat input, dropped from clipboard,
 * or otherwise not yet on disk).
 *
 * Claude Code CLI doesn't have an "attach raw bytes" flag, but it does
 * resolve `@path` references — including image files — relative to the cwd.
 * The main service materialises these to a per-turn temp directory and
 * prepends `@<abs-path>` refs to the prompt, then cleans up on exit.
 *
 * NOTE: bytes are transported as base64 instead of `VSBuffer`/`Uint8Array`.
 * The vscode IPC `serialize()` only preserves binary types as top-level
 * values — anything nested inside an object (like `IWfmClaudeRunOptions`)
 * falls into the JSON.stringify branch, which turns a `Uint8Array` into
 * `{"0":137,"1":80,…}` on the receiving side. Base64 round-trips cleanly
 * through JSON and keeps the IPC contract a plain JSON-able object.
 */
export interface IWfmClaudeImageAttachment {
	/** Display name from the chat UI (e.g. "image.png" or "Pasted Image-…"). Used only to derive a sensible file extension fallback. */
	readonly name?: string;
	/** MIME type from the upstream attachment (e.g. `image/png`). May be empty if unknown. */
	readonly mimeType?: string;
	/** Raw image bytes, base64-encoded. See note above for why not VSBuffer. */
	readonly dataBase64: string;
}

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
	/**
	 * Inline image attachments pasted/dropped into the chat input that aren't
	 * yet on disk. The main service writes them to a per-turn temp dir and
	 * prepends `@<path>` refs to the prompt so Claude actually sees them.
	 */
	readonly images?: ReadonlyArray<IWfmClaudeImageAttachment>;
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
