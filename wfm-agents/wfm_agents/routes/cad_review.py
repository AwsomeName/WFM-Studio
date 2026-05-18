"""CAD review HTTP endpoints — backed by agent_v2.

* ``POST /v1/cad/review`` — sync, returns typed ``CadReviewReport`` JSON.
* ``POST /v1/cad/review/stream`` — SSE counterpart.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..agent.config import AgentConfigError
from ..agent_v2.runner import run_chat, run_chat_stream
from ..cad.review import CadReviewReport
from ..observability import errors as err_codes
from ..workspace import WorkspaceViolation, resolve_workspace_root
from .chat import ChatRequest, _resolve_cad_file_ref

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/cad", tags=["cad"])


class CadReviewRequest(BaseModel):
    workspace_root: str = Field(..., description="Absolute workspace root.")
    message: str = Field(
        default="请按通用方法对该图进行结构化审图。",
        description="Optional review intent; defaults to general review.",
    )
    session_id: str | None = None
    language: str | None = None
    dxf_text: str | None = None
    dxf_source_uri: str | None = None
    cad_source_uri: str | None = None

    def to_chat_request(self) -> ChatRequest:
        return ChatRequest(
            workspace_root=self.workspace_root,
            message=self.message,
            session_id=self.session_id,
            language=self.language,  # type: ignore[arg-type]
            dxf_text=self.dxf_text,
            dxf_source_uri=self.dxf_source_uri,
            cad_source_uri=self.cad_source_uri,
        )


class CadReviewResponse(BaseModel):
    report: CadReviewReport
    workspace_root: str
    received_at: str
    trace_id: str | None = None
    session_id: str | None = None


def _resolve_root_or_400(workspace_root: str):
    try:
        return resolve_workspace_root(workspace_root)
    except WorkspaceViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _resolve_cad_file_or_400(chat_req: ChatRequest, root) -> str:
    cad_file_path = _resolve_cad_file_ref(chat_req, root)
    if cad_file_path is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "/v1/cad/review 需要 dxf_text（inline）、cad_source_uri、"
                "或 message 中包含工作区已存在的 .dxf/.dwg 路径。"
            ),
        )
    return cad_file_path


@router.post("/review", response_model=CadReviewResponse)
async def cad_review(req: CadReviewRequest) -> CadReviewResponse:
    chat_req = req.to_chat_request()
    root = _resolve_root_or_400(req.workspace_root)
    cad_file_path = _resolve_cad_file_or_400(chat_req, root)

    try:
        result = await asyncio.to_thread(
            run_chat,
            message=req.message,
            workspace_root=str(root),
            session_id=req.session_id,
            cad_file_path=cad_file_path,
        )
    except AgentConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"{err_codes.ENGINE_ERROR}: 审图执行失败: {type(exc).__name__}: {exc}",
        ) from exc

    if result.report is None:
        raise HTTPException(
            status_code=502,
            detail=f"{err_codes.ENGINE_ERROR}: 审图未返回结构化报告",
        )

    return CadReviewResponse(
        report=CadReviewReport.model_validate(result.report),
        workspace_root=result.workspace_root,
        received_at=result.received_at,
        trace_id=result.trace_id,
        session_id=result.session_id,
    )


@router.post("/review/stream")
async def cad_review_stream(
    request: Request, req: CadReviewRequest
) -> StreamingResponse:
    chat_req = req.to_chat_request()
    root = _resolve_root_or_400(req.workspace_root)
    cad_file_path = _resolve_cad_file_or_400(chat_req, root)

    async def gen():
        async for frame in run_chat_stream(
            message=req.message,
            workspace_root=str(root),
            session_id=req.session_id,
            cad_file_path=cad_file_path,
        ):
            if await request.is_disconnected():
                break
            yield frame

    return StreamingResponse(gen(), media_type="text/event-stream")
