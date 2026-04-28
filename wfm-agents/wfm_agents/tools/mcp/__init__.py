"""MCP cluster: config, transport, FQN mcp.{id}.{name} (ARCH §3.5 / DEV M4)."""

from .cluster import (
    MCPCluster,
    get_mcp_cluster,
    parse_mcp_fqn,
    reload_mcp_cluster,
    reset_mcp_cluster_for_tests,
)
from .config import McpConfig, McpServerEntry, load_mcp_config
from .provider import MCPClusterProvider

__all__ = [
    "MCPCluster",
    "MCPClusterProvider",
    "McpConfig",
    "McpServerEntry",
    "get_mcp_cluster",
    "load_mcp_config",
    "parse_mcp_fqn",
    "reload_mcp_cluster",
    "reset_mcp_cluster_for_tests",
]
