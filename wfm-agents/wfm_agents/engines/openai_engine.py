"""OpenAI Chat Completions engine — tool loop via ToolHandle only (ARCH §3.6)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from os import getenv
from typing import Any, ClassVar

from ..gateway.exceptions import EngineNotInstalledError
from ..gateway.models import (
    DoneStreamEvent,
    ErrorStreamEvent,
    StreamEvent,
    TextDeltaStreamEvent,
    TurnResult,
    UsageStats,
)
from ..gateway.session import SessionContext
from ..observability import errors as err
from ..tools.handle import ToolHandle
from ..tools.spec import ToolResult, ToolSpec
from .openai_errors import OpenAIApiError, OpenAIConfigError

_INSTALL_HINT = (
    "OpenAI SDK 未安装。请执行: uv sync 或 pip install 'wfm-agents'（已将 openai 作为主依赖）。"
)

_DEFAULT_MODEL = "gpt-4o-mini"


@dataclass(frozen=True)
class _OpenAIRuntimeConfig:
    api_key: str
    model: str
    max_tool_rounds: int
    base_url: str | None
    request_timeout: float


def _load_runtime_config(ctx: SessionContext) -> _OpenAIRuntimeConfig:
    key = (getenv("WFM_OPENAI_API_KEY") or getenv("OPENAI_API_KEY") or "").strip()
    if not key:
        raise OpenAIConfigError(
            "未配置 OpenAI API Key：请设置 WFM_OPENAI_API_KEY 或 OPENAI_API_KEY。"
        )
    model = (ctx.model_override or getenv("WFM_OPENAI_MODEL") or _DEFAULT_MODEL).strip()
    rounds_raw = (getenv("WFM_OPENAI_MAX_TOOL_ROUNDS") or "16").strip()
    try:
        max_tool_rounds = int(rounds_raw)
    except ValueError as exc:
        raise OpenAIConfigError(
            f"WFM_OPENAI_MAX_TOOL_ROUNDS 非法: {rounds_raw!r}"
        ) from exc
    if max_tool_rounds <= 0:
        raise OpenAIConfigError("WFM_OPENAI_MAX_TOOL_ROUNDS 必须 > 0")
    timeout_raw = (getenv("WFM_OPENAI_REQUEST_TIMEOUT") or "60").strip()
    try:
        request_timeout = float(timeout_raw)
    except ValueError as exc:
        raise OpenAIConfigError(
            f"WFM_OPENAI_REQUEST_TIMEOUT 非法: {timeout_raw!r}"
        ) from exc
    if request_timeout <= 0:
        raise OpenAIConfigError("WFM_OPENAI_REQUEST_TIMEOUT 必须 > 0")
    base = (getenv("WFM_OPENAI_BASE_URL") or "").strip() or None
    return _OpenAIRuntimeConfig(
        api_key=key,
        model=model,
        max_tool_rounds=max_tool_rounds,
        base_url=base,
        request_timeout=request_timeout,
    )


def _require_openai():
    try:
        import openai  # noqa: PLC0415
    except ImportError as exc:
        raise EngineNotInstalledError("openai", _INSTALL_HINT) from exc
    return openai


def _tool_specs_to_openai(specs: list[ToolSpec]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Project ToolSpec list to Chat Completions tools; return api_name -> fqn map."""
    ordered = sorted(specs, key=lambda s: s.fqn)
    name_to_fqn: dict[str, str] = {}
    tools: list[dict[str, Any]] = []
    for i, spec in enumerate(ordered):
        api_name = f"wfm_t{i}"
        name_to_fqn[api_name] = spec.fqn
        schema = spec.json_schema if spec.json_schema else {}
        params: dict[str, Any]
        if not schema:
            params = {"type": "object", "properties": {}}
        elif isinstance(schema.get("type"), str) or "properties" in schema:
            params = schema
        else:
            params = schema
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": api_name,
                    "description": spec.title or spec.fqn,
                    "parameters": params,
                },
            }
        )
    return tools, name_to_fqn


def _assistant_message_payload(msg: Any) -> dict[str, Any]:
    """Serialize assistant ChatCompletionMessage to API message dict."""
    content = getattr(msg, "content", None)
    payload: dict[str, Any] = {"role": "assistant", "content": content}
    tool_calls = getattr(msg, "tool_calls", None)
    if tool_calls:
        serialized: list[dict[str, Any]] = []
        for tc in tool_calls:
            fn = getattr(tc, "function", None)
            serialized.append(
                {
                    "id": getattr(tc, "id", ""),
                    "type": getattr(tc, "type", "function") or "function",
                    "function": {
                        "name": getattr(fn, "name", "") if fn else "",
                        "arguments": getattr(fn, "arguments", "{}") if fn else "{}",
                    },
                }
            )
        payload["tool_calls"] = serialized
    elif content is None:
        payload["content"] = ""
    return payload


def _format_tool_result(result: ToolResult) -> str:
    payload = {
        "ok": result.ok,
        "data": result.data,
        "error": result.error,
        "error_code": result.error_code,
    }
    try:
        return json.dumps(payload, ensure_ascii=False, default=str)
    except TypeError:
        return str(payload)


def _usage_from_response(usage: Any, *, model: str | None = None) -> UsageStats | None:
    if usage is None:
        return None
    inp = getattr(usage, "prompt_tokens", None)
    out = getattr(usage, "completion_tokens", None)
    total = getattr(usage, "total_tokens", None)
    if inp is None and out is None and total is None:
        return None
    if isinstance(inp, int) and isinstance(out, int) and total is None:
        total = inp + out
    return UsageStats(
        input_tokens=inp if isinstance(inp, int) else None,
        output_tokens=out if isinstance(out, int) else None,
        total_tokens=total if isinstance(total, int) else None,
        cost_usd=None,
        provider="openai",
        model=model,
    )


def _extract_choice_text(message: Any) -> str:
    c = getattr(message, "content", None)
    if isinstance(c, str):
        return c.strip()
    if isinstance(c, list):
        parts: list[str] = []
        for block in c:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    t = block.get("text")
                    if isinstance(t, str):
                        parts.append(t)
            elif getattr(block, "type", None) == "text":
                t = getattr(block, "text", "")
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts).strip()
    return ""


class OpenAIEngine:
    """OpenAI Chat Completions tool loop; streaming mirrors Anthropic/DevUI executor pattern."""

    engine_id: ClassVar[str] = "openai"

    def run_turn(self, ctx: SessionContext, tools: ToolHandle) -> TurnResult:
        received_at = datetime.now(timezone.utc).isoformat()
        openai_sdk = _require_openai()
        cfg = _load_runtime_config(ctx)

        client_kwargs: dict[str, Any] = {"api_key": cfg.api_key}
        if cfg.base_url:
            client_kwargs["base_url"] = cfg.base_url
        client = openai_sdk.OpenAI(**client_kwargs)

        specs = tools.list_tool_specs()
        tools_param, name_to_fqn = _tool_specs_to_openai(specs)

        user_text = ctx.message
        if ctx.recipe_id:
            user_text = f"[recipe_id: {ctx.recipe_id}]\n{user_text}"

        messages: list[dict[str, Any]] = [{"role": "user", "content": user_text}]
        last_usage: UsageStats | None = None
        final_text = ""
        rounds = 0
        last_message: Any = None

        create_kwargs_base: dict[str, Any] = {
            "model": cfg.model,
            "timeout": cfg.request_timeout,
        }
        if tools_param:
            create_kwargs_base["tools"] = tools_param
            create_kwargs_base["tool_choice"] = "auto"

        try:
            while rounds < cfg.max_tool_rounds:
                if ctx.cancel_event.is_set():
                    break
                rounds += 1
                try:
                    resp = client.chat.completions.create(
                        **create_kwargs_base,
                        messages=messages,
                    )
                except openai_sdk.APIStatusError as exc:
                    status = int(getattr(exc, "status_code", 502) or 502)
                    raise OpenAIApiError(str(exc), status_code=status) from exc

                last_usage = (
                    _usage_from_response(getattr(resp, "usage", None), model=cfg.model)
                    or last_usage
                )
                choice = resp.choices[0]
                last_message = choice.message
                messages.append(_assistant_message_payload(last_message))

                tool_calls = getattr(last_message, "tool_calls", None) or []
                if not tool_calls:
                    final_text = _extract_choice_text(last_message)
                    break

                for tc in tool_calls:
                    fn = getattr(tc, "function", None)
                    name = getattr(fn, "name", "") if fn else ""
                    fqn = name_to_fqn.get(name)
                    raw_args = getattr(fn, "arguments", "{}") if fn else "{}"
                    try:
                        args = json.loads(raw_args) if isinstance(raw_args, str) else {}
                    except json.JSONDecodeError:
                        args = {}
                    if not isinstance(args, dict):
                        args = {}
                    if fqn is None:
                        content = json.dumps(
                            {"ok": False, "error": f"unknown tool name from model: {name!r}"},
                            ensure_ascii=False,
                        )
                    else:
                        result = tools.invoke(fqn, args)
                        content = _format_tool_result(result)
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": getattr(tc, "id", ""),
                            "content": content,
                        }
                    )

            if rounds >= cfg.max_tool_rounds and not final_text:
                final_text = _extract_choice_text(last_message) if last_message else ""
        except OpenAIConfigError:
            raise
        except EngineNotInstalledError:
            raise
        except OpenAIApiError:
            raise

        if not final_text.strip():
            final_text = "[openai] 未生成文本回复。"

        return TurnResult(
            content=final_text.strip(),
            workspace_root=ctx.workspace_root,
            received_at=received_at,
            trace_id=ctx.trace_id,
            engine=self.engine_id,
            usage=last_usage,
            tool_ledger=list(tools.ledger),
            finish_reason="stop",
        )

    async def stream_turn(
        self,
        ctx: SessionContext,
        tools: ToolHandle,
        *,
        tool_event_queue: asyncio.Queue[Any] | None = None,
        is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        loop = asyncio.get_running_loop()
        fut = loop.run_in_executor(None, self.run_turn, ctx, tools)

        while not fut.done():
            if is_disconnected is not None and await is_disconnected():
                ctx.cancel_event.set()
                break
            if tool_event_queue is not None:
                try:
                    raw = await asyncio.wait_for(tool_event_queue.get(), 0.05)
                    yield raw  # type: ignore[misc]
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(0.05)

        try:
            result: TurnResult = await fut
        except OpenAIConfigError as exc:
            yield ErrorStreamEvent(
                type="error",
                code=err.VALIDATION_ERROR,
                message=str(exc),
                trace_id=ctx.trace_id,
            )
            return
        except EngineNotInstalledError as exc:
            yield ErrorStreamEvent(
                type="error",
                code=err.ENGINE_NOT_INSTALLED,
                message=exc.hint,
                trace_id=ctx.trace_id,
            )
            return
        except OpenAIApiError as exc:
            code = (
                err.ENGINE_UPSTREAM_4XX
                if 400 <= exc.status_code < 500
                else err.ENGINE_UPSTREAM_5XX
            )
            yield ErrorStreamEvent(
                type="error",
                code=code,
                message=str(exc),
                trace_id=ctx.trace_id,
            )
            return
        except Exception as exc:  # pragma: no cover - defensive
            yield ErrorStreamEvent(
                type="error",
                code=err.ENGINE_ERROR,
                message=f"{type(exc).__name__}: {exc}",
                trace_id=ctx.trace_id,
            )
            return

        if tool_event_queue is not None:
            while True:
                try:
                    raw = tool_event_queue.get_nowait()
                    yield raw  # type: ignore[misc]
                except asyncio.QueueEmpty:
                    break

        if result.content:
            yield TextDeltaStreamEvent(type="text_delta", delta=result.content)
        yield DoneStreamEvent(
            type="done",
            trace_id=ctx.trace_id,
            usage=result.usage,
            finish_reason=result.finish_reason,
        )
