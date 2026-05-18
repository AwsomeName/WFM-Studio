"""Unified runner — the single entry-point for all routes.

Wraps the OpenAI Agents SDK ``Runner`` and exposes two functions:

* ``run_chat()``    — sync, returns a ``ChatResult``.
* ``run_chat_stream()`` — async, yields SSE frames as ``bytes``.

Routes import only from this module; they never touch the SDK directly.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx
from openai import AsyncOpenAI

from agents import RunConfig, Runner
from agents.model_settings import ModelSettings
from agents.models.openai_provider import OpenAIProvider

from ..agent.config import AgentConfigError, load_config
from ..cad.review import CadReviewReport, render_markdown
from ..docx import format_docx_content

from .agents import cad_review_agent, docx_review_agent, plain_chat_agent
from .context import WfmAgentContext
from .sse import EVENT_DONE, EVENT_ERROR, EVENT_TEXT_DELTA, EVENT_TOOL_CALL_DONE, EVENT_TOOL_CALL_STARTED, encode_sse

_log = logging.getLogger(__name__)


# ── Public result type ────────────────────────────────────────────────


@dataclass
class ChatResult:
    content: str
    workspace_root: str
    received_at: str
    trace_id: str | None = None
    session_id: str | None = None
    report: dict[str, Any] | None = None
    tool_call_count: int = 0
    usage: dict[str, Any] | None = None


# ── Config / prompt helpers ───────────────────────────────────────────


def _build_run_config() -> tuple[RunConfig, int]:
    cfg = load_config()
    client = AsyncOpenAI(
        api_key=cfg.api_key,
        base_url=cfg.base_url,
        timeout=httpx.Timeout(cfg.request_timeout, connect=10.0),
    )
    provider = OpenAIProvider(
        openai_client=client,
        use_responses=cfg.use_responses_api,
    )
    return RunConfig(
        model=cfg.model,
        model_provider=provider,
        model_settings=ModelSettings(temperature=cfg.temperature),
    ), cfg.max_tool_rounds


def _build_docx_prompt(docx_extras: dict[str, Any], user_message: str) -> str:
    content = docx_extras["docx_content"]
    source = docx_extras.get("docx_source", "unknown")
    user_msg = (user_message or "").strip() or "请核对文件中的所有金额。"
    formatted = format_docx_content(content)
    return (
        f"### Word 文档内容 (来源: {source})\n\n{formatted}\n\n"
        f"### 用户问题\n{user_msg}\n"
    )


# ── JSON parsing for CAD review (handles code fences from GLM) ────────

_FENCE_RE = re.compile(r"```(?:json)?\s*\n?(.*?)\n?\s*```", re.DOTALL)


def _parse_cad_review(text: str) -> tuple[str, dict[str, Any] | None]:
    m = _FENCE_RE.search(text)
    json_str = m.group(1).strip() if m else text.strip()
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError:
        _log.warning("cad_review: failed to parse JSON from model output")
        return text, None
    try:
        report = CadReviewReport.model_validate(data)
        return render_markdown(report), report.model_dump()
    except Exception:
        _log.warning("cad_review: JSON parsed but schema validation failed")
        return text, data


# ── Usage / tool-call extraction ──────────────────────────────────────


def _extract_usage(result: Any) -> dict[str, Any] | None:
    if not result.raw_responses:
        return None
    last = result.raw_responses[-1]
    usage = getattr(last, "usage", None)
    if usage is None:
        return None
    return {
        "input_tokens": getattr(usage, "input_tokens", 0) or 0,
        "output_tokens": getattr(usage, "output_tokens", 0) or 0,
        "total_tokens": getattr(usage, "total_tokens", 0) or 0,
    }


def _count_tool_calls(result: Any) -> int:
    return sum(
        1
        for item in result.new_items
        if "tool_call" in getattr(item, "type", "") and "output" not in getattr(item, "type", "")
    )


# ── Sync entry point ─────────────────────────────────────────────────


def run_chat(
    *,
    message: str,
    workspace_root: str,
    session_id: str | None = None,
    cad_file_path: str | None = None,
    docx_extras: dict[str, Any] | None = None,
) -> ChatResult:
    """Run a single chat turn (blocking). Called from route handlers via ``asyncio.to_thread``."""
    run_config, max_turns = _build_run_config()
    ctx = WfmAgentContext(workspace_root=workspace_root)

    if cad_file_path is not None:
        agent = cad_review_agent
        prompt = (
            f"请审图，文件路径: {cad_file_path}\n"
            f"用户要求: {message}"
        )
    elif docx_extras is not None:
        agent = docx_review_agent
        prompt = _build_docx_prompt(docx_extras, message)
    else:
        agent = plain_chat_agent
        prompt = message

    result = Runner.run_sync(
        starting_agent=agent,
        input=prompt,
        context=ctx,
        run_config=run_config,
        max_turns=max_turns,
    )

    final = result.final_output
    is_cad = cad_file_path is not None
    if is_cad and isinstance(final, str):
        content, report = _parse_cad_review(final)
    elif isinstance(final, CadReviewReport):
        content = render_markdown(final)
        report = final.model_dump()
    else:
        content = str(final)
        report = None

    return ChatResult(
        content=content,
        workspace_root=workspace_root,
        received_at=datetime.now(tz=timezone.utc).isoformat(),
        session_id=session_id,
        report=report,
        tool_call_count=_count_tool_calls(result),
        usage=_extract_usage(result),
    )


# ── Streaming entry point ────────────────────────────────────────────


async def run_chat_stream(
    *,
    message: str,
    workspace_root: str,
    session_id: str | None = None,
    cad_file_path: str | None = None,
    docx_extras: dict[str, Any] | None = None,
) -> AsyncIterator[bytes]:
    """Yield SSE frames as ``bytes``."""
    run_config, max_turns = _build_run_config()
    ctx = WfmAgentContext(workspace_root=workspace_root)

    if cad_file_path is not None:
        agent = cad_review_agent
        prompt = (
            f"请审图，文件路径: {cad_file_path}\n"
            f"用户要求: {message}"
        )
    elif docx_extras is not None:
        agent = docx_review_agent
        prompt = _build_docx_prompt(docx_extras, message)
    else:
        agent = plain_chat_agent
        prompt = message

    # Emit session event first
    yield encode_sse({"type": "session", "session_id": session_id})

    try:
        streamed = Runner.run_streamed(
            starting_agent=agent,
            input=prompt,
            context=ctx,
            run_config=run_config,
            max_turns=max_turns,
        )

        async for event in streamed.stream_events():
            if event.type == "run_item_stream_event":
                name = event.name

                if name == "message_output_created":
                    # Extract text from the message output item
                    from agents.items import ItemHelpers

                    text = ItemHelpers.text_message_output(event.item)
                    if text:
                        yield encode_sse({"type": EVENT_TEXT_DELTA, "delta": text})

                elif name == "tool_called":
                    item = event.item
                    yield encode_sse({
                        "type": EVENT_TOOL_CALL_STARTED,
                        "id": getattr(item, "call_id", "") or "",
                        "name": getattr(item, "tool_name", "") or getattr(item, "raw_item", {}).get("name", ""),
                    })

                elif name == "tool_output":
                    item = event.item
                    yield encode_sse({
                        "type": EVENT_TOOL_CALL_DONE,
                        "id": getattr(item, "call_id", "") or "",
                    })

        # Stream complete — emit done
        final = streamed.final_output
        is_cad = cad_file_path is not None
        if is_cad and isinstance(final, str):
            content, _ = _parse_cad_review(final)
        else:
            content = str(final) if final is not None else ""

        yield encode_sse({
            "type": EVENT_DONE,
            "session_id": session_id,
            "trace_id": None,
            "text": content,
        })

    except Exception as exc:
        _log.exception("run_chat_stream failed")
        yield encode_sse({
            "type": EVENT_ERROR,
            "error": f"{type(exc).__name__}: {exc}",
        })
