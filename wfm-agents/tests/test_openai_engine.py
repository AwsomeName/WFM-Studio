"""OpenAI engine: mocked SDK, no real API."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import openai
import pytest

from wfm_agents.engines import openai_engine as oe
from wfm_agents.engines.openai_errors import OpenAIConfigError
from wfm_agents.gateway.agent_gateway import AgentGateway, reset_default_agent_gateway_for_tests
from wfm_agents.gateway.models import TurnRequest
from wfm_agents.gateway.session import SessionContext
from wfm_agents.engines.registry import EngineRegistry
from wfm_agents.tools.builtin_provider import BuiltinToolProvider
from wfm_agents.tools.spec import ToolResult, ToolSpec
from wfm_agents.workspace import resolve_workspace_root


class _ChatCompletionsStub:
    def __init__(self, responses: list) -> None:
        self._responses = list(responses)

    def create(self, **kwargs):  # noqa: ANN003
        return self._responses.pop(0)


class _ChatStub:
    def __init__(self, responses: list) -> None:
        self.completions = _ChatCompletionsStub(responses)


class _ClientStub:
    def __init__(self, responses: list) -> None:
        self.chat = _ChatStub(responses)


@pytest.fixture
def root(tmp_path) -> str:
    return str(resolve_workspace_root(str(tmp_path)))


@pytest.fixture
def ctx(root: str) -> SessionContext:
    return SessionContext(workspace_root=root, trace_id="trace-openai", message="hello")


@pytest.fixture(autouse=True)
def _reset_gw():
    reset_default_agent_gateway_for_tests()
    yield
    reset_default_agent_gateway_for_tests()


def test_openai_config_missing_key(monkeypatch: pytest.MonkeyPatch, ctx: SessionContext) -> None:
    monkeypatch.delenv("WFM_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    handle = MagicMock()
    handle.list_tool_specs.return_value = []
    with pytest.raises(OpenAIConfigError):
        oe.OpenAIEngine().run_turn(ctx, handle)


def test_openai_text_only(monkeypatch: pytest.MonkeyPatch, ctx: SessionContext) -> None:
    monkeypatch.setenv("WFM_OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("WFM_OPENAI_MODEL", "gpt-4o-mini")
    resp = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="assistant says hi", tool_calls=None))],
        usage=SimpleNamespace(prompt_tokens=3, completion_tokens=2, total_tokens=5),
    )

    def _ctor(**kwargs):  # noqa: ANN003
        return _ClientStub([resp])

    monkeypatch.setattr(openai, "OpenAI", _ctor)
    handle = MagicMock()
    handle.list_tool_specs.return_value = []
    out = oe.OpenAIEngine().run_turn(ctx, handle)
    assert out.content == "assistant says hi"
    assert out.usage is not None
    assert out.usage.input_tokens == 3
    assert out.usage.model == "gpt-4o-mini"


def test_openai_tool_roundtrip(monkeypatch: pytest.MonkeyPatch, ctx: SessionContext) -> None:
    monkeypatch.setenv("WFM_OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("WFM_OPENAI_MODEL", "gpt-4o-mini")
    tc = SimpleNamespace(
        id="call_1",
        type="function",
        function=SimpleNamespace(name="wfm_t0", arguments='{"path": "README.md"}'),
    )
    resp_tool = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=[tc]))],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15),
    )
    resp_text = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="read ok", tool_calls=None))],
        usage=SimpleNamespace(prompt_tokens=20, completion_tokens=3, total_tokens=23),
    )

    def _ctor(**kwargs):  # noqa: ANN003
        return _ClientStub([resp_tool, resp_text])

    monkeypatch.setattr(openai, "OpenAI", _ctor)
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
    out = oe.OpenAIEngine().run_turn(ctx, handle)
    assert out.content == "read ok"
    handle.invoke.assert_called_once()
    assert handle.invoke.call_args[0][0] == "wfm.workspace_read"
    assert handle.invoke.call_args[0][1] == {"path": "README.md"}


@pytest.mark.asyncio
async def test_agent_gateway_openai_engine_registered(root: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WFM_OPENAI_API_KEY", "sk-test")
    resp = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="gw", tool_calls=None))],
        usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2),
    )

    def _ctor(**kwargs):  # noqa: ANN003
        return _ClientStub([resp])

    monkeypatch.setattr(openai, "OpenAI", _ctor)
    from wfm_agents.engines.registry import build_default_engine_registry

    gw = AgentGateway(
        providers=[BuiltinToolProvider()],
        engine_registry=build_default_engine_registry(),
    )
    result = await gw.run_turn(
        TurnRequest(workspace_root=root, message="m", engine="openai")
    )
    assert result.engine == "openai"
    assert result.content == "gw"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_openai_live_optional(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Set OPENAI_API_KEY in environment to exercise the real API (not CI default)."""
    import os

    if not (os.getenv("OPENAI_API_KEY") or os.getenv("WFM_OPENAI_API_KEY")):
        pytest.skip("no OpenAI API key")
    root = str(resolve_workspace_root(str(tmp_path)))
    gw = AgentGateway(
        providers=[BuiltinToolProvider()],
        engine_registry=EngineRegistry(
            {"openai": oe.OpenAIEngine()},
        ),
    )
    out = await gw.run_turn(
        TurnRequest(workspace_root=root, message="Reply with exactly: pong", engine="openai")
    )
    assert "pong" in out.content.lower()
