"""M0 acceptance: TurnRequest + StreamEvent discriminated union (DEV_AGENT_GATEWAY §M0)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from wfm_agents.tools.spec import ToolSpec

from wfm_agents.gateway.models import (
    DoneStreamEvent,
    ErrorStreamEvent,
    TextDeltaStreamEvent,
    ToolEndStreamEvent,
    ToolStartStreamEvent,
    TurnRequest,
    parse_stream_event,
)


def test_turn_request_minimal_ok(tmp_path) -> None:
    req = TurnRequest.model_validate(
        {
            "workspace_root": str(tmp_path),
            "message": "hello",
            "engine": "crewai",
        }
    )
    assert req.engine == "crewai"
    assert req.message == "hello"


def test_turn_request_rejects_unknown_engine(tmp_path) -> None:
    with pytest.raises(ValidationError):
        TurnRequest.model_validate(
            {
                "workspace_root": str(tmp_path),
                "message": "x",
                "engine": "unknown",
            }
        )


def test_turn_request_forbids_extra_fields(tmp_path) -> None:
    with pytest.raises(ValidationError):
        TurnRequest.model_validate(
            {
                "workspace_root": str(tmp_path),
                "message": "x",
                "engine": "crewai",
                "unexpected": 1,
            }
        )


@pytest.mark.parametrize(
    ("payload", "expected_type"),
    [
        ({"type": "text_delta", "delta": "a"}, TextDeltaStreamEvent),
        (
            {"type": "tool_start", "call_id": "c1", "fqn": "wfm.workspace_read"},
            ToolStartStreamEvent,
        ),
        (
            {
                "type": "tool_end",
                "call_id": "c1",
                "ok": True,
                "latency_ms": 12,
            },
            ToolEndStreamEvent,
        ),
        (
            {
                "type": "done",
                "trace_id": "t-1",
                "finish_reason": "stop",
            },
            DoneStreamEvent,
        ),
        (
            {
                "type": "error",
                "code": "ENGINE_ERROR",
                "message": "boom",
                "trace_id": "t-2",
            },
            ErrorStreamEvent,
        ),
    ],
)
def test_parse_stream_event_each_type(payload: dict, expected_type: type) -> None:
    ev = parse_stream_event(payload)
    assert isinstance(ev, expected_type)


def test_parse_stream_event_rejects_unknown_type() -> None:
    with pytest.raises(ValidationError):
        parse_stream_event({"type": "nope", "delta": "x"})


def test_tool_spec_origin_patterns() -> None:
    ToolSpec(
        fqn="wfm.workspace_read",
        title="Read",
        json_schema={},
        risk_tier="read",
        origin="builtin",
    )
    ToolSpec(
        fqn="mcp.srv.echo",
        title="Echo",
        json_schema={},
        risk_tier="read",
        origin="mcp:srv",
    )
    with pytest.raises(ValidationError):
        ToolSpec(
            fqn="x",
            title="x",
            risk_tier="read",
            origin="mcp:BadId",
        )
