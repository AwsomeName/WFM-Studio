"""MCPCluster: aggregate list_tools with TTL, FQN mcp.{id}.{name} (ARCH §3.5)."""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Any

import mcp.types as mcp_types

from ...observability import errors as err
from ...tools.spec import ToolResult, ToolSpec
from .config import McpConfig, McpServerEntry, load_mcp_config
from .connection import mcp_result_to_data, run_mcp_coro_in_thread, with_mcp_session

_FQN_RE = re.compile(r"^mcp\.(?P<sid>[a-z0-9_-]+)\.(?P<tool>.+)$")

_mcp_lock = threading.RLock()
_mcp_cluster: MCPCluster | None = None


def parse_mcp_fqn(fqn: str) -> tuple[str, str] | None:
    m = _FQN_RE.match(fqn)
    if m is None:
        return None
    return m.group("sid"), m.group("tool")


def reset_mcp_cluster_for_tests() -> None:
    global _mcp_cluster
    with _mcp_lock:
        _mcp_cluster = None


def get_mcp_cluster(
    path: Path | None = None,
) -> MCPCluster:
    global _mcp_cluster
    with _mcp_lock:
        if _mcp_cluster is None:
            _mcp_cluster = MCPCluster.from_config_path(path)
        return _mcp_cluster


def reload_mcp_cluster(path: Path | None = None) -> int:
    """Reload YAML, reset singleton. Returns number of server entries configured."""
    global _mcp_cluster
    with _mcp_lock:
        _mcp_cluster = MCPCluster.from_config_path(path)
        return len(_mcp_cluster._config.servers)  # noqa: SLF001 - test hook


class MCPCluster:
    """In-process MCP aggregation (single process, ARCH §3.5)."""

    def __init__(self, config: McpConfig) -> None:
        self._config = config
        self._cache_list: list[ToolSpec] | None = None
        self._cache_at: float = 0.0
        self._lock = threading.RLock()

    @classmethod
    def from_config_path(cls, path: Path | None) -> MCPCluster:
        return cls(load_mcp_config(path))

    def reload_config(self, path: Path | None = None) -> int:
        with self._lock:
            self._config = load_mcp_config(path)
            self._cache_list = None
            self._cache_at = 0.0
        return len(self._config.servers)

    def list_tool_specs_cached(self, list_ttl_ms: int) -> list[ToolSpec]:
        now = time.monotonic()
        with self._lock:
            if (
                self._cache_list is not None
                and (now - self._cache_at) * 1000.0 < list_ttl_ms
            ):
                return list(self._cache_list)
        built = self._list_tool_specs_fresh()
        with self._lock:
            self._cache_list = built
            self._cache_at = time.monotonic()
            return list(built)

    def _list_tool_specs_fresh(self) -> list[ToolSpec]:
        if not self._config.servers:
            return []
        all_specs: list[ToolSpec] = []
        seen: set[str] = set()
        for server in self._config.servers:
            for spec in self._fetch_server_tools(server):
                if spec.fqn in seen:
                    msg = f"duplicate MCP tool fqn: {spec.fqn!r}"
                    raise ValueError(msg)
                seen.add(spec.fqn)
                all_specs.append(spec)
        return all_specs

    def _fetch_server_tools(self, server: McpServerEntry) -> list[ToolSpec]:
        async def _list(session: Any) -> mcp_types.ListToolsResult:
            return await session.list_tools()

        async def _run() -> mcp_types.ListToolsResult:
            return await with_mcp_session(server, _list)

        # Timeout: policy uses mcp cluster budget at call sites via server entry — use 60s default
        result = self._call_async(_run, op_timeout_sec=60.0)
        out: list[ToolSpec] = []
        for t in result.tools:
            fqn = f"mcp.{server.id}.{t.name}"
            origin = f"mcp:{server.id}"
            out.append(
                ToolSpec(
                    fqn=fqn,
                    title=t.title or t.name,
                    json_schema=(t.inputSchema or {}) if t.inputSchema is not None else {},
                    risk_tier=server.risk_tier,
                    origin=origin,  # type: ignore[arg-type]
                )
            )
        return out

    def _call_async(self, factory: Any, op_timeout_sec: float) -> Any:
        return run_mcp_coro_in_thread(
            factory(),
            thread_timeout_sec=op_timeout_sec,
        )

    def call_tool_sync(
        self,
        server: McpServerEntry,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        op_timeout_sec: float,
    ) -> ToolResult:
        async def _call(session: Any) -> mcp_types.CallToolResult:
            return await session.call_tool(tool_name, arguments)

        async def _run() -> mcp_types.CallToolResult:
            return await with_mcp_session(server, _call)

        try:
            cres: mcp_types.CallToolResult = self._call_async(_run, op_timeout_sec)
        except TimeoutError:
            return ToolResult(
                ok=False,
                data=None,
                error="MCP call timed out",
                error_code=err.MCP_TIMEOUT,
            )
        except OSError as exc:
            return ToolResult(
                ok=False,
                data=None,
                error=str(exc),
                error_code=err.MCP_CONNECT_ERROR,
            )
        except Exception as exc:  # pragma: no cover - mcp / transport errors
            return ToolResult(
                ok=False,
                data=None,
                error=f"{type(exc).__name__}: {exc}",
                error_code=err.MCP_CONNECT_ERROR,
            )
        if cres.isError:
            return ToolResult(
                ok=False,
                data=mcp_result_to_data(cres),
                error="MCP tool returned isError",
                error_code=err.ENGINE_ERROR,
            )
        return ToolResult(
            ok=True, data=mcp_result_to_data(cres), error=None, error_code=None
        )

    def server_by_id(self, server_id: str) -> McpServerEntry | None:
        for s in self._config.servers:
            if s.id == server_id:
                return s
        return None
