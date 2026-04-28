"""M1: fs_ops, BuiltinToolProvider, ToolExecutor, ToolHandle (DEV_AGENT_GATEWAY §M1)."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from wfm_agents.fs_ops import write_text
from wfm_agents.gateway.session import SessionContext
from wfm_agents.observability import errors as err
from wfm_agents.observability.trace import new_trace_id
from wfm_agents.tools.builtin_provider import BuiltinToolProvider
from wfm_agents.tools.executor import ToolExecutor, redact_args
from wfm_agents.tools.handle import build_tool_handle
from wfm_agents.tools.policy import ToolPolicy
from wfm_agents.tools.registry import ToolRegistry
from wfm_agents.tools.spec import ToolResult, ToolSpec
from wfm_agents.workspace import WorkspaceViolation, resolve_workspace_root


def test_fs_ops_write_rejects_escape(tmp_path) -> None:
    root = str(resolve_workspace_root(str(tmp_path)))
    with pytest.raises(WorkspaceViolation):
        write_text(root, "../../etc/passwd", "x")


def test_builtin_provider_specs(tmp_path) -> None:
    root = str(resolve_workspace_root(str(tmp_path)))
    ctx = SessionContext(workspace_root=root, trace_id=new_trace_id())
    p = BuiltinToolProvider()
    specs = p.list_tool_specs(ctx)
    assert len(specs) >= 2
    fqns = {s.fqn for s in specs}
    assert "wfm.workspace_read" in fqns
    assert "wfm.workspace_write" in fqns


@pytest.mark.asyncio
async def test_executor_disabled_fqns(tmp_path) -> None:
    root = str(resolve_workspace_root(str(tmp_path)))
    ctx = SessionContext(workspace_root=root, trace_id=new_trace_id())
    reg = ToolRegistry.build(ctx, [BuiltinToolProvider()])
    policy = ToolPolicy(disabled_fqns=frozenset({"wfm.workspace_read"}))
    ex = ToolExecutor(reg, policy)
    result = await ex.execute_async(
        "wfm.workspace_read",
        {"path": "a.md"},
        ctx,
    )
    assert result.ok is False
    assert ex.ledger[-1].error_code == err.POLICY_DENY


class _SlowProvider:
    """Test-only tool that blocks longer than executor timeout."""

    def list_tool_specs(self, ctx: SessionContext) -> list[ToolSpec]:
        return [
            ToolSpec(
                fqn="wfm.__test_slow",
                title="intentionally slow",
                json_schema={"type": "object", "properties": {}},
                risk_tier="read",
                origin="builtin",
            )
        ]

    def execute(self, fqn: str, args: dict[str, Any], ctx: SessionContext) -> ToolResult:
        time.sleep(2)
        return ToolResult(ok=True, data={"ok": True}, error=None)


@pytest.mark.asyncio
async def test_executor_tool_timeout(tmp_path) -> None:
    root = str(resolve_workspace_root(str(tmp_path)))
    ctx = SessionContext(workspace_root=root, trace_id=new_trace_id())
    reg = ToolRegistry.build(ctx, [_SlowProvider()])
    policy = ToolPolicy(single_tool_timeout_ms=100)
    ex = ToolExecutor(reg, policy)
    result = await ex.execute_async("wfm.__test_slow", {}, ctx)
    assert result.ok is False
    assert ex.ledger[-1].error_code == err.TOOL_TIMEOUT


@pytest.mark.asyncio
async def test_handle_builtin_roundtrip(tmp_path) -> None:
    root = str(resolve_workspace_root(str(tmp_path)))
    ctx = SessionContext(workspace_root=root, trace_id=new_trace_id())
    handle = build_tool_handle(ctx, [BuiltinToolProvider()], ToolPolicy())
    w = await handle.invoke_async(
        "wfm.workspace_write",
        {"path": "via_tool.md", "content": "toolpath", "overwrite": True},
    )
    assert w.ok is True
    r = await handle.invoke_async("wfm.workspace_read", {"path": "via_tool.md"})
    assert r.ok is True
    assert r.data["content"] == "toolpath"


def test_redact_args_masks_secrets() -> None:
    out = redact_args({"path": "x", "api_key": "secret", "nested": {"password": "p"}})
    assert out["api_key"] == "***"
    assert out["nested"]["password"] == "***"
    assert out["path"] == "x"


def test_tool_handle_invoke_sync_outside_loop(tmp_path) -> None:
    root = str(resolve_workspace_root(str(tmp_path)))
    ctx = SessionContext(workspace_root=root, trace_id=new_trace_id())
    handle = build_tool_handle(ctx, [BuiltinToolProvider()])
    result = handle.invoke(
        "wfm.workspace_write",
        {"path": "sync.md", "content": "hi", "overwrite": True},
    )
    assert result.ok is True


@pytest.mark.asyncio
async def test_tool_handle_invoke_sync_rejects_inside_loop(tmp_path) -> None:
    root = str(resolve_workspace_root(str(tmp_path)))
    ctx = SessionContext(workspace_root=root, trace_id=new_trace_id())
    handle = build_tool_handle(ctx, [BuiltinToolProvider()])

    async def _inner() -> None:
        with pytest.raises(RuntimeError, match="invoke_async"):
            handle.invoke("wfm.workspace_read", {"path": "sync.md"})

    await _inner()
