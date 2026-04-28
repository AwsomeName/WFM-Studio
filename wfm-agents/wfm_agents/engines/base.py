"""Engine adapter protocol (ARCH §3.6; sync M2 + stream M3)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Protocol, runtime_checkable

from ..gateway.models import StreamEvent, TurnResult
from ..gateway.session import SessionContext
from ..tools.handle import ToolHandle


@runtime_checkable
class EngineAdapter(Protocol):
    """Runs one user turn using only ToolHandle for side effects."""

    engine_id: str

    def run_turn(self, ctx: SessionContext, tools: ToolHandle) -> TurnResult:
        """Blocking implementation; invoked via `asyncio.to_thread` from the gateway."""
        ...

    def stream_turn(
        self,
        ctx: SessionContext,
        tools: ToolHandle,
        *,
        tool_event_queue: asyncio.Queue[Any] | None = None,
        is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """SSE event stream for one turn (ARCH §4.2)."""
        ...
