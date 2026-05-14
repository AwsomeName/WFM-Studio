"""Chat endpoint — backed by agent_v2 (OpenAI Agents SDK).

Dispatch policy:

* CAD review (inline ``dxf_text`` or workspace ``.dxf`` token) — runs
  ``cad_review_agent`` through ``Runner.run``.
* Anything else — ``plain_chat_agent`` through ``Runner.run``.

The legacy ``engine`` / ``mode`` request fields are accepted for backward
compatibility but ignored.
"""

from __future__ import annotations

import asyncio
import logging
import re
from os import getenv
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..agent.config import AgentConfigError
from ..agent_v2.runner import ChatResult, run_chat
from ..cad import (
    DxfParseError,
    summarize_dxf,
    summarize_dxf_text,
)
from ..gateway.models import EngineId, TurnRequest
from ..observability import errors as err_codes
from ..workspace import WorkspaceViolation, resolve_within, resolve_workspace_root

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["chat"])

ChatMode = Literal["echo", "single", "multi"]

_DEFAULT_ENGINE_FALLBACK: EngineId = "openai"
_VALID_ENGINES: set[str] = {"openai", "crewai", "maf", "agenticx"}


def select_default_engine() -> EngineId:
    raw = (getenv("WFM_DEFAULT_ENGINE") or "").strip().lower()
    if raw in _VALID_ENGINES:
        return raw  # type: ignore[return-value]
    return _DEFAULT_ENGINE_FALLBACK


class ChatRequest(BaseModel):
    workspace_root: str = Field(
        ...,
        description="Absolute path to the currently opened workspace folder.",
    )
    message: str = Field(..., min_length=1, description="User message text.")
    mode: ChatMode | None = Field(
        default=None,
        description=(
            "Chat mode: "
            "echo (default), "
            "single (CrewAI one-task), "
            "multi (CrewAI multi-task sequential)."
        ),
    )
    engine: EngineId | None = Field(
        default=None,
        description="Deprecated. Ignored on the agent_v2 path.",
    )
    dxf_text: str | None = Field(
        default=None,
        description="Optional: DXF text from front-end viewer.",
    )
    dxf_source_uri: str | None = Field(
        default=None,
        description="Optional: DXF source URI (audit label only).",
    )
    session_id: str | None = Field(
        default=None,
        description="Optional: session id for continuity.",
    )
    recipe: Literal["plain_chat", "cad_review", "cad_generation", "echo"] | None = Field(
        default=None,
        description="Optional: force a specific recipe.",
    )
    language: Literal["zh-CN", "en"] | None = Field(
        default=None,
        description="Reply language; default zh-CN.",
    )
    extras: dict[str, Any] | None = Field(
        default=None,
        description="recipe-specific payload.",
    )


class ChatReply(BaseModel):
    role: str = "assistant"
    content: str
    workspace_root: str
    received_at: str
    trace_id: str | None = Field(
        default=None,
        description="Trace id for log correlation.",
    )
    session_id: str | None = Field(
        default=None,
        description="Session id for continuity.",
    )


def turn_request_from_chat(req: ChatRequest, root: Path) -> TurnRequest:
    mode = select_chat_mode(req)
    return TurnRequest(
        workspace_root=str(root),
        message=req.message,
        engine=req.engine or select_default_engine(),
        recipe_id="wfm.echo" if mode == "echo" else None,
        client_meta={"wfm_chat_mode": mode},
    )


@router.post("/chat", response_model=ChatReply)
async def chat(req: ChatRequest) -> ChatReply:
    try:
        root = resolve_workspace_root(req.workspace_root)
    except WorkspaceViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    cad_extras = _extract_cad_review_extras(req, root)

    if req.engine:
        _log.warning("deprecated: ignoring legacy field engine=%s", req.engine)
    if req.mode and req.mode != "echo":
        _log.warning("deprecated: ignoring legacy field mode=%s", req.mode)

    try:
        result: ChatResult = await asyncio.to_thread(
            run_chat,
            message=req.message,
            workspace_root=str(root),
            session_id=req.session_id,
            cad_extras=cad_extras,
        )
    except AgentConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"{err_codes.ENGINE_ERROR}: {type(exc).__name__}: {exc}",
        ) from exc

    return ChatReply(
        content=result.content,
        workspace_root=result.workspace_root,
        received_at=result.received_at,
        trace_id=result.trace_id,
        session_id=result.session_id,
    )


def select_chat_mode(req: ChatRequest) -> ChatMode:
    if req.mode:
        return req.mode
    env_mode = (getenv("WFM_CHAT_MODE") or "echo").strip().lower()
    if env_mode in {"single", "multi", "echo"}:
        return env_mode
    return "echo"


# --- CAD detection (unchanged) ----------------------------------------

_DXF_TOKEN_RE = re.compile(
    r"""
    [\"'`]?
    (
        [^\s\"'`,;]*?
        [^\s\"'`,;/\\]+
        \.dxf
    )
    [\"'`]?
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _extract_dxf_candidates(message: str) -> list[str]:
    return [m.group(1) for m in _DXF_TOKEN_RE.finditer(message)]


def _resolve_dxf_in_workspace(workspace_root: str, candidate: str) -> Path | None:
    cleaned = candidate.replace("\\", "/").lstrip("./").strip()
    if not cleaned:
        return None
    try:
        target = resolve_within(workspace_root, cleaned)
    except WorkspaceViolation:
        return None
    if not target.is_file():
        return None
    if target.suffix.lower() != ".dxf":
        return None
    return target


def _extract_cad_review_extras(
    req: ChatRequest, root: Path
) -> dict[str, Any] | None:
    inline = _try_extract_inline_dxf_summary(req)
    if inline is not None:
        summary, source = inline
        return {"dxf_summary": summary, "dxf_source": source}

    workspace = _try_extract_workspace_dxf_summary(req, root)
    if workspace is not None:
        summary, source = workspace
        return {"dxf_summary": summary, "dxf_source": source}

    return None


def _try_extract_inline_dxf_summary(
    req: ChatRequest,
) -> tuple[dict[str, Any], str] | None:
    raw = req.dxf_text
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        raise HTTPException(
            status_code=400, detail="dxf_text 字段存在但为空字符串"
        )
    try:
        summary = summarize_dxf_text(raw, source_label=req.dxf_source_uri)
    except DxfParseError as exc:
        raise HTTPException(status_code=422, detail=f"DXF 解析失败: {exc}") from exc
    return summary, req.dxf_source_uri or "viewer_inline"


def _try_extract_workspace_dxf_summary(
    req: ChatRequest, root: Path
) -> tuple[dict[str, Any], str] | None:
    candidates = _extract_dxf_candidates(req.message)
    if not candidates:
        return None
    resolved: Path | None = None
    for candidate in candidates:
        resolved = _resolve_dxf_in_workspace(str(root), candidate)
        if resolved is not None:
            break
    if resolved is None:
        return None
    try:
        summary = summarize_dxf(resolved)
    except DxfParseError as exc:
        raise HTTPException(status_code=422, detail=f"DXF 解析失败: {exc}") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return summary, str(resolved)
