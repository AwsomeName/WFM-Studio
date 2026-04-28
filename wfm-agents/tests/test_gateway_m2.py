"""M2: AgentGateway + engine registry + ENGINE_NOT_INSTALLED (DEV_AGENT_GATEWAY §M2)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import ClassVar

import pytest

from wfm_agents.gateway.agent_gateway import AgentGateway, reset_default_agent_gateway_for_tests
from wfm_agents.gateway.exceptions import EngineNotInstalledError
from wfm_agents.gateway.models import (
    DoneStreamEvent,
    TextDeltaStreamEvent,
    TurnRequest,
    TurnResult,
)
from wfm_agents.gateway.session import SessionContext
from wfm_agents.tools.builtin_provider import BuiltinToolProvider
from wfm_agents.tools.handle import ToolHandle
from wfm_agents.engines.registry import EngineRegistry, build_default_engine_registry
from wfm_agents.workspace import resolve_workspace_root


class _MockCrewaiEngine:
    engine_id: ClassVar[str] = "crewai"

    def run_turn(self, ctx: SessionContext, tools: ToolHandle) -> TurnResult:
        now = datetime.now(timezone.utc).isoformat()
        return TurnResult(
            content="mock-ok",
            workspace_root=ctx.workspace_root,
            received_at=now,
            trace_id=ctx.trace_id,
            engine=self.engine_id,
            usage=None,
            tool_ledger=list(tools.ledger),
            finish_reason="stop",
        )

    async def stream_turn(self, ctx, tools, **kwargs):
        yield TextDeltaStreamEvent(type="text_delta", delta="stream-mock")
        yield DoneStreamEvent(
            type="done",
            trace_id=ctx.trace_id,
            usage=None,
            finish_reason="stop",
        )


@pytest.mark.asyncio
async def test_run_turn_propagates_trace_id(tmp_path) -> None:
    root = str(resolve_workspace_root(str(tmp_path)))
    gw = AgentGateway(
        providers=[BuiltinToolProvider()],
        engine_registry=EngineRegistry({"crewai": _MockCrewaiEngine()}),
    )
    result = await gw.run_turn(
        TurnRequest(workspace_root=root, message="hi", engine="crewai", client_meta={"wfm_chat_mode": "echo"})
    )
    assert result.content == "mock-ok"
    assert result.trace_id
    assert result.engine == "crewai"


@pytest.mark.asyncio
async def test_maf_engine_not_installed(tmp_path) -> None:
    root = str(resolve_workspace_root(str(tmp_path)))
    gw = AgentGateway(
        providers=[BuiltinToolProvider()],
        engine_registry=build_default_engine_registry(),
    )
    with pytest.raises(EngineNotInstalledError) as ei:
        await gw.run_turn(TurnRequest(workspace_root=root, message="x", engine="maf"))
    assert ei.value.engine_id == "maf"


@pytest.fixture(autouse=True)
def _reset_gateway_singleton():
    reset_default_agent_gateway_for_tests()
    yield
    reset_default_agent_gateway_for_tests()
