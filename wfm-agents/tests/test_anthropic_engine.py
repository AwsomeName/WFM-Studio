"""Anthropic engine: mocked SDK, no real API (ARCH anthropic adapter)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import anthropic
import pytest

from wfm_agents.engines import anthropic_engine as ae
from wfm_agents.engines.anthropic_errors import AnthropicConfigError
from wfm_agents.gateway.agent_gateway import AgentGateway, reset_default_agent_gateway_for_tests
from wfm_agents.gateway.models import TurnRequest
from wfm_agents.gateway.session import SessionContext
from wfm_agents.engines.registry import EngineRegistry
from wfm_agents.tools.builtin_provider import BuiltinToolProvider
from wfm_agents.tools.spec import ToolResult, ToolSpec
from wfm_agents.workspace import resolve_workspace_root


class _MessagesStub:
    def __init__(self, responses: list) -> None:
        self._responses = list(responses)

    def create(self, **kwargs):  # noqa: ANN003
        return self._responses.pop(0)


class _ClientStub:
    def __init__(self, responses: list) -> None:
        self.messages = _MessagesStub(responses)


@pytest.fixture
def root(tmp_path) -> str:
    return str(resolve_workspace_root(str(tmp_path)))


@pytest.fixture
def ctx(root: str) -> SessionContext:
    return SessionContext(workspace_root=root, trace_id="trace-anthropic", message="hello")


@pytest.fixture(autouse=True)
def _reset_gw():
    reset_default_agent_gateway_for_tests()
    yield
    reset_default_agent_gateway_for_tests()


def test_anthropic_config_missing_key(monkeypatch: pytest.MonkeyPatch, ctx: SessionContext) -> None:
    monkeypatch.delenv("WFM_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    handle = MagicMock()
    handle.list_tool_specs.return_value = []
    with pytest.raises(AnthropicConfigError):
        ae.AnthropicEngine().run_turn(ctx, handle)


def test_anthropic_text_only(monkeypatch: pytest.MonkeyPatch, ctx: SessionContext) -> None:
    monkeypatch.setenv("WFM_ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("WFM_ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
    resp = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="assistant says hi")],
        usage=SimpleNamespace(input_tokens=3, output_tokens=2),
    )

    def _ctor(**kwargs):  # noqa: ANN003
        return _ClientStub([resp])

    monkeypatch.setattr(anthropic, "Anthropic", _ctor)
    handle = MagicMock()
    handle.list_tool_specs.return_value = []
    out = ae.AnthropicEngine().run_turn(ctx, handle)
    assert out.content == "assistant says hi"
    assert out.usage is not None
    assert out.usage.input_tokens == 3
    assert out.usage.model == "claude-sonnet-4-20250514"


def test_anthropic_tool_roundtrip(monkeypatch: pytest.MonkeyPatch, ctx: SessionContext) -> None:
    monkeypatch.setenv("WFM_ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("WFM_ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
    resp_tool = SimpleNamespace(
        content=[
            SimpleNamespace(type="tool_use", id="call_1", name="wfm_t0", input={"path": "README.md"})
        ],
        usage=SimpleNamespace(input_tokens=10, output_tokens=5),
    )
    resp_text = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="read ok")],
        usage=SimpleNamespace(input_tokens=20, output_tokens=3),
    )

    def _ctor(**kwargs):  # noqa: ANN003
        return _ClientStub([resp_tool, resp_text])

    monkeypatch.setattr(anthropic, "Anthropic", _ctor)
    handle = MagicMock()
    handle.list_tool_specs.return_value = [
        ToolSpec(
            fqn="wfm.workspace_read",
            title="read",
            json_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            risk_tier="read",
            origin="builtin",
        ),
    ]
    handle.invoke.return_value = ToolResult(ok=True, data={"content": "x"})
    out = ae.AnthropicEngine().run_turn(ctx, handle)
    assert out.content == "read ok"
    handle.invoke.assert_called_once()
    assert handle.invoke.call_args[0][0] == "wfm.workspace_read"
    assert handle.invoke.call_args[0][1] == {"path": "README.md"}


@pytest.mark.asyncio
async def test_agent_gateway_anthropic_engine_registered(root: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WFM_ANTHROPIC_API_KEY", "sk-test")
    resp = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="gw")],
        usage=SimpleNamespace(input_tokens=1, output_tokens=1),
    )

    def _ctor(**kwargs):  # noqa: ANN003
        return _ClientStub([resp])

    monkeypatch.setattr(anthropic, "Anthropic", _ctor)
    from wfm_agents.engines.registry import build_default_engine_registry

    gw = AgentGateway(
        providers=[BuiltinToolProvider()],
        engine_registry=build_default_engine_registry(),
    )
    result = await gw.run_turn(
        TurnRequest(workspace_root=root, message="m", engine="anthropic")
    )
    assert result.engine == "anthropic"
    assert result.content == "gw"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_anthropic_live_optional(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Set ANTHROPIC_API_KEY in environment to exercise the real API (not CI default)."""
    import os

    if not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("WFM_ANTHROPIC_API_KEY")):
        pytest.skip("no Anthropic API key")
    root = str(resolve_workspace_root(str(tmp_path)))
    gw = AgentGateway(
        providers=[BuiltinToolProvider()],
        engine_registry=EngineRegistry(
            {"anthropic": ae.AnthropicEngine()},
        ),
    )
    out = await gw.run_turn(
        TurnRequest(workspace_root=root, message="Reply with exactly: pong", engine="anthropic")
    )
    assert "pong" in out.content.lower()
