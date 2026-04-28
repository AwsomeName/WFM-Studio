"""SSE streaming chat (ARCH §4.2 `POST /v1/chat/stream`)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..gateway.agent_gateway import get_default_agent_gateway
from ..gateway.stream_events import encode_sse
from ..workspace import WorkspaceViolation, resolve_workspace_root
from .chat import ChatRequest, turn_request_from_chat

router = APIRouter(prefix="/v1", tags=["chat"])


@router.post("/chat/stream")
async def chat_stream(request: Request, req: ChatRequest) -> StreamingResponse:
    try:
        root = resolve_workspace_root(req.workspace_root)
    except WorkspaceViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    turn = turn_request_from_chat(req, root)
    gateway = get_default_agent_gateway()

    async def sse_gen():
        async for ev in gateway.stream_turn(
            turn,
            is_disconnected=request.is_disconnected,
        ):
            if await request.is_disconnected():
                break
            yield encode_sse(ev)

    return StreamingResponse(sse_gen(), media_type="text/event-stream")
