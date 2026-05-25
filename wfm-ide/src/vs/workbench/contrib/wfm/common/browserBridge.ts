/*---------------------------------------------------------------------------------------------
 *  WFM Studio — Browser bridge service.
 *
 *  Renderer-side service that turns "browser_*" requests coming from the main
 *  process (BrowserApiServer → Python MCP → claude CLI) into the same calls
 *  the upstream agentic browser tools use:
 *    - IPlaywrightService for the actual page automation
 *    - IEditorService     to surface the page as a BrowserEditorInput tab in
 *                         the main editor area (so users can see the page and
 *                         interact manually — e.g. type CAPTCHA codes — while
 *                         the AI is driving).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const WFM_BROWSER_BRIDGE_CHANNEL = 'wfmBrowserBridge';

export interface IBrowserBridgePageElement {
	readonly selector: string;
	readonly tag: string;
	readonly type: string;
	/** Visible label (textContent for buttons / links). */
	readonly text: string;
	/** Current `.value` for input-like elements; empty otherwise. */
	readonly value?: string;
	/** Placeholder text — kept separate from `text` so Agents don't mistake it for a filled value. */
	readonly placeholder?: string;
	/** True iff the element is rendered + not display:none / visibility:hidden / size 0. */
	readonly visible?: boolean;
}

export interface IBrowserBridgePageContent {
	readonly body: string;
	readonly elements: readonly IBrowserBridgePageElement[];
}

export interface IBrowserBridgePageInfo {
	readonly pageId: string;
	readonly url: string;
	readonly title: string;
	readonly content: IBrowserBridgePageContent;
}

export interface IBrowserBridgeReadResult {
	readonly url: string;
	readonly title: string;
	readonly content: IBrowserBridgePageContent;
}

export interface IBrowserBridgePageSummary {
	readonly pageId: string;
	readonly url: string;
	readonly title: string;
	/**
	 * True if this page is the active editor in its group right now (i.e.
	 * the user is currently looking at it, assuming the group has focus).
	 * Useful for the AI to confirm "the tab I'm operating on is the one
	 * the user sees".
	 */
	readonly isActive: boolean;
}

export const IBrowserBridgeService = createDecorator<IBrowserBridgeService>('wfmBrowserBridgeService');

export interface IBrowserBridgeService {
	readonly _serviceBrand: undefined;

	/**
	 * @param reuseExisting when true (default), if an open tab already points
	 * at `url`, return that tab's pageId and re-navigate it to `url` (which
	 * acts as a reload); avoids the "Agent opens 3 zombie tabs of the same
	 * site" failure mode.
	 */
	open(url: string, reuseExisting?: boolean): Promise<IBrowserBridgePageInfo>;
	list(): Promise<{ pages: IBrowserBridgePageSummary[] }>;
	navigate(pageId: string, url: string): Promise<{ url: string }>;
	read(pageId: string): Promise<IBrowserBridgeReadResult>;
	screenshot(pageId: string): Promise<{ image: string }>;
	click(pageId: string, selector: string, element: string): Promise<{ ok: true }>;
	clickNative(pageId: string, selector: string, element: string): Promise<{ ok: true }>;
	type(pageId: string, selector: string, text: string, element: string): Promise<{ ok: true }>;
	typeNative(pageId: string, selector: string, text: string, element: string): Promise<{ ok: true }>;
	hover(pageId: string, selector: string, element: string): Promise<{ ok: true }>;
	dialog(pageId: string, accept: boolean, promptText: string): Promise<{ ok: true }>;
	close(pageId: string): Promise<{ ok: true }>;
}
