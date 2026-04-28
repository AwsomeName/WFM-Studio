"""MCP tools merged into ToolRegistry (ARCH §3.3 FQN mcp.*)."""

from __future__ import annotations

import threading
from typing import Any

from ...gateway.session import SessionContext
from ...tools.spec import ToolResult, ToolSpec
from .cluster import MCPCluster, get_mcp_cluster, parse_mcp_fqn

_list_lock = threading.RLock()


class MCPClusterProvider:
    """Exposes mcp.* tools; list_tools uses TTL (ARCH §3.5)."""

    def __init__(self, cluster: MCPCluster | None = None) -> None:
        self._cluster = cluster

    def _c(self) -> MCPCluster:
        return self._cluster or get_mcp_cluster()

    def list_tool_specs(self, ctx: SessionContext) -> list[ToolSpec]:
        pol = ctx.tool_policy
        ttl = pol.mcp_list_tools_ttl_ms if pol is not None else 30_000
        with _list_lock:
            return self._c().list_tool_specs_cached(ttl)

    def execute(self, fqn: str, args: dict[str, Any], ctx: SessionContext) -> ToolResult:
        parsed = parse_mcp_fqn(fqn)
        if parsed is None:
            return ToolResult(ok=False, data=None, error="not an mcp fqn", error_code=None)
        server_id, tool_name = parsed
        server = self._c().server_by_id(server_id)
        if server is None:
            return ToolResult(
                ok=False,
                data=None,
                error=f"unknown mcp server_id: {server_id!r}",
                error_code=None,
            )
        pol = ctx.tool_policy
        op_ms = pol.mcp_cluster_timeout_ms if pol is not None else 60_000
        return self._c().call_tool_sync(
            server,
            tool_name,
            args,
            op_timeout_sec=op_ms / 1000.0,
        )
