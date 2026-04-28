"""CrewAI engine: echo + single/multi via existing crewai_runtime (DEV M2 / M3 stream)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, ClassVar, Literal

from ..crewai_runtime import CrewRuntimeConfigError, run_crewai_chat
from ..gateway.models import (
    DoneStreamEvent,
    ErrorStreamEvent,
    StreamEvent,
    TextDeltaStreamEvent,
    TurnResult,
)
from ..gateway.session import SessionContext
from ..observability import errors as err
from ..tools.handle import ToolHandle

ChatMode = Literal["echo", "single", "multi"]


class CrewAIEngine:
    """Delegates LLM work to `crewai_runtime`; does not touch disk except via tools."""

    engine_id: ClassVar[str] = "crewai"

    def run_turn(self, ctx: SessionContext, tools: ToolHandle) -> TurnResult:
        received_at = datetime.now(timezone.utc).isoformat()
        mode = self._resolve_mode(ctx)

        if mode == "echo":
            content = (
                f"[echo] 收到消息: {ctx.message}\n"
                f"当前工作区: {ctx.workspace_root}\n"
                f"服务器时间: {received_at}"
            )
        else:
            content = run_crewai_chat(
                mode=mode,
                message=ctx.message,
                workspace_root=ctx.workspace_root,
            )

        return TurnResult(
            content=content,
            workspace_root=ctx.workspace_root,
            received_at=received_at,
            trace_id=ctx.trace_id,
            engine=self.engine_id,
            usage=None,
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
        """Run blocking `run_turn` in executor thread; drain tool SSE queue on this loop."""
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
        except CrewRuntimeConfigError as exc:
            yield ErrorStreamEvent(
                type="error",
                code=err.VALIDATION_ERROR,
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

    def _resolve_mode(self, ctx: SessionContext) -> ChatMode:
        if ctx.recipe_id == "wfm.echo":
            return "echo"
        meta = ctx.client_meta or {}
        raw = meta.get("wfm_chat_mode", "echo")
        if raw in ("echo", "single", "multi"):
            return raw  # type: ignore[return-value]
        return "echo"
