"""HTTP / gateway data models (ARCH_AGENT_GATEWAY §8, §4.3)."""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

EngineId = Literal["crewai", "maf", "agenticx", "openai"]


class TurnRequest(BaseModel):
    """Inbound chat turn (ARCH §8.1)."""

    model_config = ConfigDict(extra="forbid")

    workspace_root: str
    message: str = Field(..., min_length=1)
    engine: EngineId
    session_id: str | None = None
    recipe_id: str | None = None
    model_override: str | None = None
    tool_policy_override: dict[str, Any] | None = None
    client_meta: dict[str, Any] | None = None


class UsageStats(BaseModel):
    """Normalized token / cost usage (ARCH §8.6)."""

    model_config = ConfigDict(extra="forbid")

    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    cost_usd: float | None = None
    provider: str | None = None
    model: str | None = None


class ToolCallRecord(BaseModel):
    """One tool invocation in the ledger (ARCH §8.3 + §8.4 call_id)."""

    model_config = ConfigDict(extra="forbid")

    call_id: str
    fqn: str
    args_redacted: dict[str, Any] = Field(default_factory=dict)
    ok: bool
    latency_ms: int
    error_code: str | None = None
    started_at: str
    ended_at: str


class TurnResult(BaseModel):
    """Synchronous turn response (ARCH §8.2)."""

    model_config = ConfigDict(extra="forbid")

    content: str
    workspace_root: str
    received_at: str
    trace_id: str
    engine: str
    usage: UsageStats | None = None
    tool_ledger: list[ToolCallRecord] = Field(default_factory=list)
    finish_reason: str | None = None


# --- Stream events (ARCH §4.3); discriminator is `type`. ---


class TextDeltaStreamEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["text_delta"] = "text_delta"
    delta: str


class ToolStartStreamEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["tool_start"] = "tool_start"
    call_id: str
    fqn: str


class ToolEndStreamEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["tool_end"] = "tool_end"
    call_id: str
    ok: bool
    latency_ms: int
    error_code: str | None = None


class DoneStreamEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["done"] = "done"
    trace_id: str
    usage: UsageStats | None = None
    finish_reason: str | None = None


class ErrorStreamEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["error"] = "error"
    code: str
    message: str
    trace_id: str | None = None


StreamEvent = Annotated[
    Union[
        TextDeltaStreamEvent,
        ToolStartStreamEvent,
        ToolEndStreamEvent,
        DoneStreamEvent,
        ErrorStreamEvent,
    ],
    Field(discriminator="type"),
]

stream_event_adapter: TypeAdapter[StreamEvent] = TypeAdapter(StreamEvent)


def parse_stream_event(data: object) -> StreamEvent:
    """Parse a dict/JSON object into a frozen StreamEvent variant."""
    return stream_event_adapter.validate_python(data)
