"""M3: POST /v1/chat/stream SSE + executor tool events on sink.

2026-05-14 SDK-native runner migration (see ``docs/ARCH_AGENT_SDK_NATIVE.md``):
the three route-level tests below pinned the **legacy** behaviour of the
``engine=crewai|maf|...`` fields on ``/v1/chat/stream``. After the runner
migration those fields are accepted-but-ignored (one warning per request),
so the assertions are no longer meaningful. Tests are kept and ``skip``-ped
rather than deleted — they document the abandoned contract until the
``engines/`` cleanup milestone removes both the legacy stream path and these
tests together.

The two gateway-internal tests (executor sink + ``stream_turn`` cancel) keep
running because they exercise modules that the runner still depends on
indirectly (and that the CAD branch will keep using until D2 下午).
"""

from __future__ import annotations

import json
import time

import pytest

_LEGACY_ENGINE_SKIP_REASON = (
    "Legacy engine route (crewai/maf/agenticx) is a no-op on the SDK-native "
    "runner; will be removed alongside engines/ cleanup."
)

from fastapi.testclient import TestClient

from wfm_agents.engines.crewai_engine import CrewAIEngine
from wfm_agents.engines.devui_engine import DevUIEngine
from wfm_agents.engines.registry import EngineRegistry
from wfm_agents.gateway.agent_gateway import AgentGateway
from wfm_agents.gateway.models import TurnRequest, TurnResult
from wfm_agents.gateway.session import SessionContext
from wfm_agents.observability.trace import new_trace_id
from wfm_agents.server import create_app
from wfm_agents.tools.builtin_provider import BuiltinToolProvider
from wfm_agents.tools.executor import ToolExecutor
from wfm_agents.tools.policy import ToolPolicy
from wfm_agents.tools.registry import ToolRegistry
from wfm_agents.workspace import resolve_workspace_root


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app())


def _parse_sse_events(raw: str) -> list[dict]:
    events: list[dict] = []
    for line in raw.split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            events.append(json.loads(line[5:].strip()))
    return events


@pytest.mark.skip(reason=_LEGACY_ENGINE_SKIP_REASON)
def test_chat_stream_echo_text_delta_and_done(client: TestClient, tmp_path) -> None:
    """显式 engine=crewai 走 CrewAI 的固定 echo 模板（默认引擎已切到 openai）。"""
    with client.stream(
        "POST",
        "/v1/chat/stream",
        json={
            "workspace_root": str(tmp_path),
            "message": "stream-hi",
            "engine": "crewai",
        },
    ) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    events = _parse_sse_events(body)
    types = [e["type"] for e in events]
    assert "text_delta" in types
    assert "done" in types
    assert any("stream-hi" in e.get("delta", "") for e in events if e["type"] == "text_delta")
    done = next(e for e in events if e["type"] == "done")
    assert done.get("trace_id")


@pytest.mark.skip(reason=_LEGACY_ENGINE_SKIP_REASON)
def test_chat_stream_maf_engine_adapter(client: TestClient, tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(DevUIEngine, "_call_devui_response", lambda self, ctx: "maf-stream-ok")
    with client.stream(
        "POST",
        "/v1/chat/stream",
        json={"workspace_root": str(tmp_path), "message": "x", "engine": "maf"},
    ) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    events = _parse_sse_events(body)
    assert any(e["type"] == "text_delta" and "maf-stream-ok" in e.get("delta", "") for e in events)
    assert events and events[-1]["type"] == "done"


@pytest.mark.skip(reason=_LEGACY_ENGINE_SKIP_REASON)
def test_chat_stream_crewai_config_error_event(client: TestClient, tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("WFM_CREWAI_MODEL", raising=False)
    with client.stream(
        "POST",
        "/v1/chat/stream",
        json={
            "workspace_root": str(tmp_path),
            "message": "crew",
            "mode": "single",
            "engine": "crewai",
        },
    ) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    events = _parse_sse_events(body)
    assert events and events[-1]["type"] == "error"
    assert events[-1]["code"] == "VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_executor_emits_tool_start_end_with_sink(tmp_path) -> None:
    import asyncio

    root = str(resolve_workspace_root(str(tmp_path)))
    ctx = SessionContext(workspace_root=root, trace_id=new_trace_id())
    loop = asyncio.get_running_loop()
    sink: asyncio.Queue = asyncio.Queue()
    reg = ToolRegistry.build(ctx, [BuiltinToolProvider()])
    ex = ToolExecutor(reg, ToolPolicy(), event_sink=sink, main_loop=loop)
    await ex.execute_async("wfm.workspace_read", {"path": "missing-for-stream.txt"}, ctx)
    items: list[object] = []
    while not sink.empty():
        items.append(sink.get_nowait())
    assert [getattr(x, "type", None) for x in items] == ["tool_start", "tool_end"]


class _SlowCrewaiEngine(CrewAIEngine):
    """Blocks until cancel_event so disconnect can be observed."""

    def run_turn(self, ctx: SessionContext, tools) -> TurnResult:
        from datetime import datetime, timezone

        for _ in range(300):
            if ctx.cancel_event.is_set():
                now = datetime.now(timezone.utc).isoformat()
                return TurnResult(
                    content="cancel-noticed",
                    workspace_root=ctx.workspace_root,
                    received_at=now,
                    trace_id=ctx.trace_id,
                    engine=self.engine_id,
                    usage=None,
                    tool_ledger=list(tools.ledger),
                    finish_reason="stop",
                )
            time.sleep(0.005)
        raise AssertionError("expected cancel_event before slow loop finished")


@pytest.mark.asyncio
async def test_stream_turn_disconnect_sets_cancel_event(tmp_path) -> None:
    root = str(resolve_workspace_root(str(tmp_path)))
    gw = AgentGateway(
        providers=[BuiltinToolProvider()],
        engine_registry=EngineRegistry({"crewai": _SlowCrewaiEngine()}),
    )
    turn = TurnRequest(
        workspace_root=root,
        message="x",
        engine="crewai",
        recipe_id="wfm.echo",
        client_meta={"wfm_chat_mode": "echo"},
    )
    n = 0

    async def disco() -> bool:
        nonlocal n
        n += 1
        return n >= 2

    deltas: list[str] = []
    async for ev in gw.stream_turn(turn, is_disconnected=disco):
        if getattr(ev, "type", None) == "text_delta":
            deltas.append(ev.delta)
    assert any("cancel-noticed" in d for d in deltas)
