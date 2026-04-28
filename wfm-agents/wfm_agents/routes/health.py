"""Health check endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from .. import __version__

router = APIRouter(prefix="/v1", tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    """Simple liveness probe.

    Returned payload is intentionally minimal; richer status (LLM reachability,
    workspace bindings, etc.) belongs in a future `/v1/status` endpoint.
    """
    return {"status": "ok", "version": __version__}
