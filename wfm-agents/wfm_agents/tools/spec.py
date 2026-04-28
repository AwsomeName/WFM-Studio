"""ToolSpec and ToolResult (DEV M0; ARCH §3.3 / §8.5)."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

RiskTier = Literal["read", "write", "exec"]
# ARCH §3.3: origin is `builtin` or `mcp:{server_id}` (server_id: [a-z0-9_-]+).
ToolOriginStr = Annotated[
    str,
    Field(pattern=r"^(builtin|mcp:[a-z0-9_-]+)$"),
]


class ToolSpec(BaseModel):
    """Registered tool metadata exposed to engines (projection source)."""

    model_config = ConfigDict(extra="forbid")

    fqn: str = Field(..., description="Fully qualified name, e.g. wfm.workspace_read")
    title: str
    json_schema: dict[str, Any] = Field(default_factory=dict)
    risk_tier: RiskTier
    origin: ToolOriginStr = Field(
        ...,
        description="builtin or mcp:{server_id} per ARCH §3.3.",
    )


class ToolResult(BaseModel):
    """Unified tool execution outcome."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    data: Any = None
    error: str | None = None
    error_code: str | None = None
