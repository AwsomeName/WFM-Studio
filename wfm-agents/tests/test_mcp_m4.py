"""M4: MCP FQN, config, admin reload (no live MCP server)."""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent

import pytest
from fastapi.testclient import TestClient

from wfm_agents.server import create_app
from wfm_agents.tools.mcp import parse_mcp_fqn
from wfm_agents.tools.mcp.config import McpConfig, McpServerEntry, expand_config_strings, load_mcp_config
from wfm_agents.tools.mcp.connection import mcp_result_to_data
from wfm_agents.tools.mcp.provider import MCPClusterProvider


def test_parse_mcp_fqn() -> None:
    assert parse_mcp_fqn("mcp.demo.tool_x") == ("demo", "tool_x")
    assert parse_mcp_fqn("mcp.srv-1.a.b") == ("srv-1", "a.b")
    assert parse_mcp_fqn("wfm.workspace_read") is None


def test_expand_config_strings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MY_TOKEN", "secret-value")
    raw: dict = {"x": "pre-${env:MY_TOKEN}-suf"}
    assert expand_config_strings(raw) == {"x": "pre-secret-value-suf"}


def test_load_mcp_config_from_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(
        dedent(
            """
            servers:
              - id: t1
                transport: stdio
                command: /bin/echo
                args: []
            """
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("WFM_MCP_CONFIG", str(cfg_path))
    c = load_mcp_config()
    assert len(c.servers) == 1
    assert c.servers[0].id == "t1"
    assert c.servers[0].command == "/bin/echo"


def test_mcp_config_validates_sse() -> None:
    McpConfig(
        servers=[
            McpServerEntry(
                id="r1",
                transport="sse",
                url="http://127.0.0.1:1/sse",
            )
        ]
    )


def test_mcp_result_to_data_minimal() -> None:
    from mcp import types

    r = types.CallToolResult(
        content=[types.TextContent(type="text", text="hi")],
        isError=False,
    )
    d = mcp_result_to_data(r)
    assert d["isError"] is False
    assert len(d["content"]) == 1


def test_mcp_cluster_provider_rejects_non_mcp() -> None:
    from wfm_agents.gateway.session import SessionContext
    from wfm_agents.tools.policy import ToolPolicy

    prov = MCPClusterProvider()
    ctx = SessionContext(
        workspace_root="/tmp",
        trace_id="t",
        tool_policy=ToolPolicy(),
    )
    r = prov.execute("wfm.workspace_read", {"path": "a"}, ctx)
    assert r.ok is False
    assert r.error


def test_mcp_policy_disabled_fqn() -> None:
    import asyncio

    from wfm_agents.gateway.session import SessionContext
    from wfm_agents.tools.builtin_provider import BuiltinToolProvider
    from wfm_agents.tools.executor import ToolExecutor
    from wfm_agents.tools.mcp import MCPClusterProvider, get_mcp_cluster, reset_mcp_cluster_for_tests
    from wfm_agents.tools.policy import ToolPolicy
    from wfm_agents.tools.registry import ToolRegistry

    reset_mcp_cluster_for_tests()
    get_mcp_cluster()

    fqn = "mcp.any.echo"
    pol = ToolPolicy(disabled_fqns=frozenset({fqn}))
    ctx = SessionContext(workspace_root="/", trace_id="t", tool_policy=pol)
    reg = ToolRegistry.build(ctx, [BuiltinToolProvider(), MCPClusterProvider()])
    ex = ToolExecutor(reg, pol)

    async def _t() -> None:
        r = await ex.execute_async(fqn, {}, ctx)
        assert r.ok is False
        rec = ex.ledger[-1]
        assert rec.error_code == "POLICY_DENY"

    asyncio.run(_t())


def test_admin_mcp_reload() -> None:
    with TestClient(create_app()) as client:
        r = client.post(
            "/v1/admin/mcp/reload",
            headers={"X-WFM-Internal": "1"},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True
    assert "servers" in body
