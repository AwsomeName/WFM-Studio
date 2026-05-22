"""SSE streaming chat (``POST /v1/chat/stream``) — backed by agent_v2."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..agent.config import AgentConfigError
from ..agent_v2.runner import run_chat_stream
from ..workspace import WorkspaceViolation, resolve_workspace_root
from .chat import ChatRequest, _build_claude_prompt, _build_prompt, _resolve_attachments

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["chat"])


@router.post("/chat/stream")
async def chat_stream(request: Request, req: ChatRequest) -> StreamingResponse:
    try:
        root = resolve_workspace_root(req.workspace_root)
    except WorkspaceViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # ── Claude Code backend ──
    if req.backend == "claude_code":
        from ..agent_v2.claude_runner import run_chat_stream_claude  # noqa: PLC0415

        prompt = _build_claude_prompt(req, root)

        async def sse_gen():
            try:
                async for frame in run_chat_stream_claude(
                    prompt=prompt,
                    workspace_root=str(root),
                    cad_source_uri=req.cad_source_uri,
                    session_id=req.session_id,
                    model=req.model,
                ):
                    if await request.is_disconnected():
                        break
                    yield frame
            except Exception as exc:
                from ..agent_v2.sse import encode_sse  # noqa: PLC0415

                yield encode_sse({"type": "error", "error": str(exc)})

        return StreamingResponse(sse_gen(), media_type="text/event-stream")

    # ── WFM backend (default) ──
    prompt = _build_prompt(req, root)
    attachments = _resolve_attachments(req, root)

    if req.engine:
        _log.warning("deprecated: ignoring legacy field engine=%s", req.engine)
    if req.mode and req.mode != "echo":
        _log.warning("deprecated: ignoring legacy field mode=%s", req.mode)

    async def sse_gen():
        try:
            async for frame in run_chat_stream(
                message=prompt,
                workspace_root=str(root),
                session_id=req.session_id,
                attachments=attachments,
                model=req.model,
            ):
                if await request.is_disconnected():
                    break
                yield frame
        except AgentConfigError as exc:
            from ..agent_v2.sse import EVENT_ERROR, encode_sse

            yield encode_sse({"type": EVENT_ERROR, "error": str(exc)})

    return StreamingResponse(sse_gen(), media_type="text/event-stream")
