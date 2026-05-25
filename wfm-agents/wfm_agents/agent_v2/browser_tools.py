"""Browser tools for the WFM MCP server.

Provides tools that let the AI open web pages, read content, click elements,
type text, take screenshots, and navigate — all through the IDE's embedded
browser (WebContentsView) via a localhost HTTP bridge.

The bridge port is injected as ``WFM_BROWSER_API_PORT`` by the IDE main
process.  If the env var is missing, the tools are not registered.

Session binding (Phase 1 of the chat↔page binding architecture):
================================================================
This MCP server process is spawned once per Chat session by ``claude`` CLI,
so module-level state == per-chat-session state. We use that to maintain a
single ``current_page_id`` that all ``browser_*`` tools default to. This
means the AI does NOT need to keep a 36-char uuid in its working memory
across turns — calls like ``browser_click(selector=...)`` (no pageId) just
target whichever page is currently bound. This eliminates the entire class
of bugs where the AI confused itself across multiple tabs ("the slider is
blocking" while the user sees a clean page, etc).

Explicit pageId still works (and is required when juggling more than one
tab); calling ``browser_switch(page_id)`` rebinds. ``browser_list_pages``
exposes all tabs for introspection.
"""

from __future__ import annotations

import json
import os
import threading
from typing import TYPE_CHECKING, Any, Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

if TYPE_CHECKING:
    from mcp.server.fastmcp import FastMCP


# ── HTTP bridge helpers ──────────────────────────────────────────────


def _bridge_url() -> str:
    port = os.environ.get("WFM_BROWSER_API_PORT")
    if not port:
        raise RuntimeError("WFM_BROWSER_API_PORT not set — browser bridge unavailable")
    return f"http://127.0.0.1:{port}"


def _bridge_post(endpoint: str, data: dict, *, timeout: int = 30) -> dict:
    url = f"{_bridge_url()}/{endpoint}"
    body = json.dumps(data).encode()
    req = Request(url, data=body, headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _safe_call(fn):
    """Wrap a bridge call so URL/runtime errors become a readable string.

    Lets us avoid 10× identical try/except blocks per tool.
    """
    try:
        result = fn()
    except (URLError, RuntimeError) as exc:
        return f"Error: {exc}"
    return json.dumps(result, ensure_ascii=False) if not isinstance(result, str) else result


# ── Session-local page binding ───────────────────────────────────────
#
# One MCP server process == one Chat session (claude CLI spawns a fresh
# subprocess per chat). So a single module-level slot IS the chat's
# "currently focused tab" register. Thread lock just guards reads/writes
# from FastMCP's worker threads.


class _BrowserSession:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._current: Optional[str] = None

    @property
    def current(self) -> Optional[str]:
        with self._lock:
            return self._current

    def bind(self, page_id: str) -> None:
        with self._lock:
            self._current = page_id

    def unbind_if_matches(self, page_id: str) -> None:
        with self._lock:
            if self._current == page_id:
                self._current = None

    def resolve(self, page_id: Optional[str]) -> str:
        """Return *page_id* if given, else the currently-bound one.

        Side effect: if the caller passes an explicit page_id, we also
        rebind to it — using a tool on a specific page is a strong signal
        that the AI now considers that page the focus of work.

        Raises a clear error if no page is bound (instead of letting the
        downstream bridge complain about missing pageId).
        """
        if page_id:
            with self._lock:
                self._current = page_id
            return page_id
        cur = self.current
        if not cur:
            raise RuntimeError(
                "No browser page bound to this session yet — call "
                "`browser_open(url)` first, or pass an explicit `page_id`. "
                "Use `browser_list_pages` to see what tabs are already open."
            )
        return cur


_session = _BrowserSession()


# ── Registration ─────────────────────────────────────────────────────


def register(mcp: FastMCP) -> None:
    """Register all browser tools on the given *mcp* server."""

    # ── opening / discovery ──────────────────────────────────────────

    @mcp.tool()
    def browser_open(url: str, reuse_existing: bool = True) -> str:
        """Open a URL in the integrated browser AND bind it as the current page.

        After this call, all subsequent ``browser_*`` calls in this Chat
        session default to operating on this page — you do NOT need to pass
        ``page_id`` to ``browser_click`` / ``browser_type`` / etc unless you
        want to operate on a different tab.

        **By default this reuses an existing tab pointing at the same URL.**
        If a tab for *url* is already open, the existing ``pageId`` is
        returned (and the page is reloaded). Pass ``reuse_existing=False``
        only when you genuinely need a fresh independent session.

        Returns JSON ``{pageId, url, title, content}``.
        """

        def _do() -> Any:
            result = _bridge_post("open", {"url": url, "reuse_existing": reuse_existing})
            page_id = result.get("pageId")
            if page_id:
                _session.bind(page_id)
            return result

        return _safe_call(_do)

    @mcp.tool()
    def browser_list_pages() -> str:
        """List every browser tab currently open in the IDE editor area.

        Returns ``{"pages": [{pageId, url, title, isActive}, ...], "current": "<bound pageId or null>"}``.

        Use this:
        - At the start of a session if the user mentions an already-open
          page — find that ``pageId`` and ``browser_switch`` to it instead
          of opening a new tab.
        - Whenever your assumptions about page state feel off (e.g. you
          think there's a verification slider but the user disagrees) —
          ``isActive: true`` tells you which tab the user is actually
          looking at, and ``current`` tells you which one this session is
          bound to. If they differ, ``browser_switch`` to the active one.
        - Before deciding to ``browser_close`` + ``browser_open`` again —
          if a tab for the URL is already there, ``browser_navigate`` or
          ``browser_switch`` to it instead of leaving zombie tabs behind.
        """

        def _do() -> Any:
            result = _bridge_post("list_pages", {})
            result["current"] = _session.current
            return result

        return _safe_call(_do)

    @mcp.tool()
    def browser_switch(page_id: str) -> str:
        """Switch this session's bound page to *page_id*.

        After ``browser_switch``, all ``browser_*`` calls without an
        explicit ``page_id`` default to this tab. Useful when you've been
        juggling two tabs and want to focus on one for several operations
        without typing the uuid each time.

        Errors loudly if *page_id* isn't a currently-open tab (call
        ``browser_list_pages`` first if unsure).
        """

        def _do() -> Any:
            pages = _bridge_post("list_pages", {}).get("pages") or []
            if not any(p.get("pageId") == page_id for p in pages):
                raise RuntimeError(
                    f"page_id {page_id!r} is not currently open. "
                    "Use `browser_list_pages` to see what's available."
                )
            _session.bind(page_id)
            return {"ok": True, "current": page_id}

        return _safe_call(_do)

    @mcp.tool()
    def browser_current_page() -> str:
        """Return this session's currently bound page (or null) + summary.

        Useful sanity check — call this if you're unsure whether a previous
        ``browser_open`` actually succeeded or whether you have a page to
        operate on.
        """

        def _do() -> Any:
            cur = _session.current
            if not cur:
                return {"current": None}
            pages = _bridge_post("list_pages", {}).get("pages") or []
            summary = next((p for p in pages if p.get("pageId") == cur), None)
            if not summary:
                # Bound to a tab that no longer exists (closed by user, crashed, ...).
                # Auto-unbind so the next call gives a clean "no page" error
                # instead of trying to drive a dead pageId.
                _session.unbind_if_matches(cur)
                return {"current": None, "warning": f"Previously bound page {cur} is gone."}
            return {"current": cur, "page": summary}

        return _safe_call(_do)

    # ── reading state ────────────────────────────────────────────────

    @mcp.tool()
    def browser_read(page_id: Optional[str] = None) -> str:
        """Read the current content of a browser page.

        Targets the currently-bound page if *page_id* is omitted.

        Returns ``url``, ``title``, ``content.body`` (page text), and
        ``content.elements`` — a list of interactive elements. Each element
        has:

        - ``selector`` — CSS selector to use with ``browser_click`` / ``browser_type``
        - ``tag`` / ``type`` — e.g. ``"input"`` / ``"password"``
        - ``text`` — visible label (button / link text); usually empty for inputs
        - ``value`` — the input's CURRENT ``.value`` (use this to verify a
          previous ``browser_type`` actually stuck!)
        - ``placeholder`` — the hint text. **DO NOT mistake this for a
          filled value.** A field with ``placeholder="请输入手机号"`` and
          empty ``value`` is still empty.
        - ``visible`` — false for elements in hidden tabs / off-screen panels.
          Always prefer visible elements; typing into a hidden one tends to
          land on the wrong form.
        """

        return _safe_call(lambda: _bridge_post("read", {"pageId": _session.resolve(page_id)}))

    @mcp.tool()
    def browser_screenshot(page_id: Optional[str] = None) -> str:
        """Take a screenshot of the browser page (currently-bound by default).

        Returns a base64-encoded PNG image.
        """

        return _safe_call(
            lambda: _bridge_post("screenshot", {"pageId": _session.resolve(page_id)})
        )

    # ── mutating: navigation / click / type / hover ─────────────────

    @mcp.tool()
    def browser_navigate(url: str, page_id: Optional[str] = None) -> str:
        """Navigate the currently-bound page (or *page_id*) to a new URL."""

        return _safe_call(
            lambda: _bridge_post("navigate", {"pageId": _session.resolve(page_id), "url": url})
        )

    @mcp.tool()
    def browser_click(selector: str, element: str, page_id: Optional[str] = None) -> str:
        """Click an element on the page (try this FIRST; on failure, retry with ``browser_click_native``).

        Uses Playwright's ``locator.click()`` with full actionability checks
        (visible / enabled / stable / receives pointer events). Targets the
        currently-bound page if *page_id* is omitted.

        **If this errors out, times out, or the page doesn't visually
        change after the click, IMMEDIATELY retry with
        ``browser_click_native``** — common reasons Playwright fails:
        custom ``<div role="button">`` widgets (Ant Design / Element UI
        tabs, segmented controls), an invisible overlay intercepting
        pointer events, elements behind a sticky header.

        *selector* is a CSS selector (e.g. ``#login-btn``,
        ``button[type="submit"]``). *element* is a human-readable label for
        logging.
        """

        return _safe_call(
            lambda: _bridge_post(
                "click",
                {"pageId": _session.resolve(page_id), "selector": selector, "element": element},
            )
        )

    @mcp.tool()
    def browser_click_native(selector: str, element: str, page_id: Optional[str] = None) -> str:
        """Click an element by dispatching raw DOM mouse events (fallback).

        Skips Playwright's actionability checks. Use this when
        ``browser_click`` times out (e.g. custom div-based buttons, overlays
        that "intercept pointer events", elements behind a fixed header).
        Less safe than ``browser_click`` — only use after the standard tool
        fails.
        """

        return _safe_call(
            lambda: _bridge_post(
                "click_native",
                {"pageId": _session.resolve(page_id), "selector": selector, "element": element},
            )
        )

    @mcp.tool()
    def browser_type(
        selector: str, text: str, element: str, page_id: Optional[str] = None
    ) -> str:
        """Type text into an input field (try this FIRST; on failure, retry with ``browser_type_native``).

        Uses Playwright's ``locator.fill()`` — clears the field and types
        the value semantically.

        **If this errors out, or if a subsequent ``browser_read`` shows
        the field is still empty / unchanged, IMMEDIATELY retry with
        ``browser_type_native``** — common reasons Playwright fails:
        controlled React/Vue inputs whose ``valueTracker`` rejects the
        synthetic typing, Ant Design / Element UI / iView form inputs,
        custom contenteditable widgets.
        """

        return _safe_call(
            lambda: _bridge_post(
                "type",
                {
                    "pageId": _session.resolve(page_id),
                    "selector": selector,
                    "text": text,
                    "element": element,
                },
            )
        )

    @mcp.tool()
    def browser_type_native(
        selector: str, text: str, element: str, page_id: Optional[str] = None
    ) -> str:
        """Type text via the native value-setter hack (fallback).

        Sets the input's value through ``HTMLInputElement.prototype``'s value
        setter so React/Vue/Angular's internal value trackers register the
        change, then dispatches ``input`` and ``change`` events. Use this
        when ``browser_type`` doesn't actually populate the field — common
        on controlled-component login forms, Ant Design / Element UI
        inputs, and custom rich-text widgets.
        """

        return _safe_call(
            lambda: _bridge_post(
                "type_native",
                {
                    "pageId": _session.resolve(page_id),
                    "selector": selector,
                    "text": text,
                    "element": element,
                },
            )
        )

    @mcp.tool()
    def browser_hover(selector: str, element: str, page_id: Optional[str] = None) -> str:
        """Hover over an element on the page (currently-bound by default)."""

        return _safe_call(
            lambda: _bridge_post(
                "hover",
                {"pageId": _session.resolve(page_id), "selector": selector, "element": element},
            )
        )

    # ── dialog + lifecycle ──────────────────────────────────────────

    @mcp.tool()
    def browser_handle_dialog(
        accept: bool, text: str = "", page_id: Optional[str] = None
    ) -> str:
        """Accept or dismiss a browser dialog (alert/confirm/prompt).

        Set *accept* to True to accept, False to dismiss.  For ``prompt``
        dialogs, *text* provides the response.
        """

        return _safe_call(
            lambda: _bridge_post(
                "handle_dialog",
                {"pageId": _session.resolve(page_id), "accept": accept, "text": text},
            )
        )

    @mcp.tool()
    def browser_close(page_id: Optional[str] = None) -> str:
        """Close a browser page (currently-bound by default).

        Unbinds the session if you close the currently-bound page.
        """

        def _do() -> Any:
            pid = _session.resolve(page_id)
            result = _bridge_post("close", {"pageId": pid})
            _session.unbind_if_matches(pid)
            return result

        return _safe_call(_do)
