"""Tool execution: policy, timeout, ledger, optional stream sink (DEV M1 / M3)."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel

from ..gateway.models import ToolCallRecord, ToolEndStreamEvent, ToolStartStreamEvent
from ..gateway.session import SessionContext
from ..observability import errors as err
from ..observability.trace import new_span_id
from .policy import ToolPolicy
from .registry import ToolRegistry
from .spec import ToolResult


def redact_args(args: dict[str, Any]) -> dict[str, Any]:
    """Mask common secret keys (DEV M1); nested dicts are shallow-walked."""
    sensitive_markers = ("password", "api_key", "secret", "token")
    out: dict[str, Any] = {}
    for key, value in args.items():
        lk = key.lower()
        if any(m in lk for m in sensitive_markers):
            out[key] = "***"
        elif isinstance(value, dict):
            out[key] = redact_args(value)
        else:
            out[key] = value
    return out


class ToolExecutor:
    """Single audit/execution gate for builtin (and later MCP) tools."""

    def __init__(
        self,
        registry: ToolRegistry,
        policy: ToolPolicy,
        *,
        event_sink: asyncio.Queue[BaseModel] | None = None,
        main_loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        self._registry = registry
        self._policy = policy
        self._call_count = 0
        self._ledger: list[ToolCallRecord] = []
        self._event_sink = event_sink
        self._main_loop = main_loop

    @property
    def ledger(self) -> list[ToolCallRecord]:
        return list(self._ledger)

    async def _emit_sink(self, ev: BaseModel) -> None:
        """Thread-safe enqueue for the ASGI loop (M3)."""
        if self._event_sink is None or self._main_loop is None:
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._main_loop:
            await self._event_sink.put(ev)
            return
        fut = asyncio.run_coroutine_threadsafe(self._event_sink.put(ev), self._main_loop)
        await asyncio.wait_for(asyncio.wrap_future(fut), timeout=120.0)

    def _append_ledger(
        self,
        *,
        call_id: str,
        fqn: str,
        args: dict[str, Any],
        result: ToolResult,
        error_code: str | None,
        started_at: str,
        t0: float,
    ) -> None:
        latency_ms = int((time.perf_counter() - t0) * 1000)
        ended_at = datetime.now(timezone.utc).isoformat()
        self._ledger.append(
            ToolCallRecord(
                call_id=call_id,
                fqn=fqn,
                args_redacted=redact_args(dict(args)),
                ok=result.ok,
                latency_ms=latency_ms,
                error_code=error_code,
                started_at=started_at,
                ended_at=ended_at,
            )
        )

    async def _emit_tool_end(
        self,
        *,
        call_id: str,
        result: ToolResult,
        error_code: str | None,
        t0: float,
    ) -> None:
        latency_ms = int((time.perf_counter() - t0) * 1000)
        await self._emit_sink(
            ToolEndStreamEvent(
                type="tool_end",
                call_id=call_id,
                ok=result.ok,
                latency_ms=latency_ms,
                error_code=error_code,
            )
        )

    async def execute_async(
        self,
        fqn: str,
        args: dict[str, Any],
        ctx: SessionContext,
    ) -> ToolResult:
        call_id = new_span_id()
        started_at = datetime.now(timezone.utc).isoformat()
        t0 = time.perf_counter()

        await self._emit_sink(
            ToolStartStreamEvent(type="tool_start", call_id=call_id, fqn=fqn)
        )

        if fqn in self._policy.disabled_fqns:
            result = ToolResult(ok=False, data=None, error="tool disabled by policy")
            await self._emit_tool_end(
                call_id=call_id, result=result, error_code=err.POLICY_DENY, t0=t0
            )
            self._append_ledger(
                call_id=call_id,
                fqn=fqn,
                args=args,
                result=result,
                error_code=err.POLICY_DENY,
                started_at=started_at,
                t0=t0,
            )
            return result

        if self._call_count >= self._policy.max_tool_calls_per_turn:
            result = ToolResult(ok=False, data=None, error="max_tool_calls_per_turn exceeded")
            await self._emit_tool_end(
                call_id=call_id, result=result, error_code=err.POLICY_DENY, t0=t0
            )
            self._append_ledger(
                call_id=call_id,
                fqn=fqn,
                args=args,
                result=result,
                error_code=err.POLICY_DENY,
                started_at=started_at,
                t0=t0,
            )
            return result

        self._call_count += 1

        if self._registry.find(fqn) is None:
            result = ToolResult(ok=False, data=None, error=f"unknown tool: {fqn}")
            await self._emit_tool_end(
                call_id=call_id, result=result, error_code=err.TOOL_NOT_FOUND, t0=t0
            )
            self._append_ledger(
                call_id=call_id,
                fqn=fqn,
                args=args,
                result=result,
                error_code=err.TOOL_NOT_FOUND,
                started_at=started_at,
                t0=t0,
            )
            return result

        owner = self._registry.owner(fqn)
        if owner is None:
            result = ToolResult(ok=False, data=None, error=f"no owner for tool: {fqn}")
            await self._emit_tool_end(
                call_id=call_id, result=result, error_code=err.TOOL_NOT_FOUND, t0=t0
            )
            self._append_ledger(
                call_id=call_id,
                fqn=fqn,
                args=args,
                result=result,
                error_code=err.TOOL_NOT_FOUND,
                started_at=started_at,
                t0=t0,
            )
            return result

        timeout_sec = self._policy.single_tool_timeout_ms / 1000.0

        def _run() -> ToolResult:
            return owner.execute(fqn, args, ctx)

        try:
            result = await asyncio.wait_for(asyncio.to_thread(_run), timeout=timeout_sec)
        except TimeoutError:
            result = ToolResult(ok=False, data=None, error="tool execution timed out")
            await self._emit_tool_end(
                call_id=call_id, result=result, error_code=err.TOOL_TIMEOUT, t0=t0
            )
            self._append_ledger(
                call_id=call_id,
                fqn=fqn,
                args=args,
                result=result,
                error_code=err.TOOL_TIMEOUT,
                started_at=started_at,
                t0=t0,
            )
            return result
        except Exception as exc:  # pragma: no cover - defensive
            result = ToolResult(ok=False, data=None, error=f"{type(exc).__name__}: {exc}")
            await self._emit_tool_end(
                call_id=call_id, result=result, error_code=err.ENGINE_ERROR, t0=t0
            )
            self._append_ledger(
                call_id=call_id,
                fqn=fqn,
                args=args,
                result=result,
                error_code=err.ENGINE_ERROR,
                started_at=started_at,
                t0=t0,
            )
            return result

        if result.ok:
            out_code: str | None = None
        else:
            out_code = result.error_code
        await self._emit_tool_end(
            call_id=call_id, result=result, error_code=out_code, t0=t0
        )
        self._append_ledger(
            call_id=call_id,
            fqn=fqn,
            args=args,
            result=result,
            error_code=out_code,
            started_at=started_at,
            t0=t0,
        )
        return result
