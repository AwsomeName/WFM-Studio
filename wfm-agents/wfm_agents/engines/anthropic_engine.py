"""Anthropic Messages API engine — tool loop via ToolHandle only (ARCH §3.6)."""

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
from .anthropic_errors import AnthropicApiError, AnthropicConfigError

_INSTALL_HINT = (
    "Anthropic SDK 未安装。请执行: uv sync --extra anthropic "
    "或 pip install 'wfm-agents[anthropic]'"
)

_DEFAULT_MODEL = "claude-sonnet-4-20250514"


@dataclass(frozen=True)
class _AnthropicRuntimeConfig:
    api_key: str
    model: str
    max_tool_rounds: int
    base_url: str | None


def _load_runtime_config(ctx: SessionContext) -> _AnthropicRuntimeConfig:
    key = (getenv("WFM_ANTHROPIC_API_KEY") or getenv("ANTHROPIC_API_KEY") or "").strip()
    if not key:
        raise AnthropicConfigError(
            "未配置 Anthropic API Key：请设置 WFM_ANTHROPIC_API_KEY 或 ANTHROPIC_API_KEY。"
        )
    model = (ctx.model_override or getenv("WFM_ANTHROPIC_MODEL") or _DEFAULT_MODEL).strip()
    rounds_raw = (getenv("WFM_ANTHROPIC_MAX_TOOL_ROUNDS") or "16").strip()
    try:
        max_tool_rounds = int(rounds_raw)
    except ValueError as exc:
        raise AnthropicConfigError(
            f"WFM_ANTHROPIC_MAX_TOOL_ROUNDS 非法: {rounds_raw!r}"
        ) from exc
    if max_tool_rounds <= 0:
        raise AnthropicConfigError("WFM_ANTHROPIC_MAX_TOOL_ROUNDS 必须 > 0")
    base = (getenv("WFM_ANTHROPIC_BASE_URL") or "").strip() or None
    return _AnthropicRuntimeConfig(
        api_key=key,
        model=model,
        max_tool_rounds=max_tool_rounds,
        base_url=base,
    )


def _require_anthropic():
    try:
        import anthropic  # noqa: PLC0415
    except ImportError as exc:
        raise EngineNotInstalledError("anthropic", _INSTALL_HINT) from exc
    return anthropic


def _tool_specs_to_anthropic(
    specs: list[ToolSpec],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Project ToolSpec list to Claude tools; return api_name -> fqn map."""
    ordered = sorted(specs, key=lambda s: s.fqn)
    name_to_fqn: dict[str, str] = {}
    tools: list[dict[str, Any]] = []
    for i, spec in enumerate(ordered):
        api_name = f"wfm_t{i}"
        name_to_fqn[api_name] = spec.fqn
        schema = spec.json_schema if spec.json_schema else {}
        if not schema:
            input_schema: dict[str, Any] = {"type": "object", "properties": {}}
        else:
            input_schema = schema
        tools.append(
            {
                "name": api_name,
                "description": spec.title,
                "input_schema": input_schema,
            }
        )
    return tools, name_to_fqn


def _content_blocks_to_param(
    content: list[Any],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for block in content:
        btype = getattr(block, "type", None)
        if btype == "text":
            out.append({"type": "text", "text": getattr(block, "text", "")})
        elif btype == "tool_use":
            out.append(
                {
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                }
            )
    return out


def _extract_text(content: list[Any]) -> str:
    parts: list[str] = []
    for block in content:
        if getattr(block, "type", None) == "text":
            t = getattr(block, "text", "")
            if isinstance(t, str) and t:
                parts.append(t)
    return "".join(parts).strip()


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
    inp = getattr(usage, "input_tokens", None)
    out = getattr(usage, "output_tokens", None)
    if inp is None and out is None:
        return None
    total = None
    if isinstance(inp, int) and isinstance(out, int):
        total = inp + out
    return UsageStats(
        input_tokens=inp if isinstance(inp, int) else None,
        output_tokens=out if isinstance(out, int) else None,
        total_tokens=total,
        cost_usd=None,
        provider="anthropic",
        model=model,
    )


class AnthropicEngine:
    """Sync Claude Messages loop; streaming mirrors DevUIEngine (executor + drain)."""

    engine_id: ClassVar[str] = "anthropic"

    def run_turn(self, ctx: SessionContext, tools: ToolHandle) -> TurnResult:
        received_at = datetime.now(timezone.utc).isoformat()
        anthropic = _require_anthropic()
        cfg = _load_runtime_config(ctx)

        client_kwargs: dict[str, Any] = {"api_key": cfg.api_key}
        if cfg.base_url:
            client_kwargs["base_url"] = cfg.base_url
        client = anthropic.Anthropic(**client_kwargs)

        specs = tools.list_tool_specs()
        tools_param, name_to_fqn = _tool_specs_to_anthropic(specs)

        user_text = ctx.message
        if ctx.recipe_id:
            user_text = f"[recipe_id: {ctx.recipe_id}]\n{user_text}"

        messages: list[dict[str, Any]] = [{"role": "user", "content": user_text}]
        last_usage: UsageStats | None = None
        final_text = ""
        rounds = 0
        assistant_blocks: list[Any] = []

        create_kwargs_base: dict[str, Any] = {
            "model": cfg.model,
            "max_tokens": 16_384,
        }
        if tools_param:
            create_kwargs_base["tools"] = tools_param

        try:
            while rounds < cfg.max_tool_rounds:
                if ctx.cancel_event.is_set():
                    break
                rounds += 1
                try:
                    resp = client.messages.create(
                        **create_kwargs_base,
                        messages=messages,
                    )
                except anthropic.APIStatusError as exc:
                    status = int(getattr(exc, "status_code", 502) or 502)
                    raise AnthropicApiError(str(exc), status_code=status) from exc

                last_usage = (
                    _usage_from_response(getattr(resp, "usage", None), model=cfg.model)
                    or last_usage
                )

                assistant_blocks = list(resp.content)
                messages.append(
                    {"role": "assistant", "content": _content_blocks_to_param(assistant_blocks)}
                )

                tool_uses = [
                    b for b in assistant_blocks if getattr(b, "type", None) == "tool_use"
                ]
                if not tool_uses:
                    final_text = _extract_text(assistant_blocks)
                    break

                tool_result_items: list[dict[str, Any]] = []
                for tu in tool_uses:
                    name = getattr(tu, "name", "")
                    fqn = name_to_fqn.get(name)
                    if fqn is None:
                        tool_result_items.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": tu.id,
                                "content": json.dumps(
                                    {
                                        "ok": False,
                                        "error": f"unknown tool name from model: {name!r}",
                                    },
                                    ensure_ascii=False,
                                ),
                            }
                        )
                        continue
                    raw_input = getattr(tu, "input", None)
                    args = raw_input if isinstance(raw_input, dict) else {}
                    result = tools.invoke(fqn, args)
                    tool_result_items.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": tu.id,
                            "content": _format_tool_result(result),
                        }
                    )

                messages.append({"role": "user", "content": tool_result_items})

            if rounds >= cfg.max_tool_rounds and not final_text:
                final_text = _extract_text(assistant_blocks)
        except AnthropicConfigError:
            raise
        except EngineNotInstalledError:
            raise
        except AnthropicApiError:
            raise

        if not final_text.strip():
            final_text = "[anthropic] 未生成文本回复。"

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
        except AnthropicConfigError as exc:
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
        except AnthropicApiError as exc:
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
