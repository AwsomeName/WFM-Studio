/*---------------------------------------------------------------------------------------------
 *  WFM Studio — IBrowserBridgeService implementation.
 *
 *  Bridges the BrowserApiServer (main process HTTP endpoint hit by the Python
 *  MCP server) onto the same Playwright + editor stack that the upstream
 *  browser tools (e.g. OpenBrowserTool, ClickBrowserTool, ...) use.
 *
 *  Critically: `open()` not only spins up a Playwright page but also opens a
 *  BrowserEditorInput in the active editor group, so the user actually *sees*
 *  the page in the main editor area and can interact with it manually (e.g.
 *  solve CAPTCHAs) while the AI is automating.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { EditorActivation } from '../../../../platform/editor/common/editor.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService, GroupsOrder } from '../../../services/editor/common/editorGroupsService.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import {
	IBrowserBridgeReadResult,
	IBrowserBridgePageContent,
	IBrowserBridgePageElement,
	IBrowserBridgePageInfo,
	IBrowserBridgePageSummary,
	IBrowserBridgeService,
} from '../common/browserBridge.js';

// eslint-disable-next-line local/code-import-patterns
import type { Page } from 'playwright-core';

// ── Playwright page-side scripts ──────────────────────────────────────
//
// Functions used with `invokeFunctionRaw` *must* be self-contained: their
// source is `.toString()`-ed and sent to a remote Playwright runner. They
// must not capture any variables from outer scope.

async function _readPageContent(page: Page): Promise<{ body: string; elements: IBrowserBridgePageElement[] }> {
	return page.evaluate(() => {
		const seen = new Set<string>();
		const els: {
			selector: string;
			tag: string;
			type: string;
			text: string;
			value?: string;
			placeholder?: string;
			visible?: boolean;
		}[] = [];

		const isVisible = (el: HTMLElement): boolean => {
			const style = window.getComputedStyle(el);
			if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
				return false;
			}
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		};

		// Walk the text nodes, skipping any whose ancestor chain has a non-
		// visible node. Critical: `document.body.innerText` ignores
		// display:none but happily returns text under visibility:hidden /
		// opacity:0 / off-screen modals. Real-world bug we hit: bigmodel.cn
		// pre-renders its slide-captcha modal in the DOM ("拖动下方拼图完成
		// 验证") and our naive `body.innerText` handed that to the AI, which
		// then correctly inferred "the page has a slider captcha" while the
		// user saw a clean login page. From the AI's perspective the IDE was
		// lying about what's on screen.
		const getVisibleBodyText = (): string => {
			const root = document.body;
			if (!root) { return ''; }
			const out: string[] = [];
			let total = 0;
			const MAX = 8000;
			// Cache visibility lookups for parent elements — TreeWalker visits
			// many text nodes per ancestor and computed style is expensive.
			const visCache = new Map<HTMLElement, boolean>();
			const ancestorsVisible = (el: HTMLElement | null): boolean => {
				while (el && el !== root.parentElement) {
					if (!(el instanceof HTMLElement)) {
						el = el.parentElement;
						continue;
					}
					const cached = visCache.get(el);
					if (cached === false) { return false; }
					if (cached === undefined) {
						const ok = isVisible(el);
						visCache.set(el, ok);
						if (!ok) { return false; }
					}
					el = el.parentElement;
				}
				return true;
			};
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let node: Node | null = walker.nextNode();
			while (node && total < MAX) {
				const parent = node.parentElement;
				if (parent && ancestorsVisible(parent)) {
					const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
					if (text) {
						out.push(text);
						total += text.length + 1;
					}
				}
				node = walker.nextNode();
			}
			return out.join('\n').slice(0, MAX);
		};

		for (const el of document.querySelectorAll<HTMLElement>(
			'button, [role="button"], input, select, textarea, a[href]'
		)) {
			const tag = el.tagName.toLowerCase();
			const type = (el as HTMLInputElement).type || '';
			const value = ((el as HTMLInputElement).value || '').slice(0, 80);
			const placeholder = ((el as HTMLInputElement).placeholder || '').slice(0, 80);
			// `text` is the visible label only (button text, link text). For
			// inputs it's usually empty — callers must look at `value` (current
			// content) and `placeholder` (hint) separately to avoid confusing
			// an empty field whose placeholder reads "请输入手机号" with a
			// filled-in phone number.
			const text = (el.textContent || '').trim().slice(0, 80);
			let sel = '';
			if (el.id) {
				sel = '#' + CSS.escape(el.id);
			} else if ((el as HTMLInputElement).name) {
				sel = tag + '[name="' + (el as HTMLInputElement).name + '"]';
			} else {
				const siblings = Array.from(el.parentNode?.children || []).filter(c => c.tagName === el.tagName);
				sel = tag + ':nth-of-type(' + (1 + siblings.indexOf(el)) + ')';
			}
			if (seen.has(sel)) { continue; }
			seen.add(sel);
			els.push({
				selector: sel,
				tag,
				type,
				text,
				value: value || undefined,
				placeholder: placeholder || undefined,
				visible: isVisible(el),
			});
		}
		return { body: getVisibleBodyText(), elements: els };
	});
}

async function _readPageTitle(page: Page): Promise<string> {
	return page.title();
}

async function _readPageUrl(page: Page): Promise<string> {
	return page.url();
}

async function _doNavigate(page: Page, url: string): Promise<void> {
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

// Stealth init: hide CDP/Playwright automation fingerprints so that anti-bot
// SaaS (bigmodel.cn, weibo, douyin, ...) don't refuse to accept input, throw
// up extra slider captchas, or silently revert .value mutations. The Chromium
// inside our WebContentsView is attach-mode (not Playwright-launched), so it
// doesn't ship the classic `--enable-automation` flag — but Playwright's CDP
// connection still leaves a few tell-tale traces (`navigator.webdriver`, lack
// of `window.chrome`, plugin/language anomalies). This is what kept Agent's
// `browser_type` failing on bigmodel: the page silently no-op'd .value once
// it sniffed automation.
//
// IMPORTANT: `addInitScript` only takes effect at the *next* navigation, so
// callers should reload (or rely on subsequent goto) after applying.
async function _applyStealth(page: Page, scriptSource: string): Promise<void> {
	await page.addInitScript(scriptSource);
}

async function _reloadPage(page: Page): Promise<void> {
	await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
}

async function _doClick(page: Page, selector: string): Promise<void> {
	await page.locator(selector).click({ timeout: 15000 });
}

async function _doType(page: Page, selector: string, text: string): Promise<void> {
	await page.locator(selector).fill(text, { timeout: 15000 });
	// Many controlled React/Vue inputs (Ant Design, Element UI, ...) accept
	// `locator.fill()` silently (it sets .value on the DOM node), but their
	// internal valueTracker overwrites .value back to empty on the next tick.
	// Without this check Playwright reports success while the visible field
	// remains empty, and the AI happily proceeds thinking the input worked.
	const stuck = await page.evaluate(({ sel, expected }: { sel: string; expected: string }) => {
		const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
		return !!el && el.value === expected;
	}, { sel: selector, expected: text });
	if (!stuck) {
		// NOTE: throw a plain object (not `new Error(...)`) — this code runs
		// inside a Node `vm.createContext` sandbox in PlaywrightService, and a
		// sandbox-Error fails `instanceof Error` checks downstream which sends
		// it through the IPC `PromiseErrorObj` path with most properties
		// stripped. A plain `{ message }` survives serialization cleanly and
		// is reconstituted into a real `Error` by `BrowserBridgeService._normalizeError`.
		// eslint-disable-next-line no-throw-literal
		throw {
			name: 'TypeValueResetError',
			message:
				`browser_type: locator.fill() returned ok but the input's .value did not retain "${text}". ` +
				`This usually means a React/Vue valueTracker reset (Ant Design / Element UI etc). ` +
				`Retry the same selector + text with browser_type_native.`,
		};
	}
}

async function _doHover(page: Page, selector: string): Promise<void> {
	await page.locator(selector).hover({ timeout: 15000 });
}

/**
 * Bypass-Playwright fallback for `_doClick`. Dispatches a real MouseEvent on
 * the matched element instead of going through Playwright's actionability
 * checks (visible / enabled / stable / receives pointer events). Useful for
 * custom <div role="button"> / framework-wrapped buttons that Playwright
 * times out on.
 */
async function _doClickNative(page: Page, selector: string): Promise<void> {
	await page.evaluate((sel: string) => {
		const el = document.querySelector<HTMLElement>(sel);
		if (!el) { throw new Error('Element not found: ' + sel); }
		el.focus?.();
		const rect = el.getBoundingClientRect();
		const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 } as const;
		el.dispatchEvent(new MouseEvent('pointerdown', opts));
		el.dispatchEvent(new MouseEvent('mousedown', opts));
		el.dispatchEvent(new MouseEvent('pointerup', opts));
		el.dispatchEvent(new MouseEvent('mouseup', opts));
		el.dispatchEvent(new MouseEvent('click', opts));
	}, selector);
}

/**
 * Bypass-Playwright fallback for `_doType`. Uses the React/Vue-aware "native
 * setter" hack — sets the value through the prototype descriptor so that
 * framework valueTrackers see the change, then dispatches `input` + `change`
 * events. This is the same technique the original WFM browser bridge used
 * before this code path went through Playwright, and it works on most
 * controlled-component login forms that `locator.fill()` rejects.
 */
async function _doTypeNative(page: Page, selector: string, text: string): Promise<void> {
	const stuck = await page.evaluate(({ sel, t }: { sel: string; t: string }) => {
		const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
		if (!el) { throw new Error('Element not found: ' + sel); }
		el.focus?.();
		const inputProto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
		const textareaProto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
		const setter = inputProto?.set ?? textareaProto?.set;
		if (setter) {
			setter.call(el, t);
		} else {
			(el as HTMLInputElement).value = t;
		}
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		return el.value === t;
	}, { sel: selector, t: text });
	if (!stuck) {
		// See `_doType` for why we throw a plain object instead of `new Error`.
		// eslint-disable-next-line no-throw-literal
		throw {
			name: 'TypeNativeValueResetError',
			message:
				`browser_type_native: even the native setter + input/change events did not retain ` +
				`"${text}" on selector "${selector}". The selector may be pointing at a wrong / ` +
				`hidden element, or the framework is doing something exotic. Re-read the page and ` +
				`pick a more specific selector for the actually-visible input.`,
		};
	}
}

// ──────────────────────────────────────────────────────────────────────
//
// Anti-detection init script — sent to Playwright as a string and registered
// via `page.addInitScript()` so it runs in *every* document before any other
// JS. Hides the standard Playwright/CDP fingerprints that bigmodel/weibo/etc
// sniff to decide "this is a bot, no-op the form". Patches are intentionally
// idempotent — re-running is safe.
const STEALTH_SCRIPT = `(() => {
	try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true }); } catch (e) {}
	try {
		if (!('chrome' in window)) {
			Object.defineProperty(window, 'chrome', { value: { runtime: {}, app: {} }, configurable: true });
		} else if (!window.chrome.runtime) {
			window.chrome.runtime = {};
		}
	} catch (e) {}
	try { Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true }); } catch (e) {}
	try {
		Object.defineProperty(Navigator.prototype, 'plugins', {
			get: () => [
				{ name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
				{ name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
				{ name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
				{ name: 'Native Client', filename: 'internal-nacl-plugin' },
			],
			configurable: true,
		});
	} catch (e) {}
	try {
		const origQuery = window.navigator.permissions && window.navigator.permissions.query;
		if (origQuery) {
			window.navigator.permissions.query = (params) =>
				params && params.name === 'notifications'
					? Promise.resolve({ state: typeof Notification !== 'undefined' ? Notification.permission : 'default', onchange: null })
					: origQuery.call(window.navigator.permissions, params);
		}
	} catch (e) {}
	try {
		const proto = WebGLRenderingContext && WebGLRenderingContext.prototype;
		if (proto) {
			const getParameter = proto.getParameter;
			proto.getParameter = function (param) {
				if (param === 37445) { return 'Intel Inc.'; }
				if (param === 37446) { return 'Intel Iris OpenGL Engine'; }
				return getParameter.call(this, param);
			};
		}
	} catch (e) {}
})();`;

export class BrowserBridgeService extends Disposable implements IBrowserBridgeService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async open(url: string, reuseExisting: boolean = true): Promise<IBrowserBridgePageInfo> {
		// Dedup pass: if a BrowserEditorInput already points at the requested
		// URL (same scheme + host + path; query/hash ignored — Agents commonly
		// re-open with extra redirect params), reuse its pageId. Avoids the
		// "Agent panicks, opens 3 zombie tabs of the same site, loses track of
		// which one it's driving, hallucinates state from a stale read"
		// failure mode we've actually hit on bigmodel.cn login pages.
		if (reuseExisting) {
			const existing = this._findEditorByUrl(url);
			if (existing) {
				this.logService.info(`[wfm-browser-bridge] open(${url}) reusing existing tab ${existing.id}`);
				// Re-navigate so the caller gets a clean reload (the caller asked
				// to "open" the URL, not just "find a tab that happens to share it").
				// Register stealth BEFORE navigate — goto triggers a new document
				// which is where addInitScript actually applies.
				try {
					await this._invokePage<void>(existing.id, _applyStealth, STEALTH_SCRIPT);
				} catch (err) {
					this.logService.warn(`[wfm-browser-bridge] stealth (reuse) failed: ${(err as Error).message}`);
				}
				try {
					await this._invokePage<void>(existing.id, _doNavigate, url);
				} catch (err) {
					this.logService.warn(`[wfm-browser-bridge] re-navigate during reuse failed: ${(err as Error).message}`);
				}
				await this._revealPage(existing.id);
				const [title, content] = await Promise.all([
					this._safeTitle(existing.id),
					this._safeContent(existing.id),
				]);
				return { pageId: existing.id, url, title, content };
			}
		}

		const { pageId } = await this.playwrightService.openPage(url);

		// Inject anti-detection patches BEFORE we let the user see the page —
		// `openPage()` already did a first goto without the stealth shims, so
		// reload once with stealth registered. The visible effect is a brief
		// reload flash on the first navigation; subsequent navigations on the
		// same page reuse the registered init script with no extra reload.
		await this._applyStealthAndReload(pageId);

		// Surface the new page in the main editor area so the user can see and
		// interact with it (handle CAPTCHAs etc). BrowserEditorResolver picks up
		// vscodeBrowser:/<id> URIs and creates a BrowserEditorInput automatically.
		try {
			const resource = BrowserViewUri.forId(pageId);
			await this.editorService.openEditor({
				resource,
				options: { pinned: true, viewState: { url } },
			});
		} catch (err) {
			this.logService.warn(`[wfm-browser-bridge] open editor for ${pageId} failed: ${(err as Error).message}`);
		}

		const [title, content] = await Promise.all([
			this._safeTitle(pageId),
			this._safeContent(pageId),
		]);
		return { pageId, url, title, content };
	}

	async list(): Promise<{ pages: IBrowserBridgePageSummary[] }> {
		const pages: IBrowserBridgePageSummary[] = [];
		for (const group of this.editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			for (const editor of group.editors) {
				if (editor instanceof BrowserEditorInput) {
					pages.push({
						pageId: editor.id,
						url: editor.url || '',
						title: editor.title || '',
						isActive: group.activeEditor === editor,
					});
				}
			}
		}
		return { pages };
	}

	async navigate(pageId: string, url: string): Promise<{ url: string }> {
		await this._revealPage(pageId);
		await this._invokePage<void>(pageId, _doNavigate, url);
		return { url };
	}

	async read(pageId: string): Promise<IBrowserBridgeReadResult> {
		// Read is intentionally non-revealing: Agents poll `read` frequently while
		// "thinking" and we don't want to steal focus from the user every cycle.
		// Only mutating ops (navigate / click / type / hover / dialog) pull the
		// page to the foreground.
		const [url, title, content] = await Promise.all([
			this._invokePage<string>(pageId, _readPageUrl),
			this._safeTitle(pageId),
			this._safeContent(pageId),
		]);
		return { url, title, content };
	}

	async screenshot(pageId: string): Promise<{ image: string }> {
		// Use the native WebContentsView capture (same path as the upstream
		// ScreenshotBrowserTool). Avoids Playwright's screenshot which causes
		// a brief flash on the page. Non-revealing for the same reason as `read`.
		const model = await this.browserViewWorkbenchService.getBrowserViewModel(pageId);
		const buf: VSBuffer = await model.captureScreenshot();
		return { image: encodeBase64(buf) };
	}

	async click(pageId: string, selector: string, _element: string): Promise<{ ok: true }> {
		await this._revealPage(pageId);
		await this._invokePage<void>(pageId, _doClick, selector);
		return { ok: true };
	}

	async clickNative(pageId: string, selector: string, _element: string): Promise<{ ok: true }> {
		await this._revealPage(pageId);
		await this._invokePage<void>(pageId, _doClickNative, selector);
		return { ok: true };
	}

	async type(pageId: string, selector: string, text: string, _element: string): Promise<{ ok: true }> {
		await this._revealPage(pageId);
		await this._invokePage<void>(pageId, _doType, selector, text);
		return { ok: true };
	}

	async typeNative(pageId: string, selector: string, text: string, _element: string): Promise<{ ok: true }> {
		await this._revealPage(pageId);
		await this._invokePage<void>(pageId, _doTypeNative, selector, text);
		return { ok: true };
	}

	async hover(pageId: string, selector: string, _element: string): Promise<{ ok: true }> {
		await this._revealPage(pageId);
		await this._invokePage<void>(pageId, _doHover, selector);
		return { ok: true };
	}

	async dialog(pageId: string, accept: boolean, promptText: string): Promise<{ ok: true }> {
		await this._revealPage(pageId);
		await this.playwrightService.replyToDialog(pageId, accept, promptText || undefined);
		return { ok: true };
	}

	async close(pageId: string): Promise<{ ok: true }> {
		// Find the BrowserEditorInput tied to this pageId and close it. Closing
		// the editor disposes the underlying view via BrowserEditorInput.dispose.
		for (const group of this.editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			for (const editor of group.editors) {
				if (editor instanceof BrowserEditorInput && editor.id === pageId) {
					await group.closeEditor(editor);
				}
			}
		}
		return { ok: true };
	}

	// ── helpers ──────────────────────────────────────────────────────

	/**
	 * Find an open BrowserEditorInput whose URL matches *url* (ignoring query
	 * + hash + trailing slash so common variants are treated as the same tab).
	 */
	private _findEditorByUrl(url: string): BrowserEditorInput | undefined {
		const normalize = (raw: string): string => {
			try {
				const u = new URL(raw);
				return u.origin + u.pathname.replace(/\/$/, '');
			} catch {
				return raw;
			}
		};
		const target = normalize(url);
		for (const group of this.editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			for (const editor of group.editors) {
				if (editor instanceof BrowserEditorInput && editor.url && normalize(editor.url) === target) {
					return editor;
				}
			}
		}
		return undefined;
	}

	/**
	 * Register the stealth init script and reload so it takes effect on the
	 * current document. `openPage()` already did one goto without stealth, so
	 * we need a reload — subsequent navigations on the same page just inherit
	 * the registered init script with no extra cost.
	 *
	 * Failures here are non-fatal: stealth is a best-effort hardening layer,
	 * and the user can still drive the page manually if anti-bot decides to
	 * be aggressive anyway.
	 */
	private async _applyStealthAndReload(pageId: string): Promise<void> {
		try {
			await this._invokePage<void>(pageId, _applyStealth, STEALTH_SCRIPT);
		} catch (err) {
			this.logService.warn(`[wfm-browser-bridge] stealth registration failed for ${pageId}: ${(err as Error).message}`);
			return;
		}
		try {
			await this._invokePage<void>(pageId, _reloadPage);
		} catch (err) {
			this.logService.warn(`[wfm-browser-bridge] stealth reload failed for ${pageId}: ${(err as Error).message}`);
		}
	}

	/**
	 * Run a self-contained function inside the Playwright page and rewrap any
	 * thrown value as a proper `Error` instance.
	 *
	 * Why: errors that surface from `IPlaywrightService.invokeFunctionRaw`
	 * have crossed two IPC boundaries (renderer ⇌ sharedProcess, then
	 * sharedProcess ⇌ CDP), and along the way the original `Error` prototype
	 * tends to get lost — what comes back is a plain object with arbitrary
	 * shape (sometimes `{}`, sometimes `{ message }`, sometimes the message
	 * encoded into `name`). Without this rewrap, the IPC channel between
	 * renderer ⇌ main treats those as `PromiseErrorObj` (raw object) instead
	 * of `PromiseError`, and the final HTTP response surfaces useless
	 * `"[object Object]"` / `"{}"` messages — which is exactly how the
	 * "browser_type silently lies that it succeeded" bug went undiagnosed.
	 *
	 * `_extractMessage` mirrors the same logic on the receiving side as a
	 * belt-and-braces measure, but normalizing to Error here means downstream
	 * Agents see clear, actionable text from `_doType`'s `throw new Error(...)`.
	 */
	private async _invokePage<T>(pageId: string, fn: (...args: any[]) => any, ...args: unknown[]): Promise<T> {
		try {
			return await this.playwrightService.invokeFunctionRaw<T>(pageId, fn.toString(), ...args);
		} catch (err) {
			throw this._normalizeError(err, fn.name || 'invokeFunctionRaw');
		}
	}

	private _normalizeError(err: unknown, fnName: string): Error {
		if (err instanceof Error && err.message) {
			return err;
		}
		if (err && typeof err === 'object') {
			const obj = err as { message?: unknown; name?: unknown; stack?: unknown };
			if (typeof obj.message === 'string' && obj.message) {
				const e = new Error(obj.message);
				if (typeof obj.name === 'string') { e.name = obj.name; }
				if (typeof obj.stack === 'string') { e.stack = obj.stack; }
				return e;
			}
			if (typeof obj.name === 'string' && obj.name) {
				return new Error(obj.name);
			}
			try {
				return new Error(`${fnName} failed with non-Error payload: ${JSON.stringify(err)}`);
			} catch {
				/* fall through */
			}
		}
		return new Error(`${fnName} failed with value: ${String(err)}`);
	}

	/**
	 * Make sure the BrowserEditorInput backing *pageId* is the *active*
	 * editor in its group, so the user actually sees the page the AI is
	 * about to manipulate.
	 *
	 * Implementation note: we used to walk `editorGroupsService.getGroups()`
	 * and call `group.openEditor(editor, { preserveFocus: true })`, but that
	 * proved unreliable — `instanceof BrowserEditorInput` can fail when the
	 * class is loaded through different module paths in dev mode, and even
	 * when it succeeds the active editor would sometimes not visibly change
	 * (the editor area kept rendering a different tab). Going through
	 * `IEditorService.openEditor({ resource })` is the same path `open()`
	 * uses and reliably activates the tab.
	 *
	 * - `activation: ACTIVATE` makes this editor the active editor in its group.
	 * - `revealIfOpened: true` reuses the existing input instead of creating a
	 *   new one with the same resource.
	 * - `preserveFocus: true` keeps the keyboard focus wherever the user has
	 *   it (typically the Chat input). Switching the visible tab without
	 *   yanking focus is what makes "AI drives the page while user watches /
	 *   occasionally interrupts manually" feel natural.
	 */
	private async _revealPage(pageId: string): Promise<void> {
		try {
			await this.editorService.openEditor({
				resource: BrowserViewUri.forId(pageId),
				options: {
					activation: EditorActivation.ACTIVATE,
					revealIfOpened: true,
					preserveFocus: true,
				},
			});
		} catch (err) {
			this.logService.warn(`[wfm-browser-bridge] reveal page ${pageId} failed: ${(err as Error).message}`);
		}
	}

	private async _safeTitle(pageId: string): Promise<string> {
		try {
			return await this._invokePage<string>(pageId, _readPageTitle);
		} catch {
			return '';
		}
	}

	private async _safeContent(pageId: string): Promise<IBrowserBridgePageContent> {
		try {
			const raw = await this._invokePage<{ body: string; elements: IBrowserBridgePageElement[] }>(
				pageId, _readPageContent
			);
			return { body: raw.body, elements: raw.elements };
		} catch (err) {
			this.logService.warn(`[wfm-browser-bridge] read content for ${pageId} failed: ${(err as Error).message}`);
			return { body: '', elements: [] };
		}
	}
}
