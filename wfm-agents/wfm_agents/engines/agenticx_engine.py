"""AgenticX 引擎 in-tree 最小实现（M5；无默认重包；`[agenticx]` extra 预留给未来 SDK）。"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, ClassVar

from ..gateway.models import (
    DoneStreamEvent,
    StreamEvent,
    TextDeltaStreamEvent,
    TurnResult,
)
from ..gateway.session import SessionContext
from ..tools.handle import ToolHandle


def _turn_content(ctx: SessionContext) -> str:
    """不调用外部 LLM 的最小闭环，便于 smoke 与多引擎对比。"""
    received_at = datetime.now(timezone.utc).isoformat()
    return (
        f"[agenticx] 收到: {ctx.message}\n"
        f"工作区: {ctx.workspace_root}\n"
        f"时间(UTC): {received_at}（in-tree 最小，未接外部 LLM）"
    )


class AgenticxEngine:
    engine_id: ClassVar[str] = "agenticx"

    def run_turn(self, ctx: SessionContext, tools: ToolHandle) -> TurnResult:
        received_at = datetime.now(timezone.utc).isoformat()
        return TurnResult(
            content=_turn_content(ctx),
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
        loop = asyncio.get_running_loop()
        fut = loop.run_in_executor(None, self.run_turn, ctx, tools)
        if tool_event_queue is not None:
            while not fut.done():
                try:
                    raw = await asyncio.wait_for(tool_event_queue.get(), 0.05)
                    yield raw
                except asyncio.TimeoutError:
                    if is_disconnected and await is_disconnected():
                        ctx.cancel_event.set()
        result: TurnResult = await fut
        if result.content:
            yield TextDeltaStreamEvent(type="text_delta", delta=result.content)
        yield DoneStreamEvent(
            type="done",
            trace_id=ctx.trace_id,
            usage=result.usage,
            finish_reason=result.finish_reason,
        )
