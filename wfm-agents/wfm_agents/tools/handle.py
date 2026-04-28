"""ToolHandle: engine-facing thin API over ToolExecutor (ARCH §3.6)."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any

from ..gateway.models import ToolCallRecord
from ..gateway.session import SessionContext
from .executor import ToolExecutor
from .policy import ToolPolicy
from .registry import ToolProvider, ToolRegistry
from .spec import ToolResult, ToolSpec


class ToolHandle:
    """Frozen tool list + invoke; engines must not touch disk/MCP except here."""

    def __init__(
        self,
        registry: ToolRegistry,
        executor: ToolExecutor,
        ctx: SessionContext,
    ) -> None:
        self._registry = registry
        self._executor = executor
        self._ctx = ctx

    def list_tool_specs(self) -> list[ToolSpec]:
        return list(self._registry.snapshot())

    @property
    def ledger(self) -> list[ToolCallRecord]:
        """Tool invocations recorded this turn (read-only)."""
        return self._executor.ledger

    def invoke(self, fqn: str, args: dict[str, Any]) -> ToolResult:
        """Run a tool from a non-async context (e.g. CrewAI thread)."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self._executor.execute_async(fqn, args, self._ctx))
        raise RuntimeError(
            "ToolHandle.invoke() cannot be used inside a running event loop; "
            "await ToolHandle.invoke_async() instead."
        )

    async def invoke_async(self, fqn: str, args: dict[str, Any]) -> ToolResult:
        return await self._executor.execute_async(fqn, args, self._ctx)


def build_tool_handle(
    ctx: SessionContext,
    providers: Sequence[ToolProvider],
    policy: ToolPolicy | None = None,
    *,
    event_sink: asyncio.Queue | None = None,
    main_loop: asyncio.AbstractEventLoop | None = None,
) -> ToolHandle:
    """Build registry + executor + handle for one turn (M1 helper; M3 optional SSE sink)."""
    pol = policy or ToolPolicy()
    registry = ToolRegistry.build(ctx, providers)
    executor = ToolExecutor(registry, pol, event_sink=event_sink, main_loop=main_loop)
    return ToolHandle(registry, executor, ctx)
