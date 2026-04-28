"""Admin: MCP hot reload (ARCH §3.5 POST /v1/admin/mcp/reload)."""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request

from ..tools.mcp import reload_mcp_cluster

router = APIRouter(prefix="/v1", tags=["admin"])


@router.post("/admin/mcp/reload")
def post_mcp_reload(
    request: Request,
    x_wfm_internal: str | None = Header(None, alias="X-WFM-Internal"),  # noqa: ARG001 — future auth hook
) -> dict:
    """
    Re-read `config/mcp_servers.yaml`, reset MCP clients; next turn sees new `mcp.*` tools.
    对非本机回环的调用需 `X-WFM-Internal: 1`（或经反向代理信任的内网网段，由部署侧处理）。
    """
    client = request.client.host if request.client else None
    if client not in {"127.0.0.1", "localhost", "::1"} and x_wfm_internal != "1":
        raise HTTPException(
            status_code=403, detail="MCP reload requires 127.0.0.1 or X-WFM-Internal: 1"
        )
    n = reload_mcp_cluster()
    return {"ok": True, "servers": n, "mcp": "reloaded"}
