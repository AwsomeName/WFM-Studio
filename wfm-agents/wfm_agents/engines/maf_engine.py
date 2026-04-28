"""Microsoft Agent Framework engine (M5 — stub)."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, ClassVar

import asyncio

from ..gateway.exceptions import EngineNotInstalledError
from ..gateway.models import ErrorStreamEvent, StreamEvent, TurnResult
from ..gateway.session import SessionContext
from ..observability import errors as err
from ..tools.handle import ToolHandle


class MafEngine:
    engine_id: ClassVar[str] = "maf"

    def run_turn(self, ctx: SessionContext, tools: ToolHandle) -> TurnResult:
        raise EngineNotInstalledError(
            self.engine_id,
            "MAF 适配尚未启用：安装可选依赖后重试（例如 pip install 'wfm-agents[maf]'）。",
        )

    async def stream_turn(
        self,
        ctx: SessionContext,
        tools: ToolHandle,
        *,
        tool_event_queue: asyncio.Queue[Any] | None = None,
        is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        yield ErrorStreamEvent(
            type="error",
            code=err.ENGINE_NOT_INSTALLED,
            message=(
                "MAF 适配尚未启用：安装可选依赖后重试（例如 pip install 'wfm-agents[maf]'）。"
            ),
            trace_id=ctx.trace_id,
        )
