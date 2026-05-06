"""AgentGateway: one turn orchestration (ARCH §3.2; DEV M2 sync + M3 stream)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from pydantic import BaseModel

from ..engines.base import EngineAdapter
from ..engines.registry import EngineRegistry, build_default_engine_registry
from ..observability import errors as err
from ..observability.trace import new_trace_id
from ..tools.builtin_provider import BuiltinToolProvider
from ..tools.handle import build_tool_handle
from ..tools.mcp import MCPClusterProvider, get_mcp_cluster
from ..tools.policy import ToolPolicy
from ..tools.registry import ToolProvider
from ..workspace import resolve_workspace_root
from .exceptions import EngineNotInstalledError
from .models import ErrorStreamEvent, StreamEvent, TurnRequest, TurnResult
from .session import SessionContext


class AgentGateway:
    """Builds session + tool snapshot + engine run_turn (sync engine in thread pool)."""

    def __init__(
        self,
        *,
        providers: Sequence[ToolProvider],
        engine_registry: EngineRegistry,
        default_policy: ToolPolicy | None = None,
    ) -> None:
        self._providers = list(providers)
        self._engine_registry = engine_registry
        self._default_policy = default_policy or ToolPolicy()

    async def run_turn(self, req: TurnRequest) -> TurnResult:
        root = resolve_workspace_root(req.workspace_root)
        trace_id = new_trace_id()
        ctx = SessionContext(
            workspace_root=str(root),
            trace_id=trace_id,
            message=req.message,
            session_id=req.session_id,
            recipe_id=req.recipe_id,
            model_override=req.model_override,
            client_meta=req.client_meta,
            tool_policy=self._default_policy,
        )
        handle = build_tool_handle(ctx, self._providers, self._default_policy)
        adapter = self._engine_registry.get(req.engine)
        return await asyncio.to_thread(adapter.run_turn, ctx, handle)

    async def stream_turn(
        self,
        req: TurnRequest,
        *,
        is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Async SSE event stream for one turn (ARCH §4.2)."""
        root = resolve_workspace_root(req.workspace_root)
        trace_id = new_trace_id()
        loop = asyncio.get_running_loop()
        sink: asyncio.Queue[BaseModel] = asyncio.Queue(maxsize=10_000)
        ctx = SessionContext(
            workspace_root=str(root),
            trace_id=trace_id,
            message=req.message,
            session_id=req.session_id,
            recipe_id=req.recipe_id,
            model_override=req.model_override,
            client_meta=req.client_meta,
            tool_policy=self._default_policy,
        )
        handle = build_tool_handle(
            ctx,
            self._providers,
            self._default_policy,
            event_sink=sink,
            main_loop=loop,
        )
        adapter = self._engine_registry.get(req.engine)
        try:
            async for ev in adapter.stream_turn(
                ctx,
                handle,
                tool_event_queue=sink,
                is_disconnected=is_disconnected,
            ):
                yield ev
        except EngineNotInstalledError as exc:
            yield ErrorStreamEvent(
                type="error",
                code=err.ENGINE_NOT_INSTALLED,
                message=exc.hint,
                trace_id=trace_id,
            )


_default_gateway: AgentGateway | None = None


def get_default_agent_gateway() -> AgentGateway:
    """Process-wide gateway (builtin + MCP + default engines)."""
    global _default_gateway
    if _default_gateway is None:
        get_mcp_cluster()  # ensure mcp config loaded / singleton
        _default_gateway = AgentGateway(
            providers=[BuiltinToolProvider(), MCPClusterProvider()],
            engine_registry=build_default_engine_registry(),
        )
    return _default_gateway


def reset_default_agent_gateway_for_tests() -> None:
    """Test hook to clear the lazy singleton and MCP process state."""
    from ..tools.mcp import reset_mcp_cluster_for_tests

    global _default_gateway
    _default_gateway = None
    reset_mcp_cluster_for_tests()
