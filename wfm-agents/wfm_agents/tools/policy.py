"""Tool execution policy defaults (ARCH §11)."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ToolPolicy:
    max_tool_calls_per_turn: int = 12
    single_tool_timeout_ms: int = 20_000
    mcp_cluster_timeout_ms: int = 60_000
    mcp_list_tools_ttl_ms: int = 30_000
    artifact_inline_threshold_bytes: int = 32_768
    disabled_fqns: frozenset[str] = field(default_factory=frozenset)
    mcp_tier_allowlist: frozenset[str] = field(default_factory=frozenset)
