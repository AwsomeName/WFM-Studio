"""Chat endpoint — backed by agent_v2 (OpenAI Agents SDK).

Route layer does **structural detection** (file references, attachments)
and injects context into the prompt. The ``router_agent`` decides which
specialised agent to hand off to based on the enriched prompt.

The legacy ``engine`` / ``mode`` / ``recipe`` request fields are accepted
for backward compatibility but ignored.
"""

from __future__ import annotations

import asyncio
import logging
import re
from os import getenv
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..agent.config import AgentConfigError
from ..agent_v2.runner import ChatResult, run_chat
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


class FileAttachment(BaseModel):
    """A file attached by the user from the Explorer / attachment UI."""

    uri: str = Field(..., description="File URI (file://) or workspace-relative path.")
    name: str = Field(..., description="Display file name (e.g. 'report.docx').")
    rel_path: str | None = Field(default=None, description="Workspace-relative path, if resolved.")


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
    cad_source_uri: str | None = Field(
        default=None,
        description="Optional: CAD file URI (.dwg / .dxf) from right-click menu or message extraction.",
    )
    dxf_source_uri: str | None = Field(
        default=None,
        description="Optional: DXF source URI (backward compat, same as cad_source_uri).",
    )
    session_id: str | None = Field(
        default=None,
        description="Optional: session id for continuity.",
    )
    docx_path: str | None = Field(
        default=None,
        description="Optional: workspace-relative .docx path for document review.",
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
    attachments: list[FileAttachment] = Field(
        default_factory=list,
        description="Files attached by the user from the Explorer or attachment UI.",
    )
    model: str | None = Field(
        default=None,
        description="Optional: model override for this request (e.g. 'gpt-4.1', 'o3').",
    )
    backend: str | None = Field(
        default=None,
        description="Optional: backend to use ('wfm' or 'claude_code'). Default: 'wfm'.",
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

    # ── Claude Code backend ──
    if req.backend == "claude_code":
        from ..agent_v2.claude_runner import run_chat_claude  # noqa: PLC0415

        prompt = _build_claude_prompt(req, root)
        try:
            content = await run_chat_claude(
                prompt=prompt,
                workspace_root=str(root),
                cad_source_uri=req.cad_source_uri,
                session_id=req.session_id,
                model=req.model,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        from datetime import datetime, timezone  # noqa: PLC0415

        return ChatReply(
            content=content,
            workspace_root=str(root),
            received_at=datetime.now(timezone.utc).isoformat(),
            session_id=req.session_id,
        )

    # ── WFM backend (default) ──
    prompt = _build_prompt(req, root)

    if req.engine:
        _log.warning("deprecated: ignoring legacy field engine=%s", req.engine)
    if req.mode and req.mode != "echo":
        _log.warning("deprecated: ignoring legacy field mode=%s", req.mode)

    try:
        result: ChatResult = await asyncio.to_thread(
            run_chat,
            message=prompt,
            workspace_root=str(root),
            session_id=req.session_id,
            attachments=_resolve_attachments(req, root),
            model=req.model,
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


def _build_claude_prompt(req: ChatRequest, root: Path) -> str:
    """Lightweight prompt for Claude Code backend — no inline file content."""
    parts: list[str] = []

    cad_file_path = _resolve_cad_file_ref(req, root)
    if cad_file_path:
        parts.append(f"[CAD 文件: {cad_file_path}，请使用 cad_file_read 工具读取]")

    for att in req.attachments:
        rel = att.rel_path or _uri_to_workspace_relative(att.uri, root)
        if rel:
            parts.append(f"[附件: {rel}，请使用 workspace_read 工具读取]")

    if req.dxf_text and req.dxf_text.strip():
        parts.append("[用户在 CAD 视图中有选区数据]")

    parts.append(req.message)
    return "\n\n".join(parts)


# --- Prompt assembly (route-layer context injection) ──────────────────


def _build_prompt(req: ChatRequest, root: Path) -> str:
    """Build a unified prompt with injected file context.

    Route layer does structural detection (fast, reliable) and injects
    the results into the prompt. The router agent reads the enriched
    prompt and decides which agent to hand off to.
    """
    parts: list[str] = []

    # Legacy paths: dxf_text, cad_source_uri, docx_path, message tokens
    cad_file_path = _resolve_cad_file_ref(req, root)
    if cad_file_path:
        parts.append(f"[检测到CAD文件] 路径: {cad_file_path}")

    docx_extras = _extract_docx_review_extras(req, root)
    if docx_extras:
        docx_prompt = _build_docx_section(docx_extras)
        parts.append(docx_prompt)

    # Attachment-based detection: check attachments for CAD/DOCX
    for att in req.attachments:
        rel = att.rel_path or _uri_to_workspace_relative(att.uri, root)
        if not rel:
            continue
        ext = Path(rel).suffix.lower()

        # Skip if already detected via legacy paths
        if ext in {".dxf", ".dwg"} and not cad_file_path:
            try:
                target = resolve_within(str(root), rel)
            except WorkspaceViolation:
                continue
            if target.is_file():
                parts.append(f"[检测到CAD文件] 路径: {rel}")
                cad_file_path = rel  # prevent duplicate detection

        elif ext == ".docx" and not docx_extras:
            try:
                target = resolve_within(str(root), rel)
            except WorkspaceViolation:
                continue
            if target.is_file():
                try:
                    docx_extras = _parse_docx_file(target)
                    parts.append(_build_docx_section(docx_extras))
                except HTTPException:
                    pass

    parts.append(req.message)
    return "\n\n".join(parts)


def _build_docx_section(docx_extras: dict[str, Any]) -> str:
    from ..docx import format_docx_content

    content = docx_extras["docx_content"]
    source = docx_extras.get("docx_source", "unknown")
    formatted = format_docx_content(content)
    return (
        f"[检测到Word文档] 来源: {source}\n\n"
        f"### Word 文档内容\n\n{formatted}"
    )


# --- CAD detection (path-based, supports .dxf + .dwg) ----------------


_CAD_TOKEN_RE = re.compile(
    r"""
    [\"'`]?
    (
        [^\s\"'`,;]*?
        [^\s\"'`,;/\\]+
        \.(?:dxf|dwg)
    )
    [\"'`]?
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _extract_cad_candidates(message: str) -> list[str]:
    return [m.group(1) for m in _CAD_TOKEN_RE.finditer(message)]


def _resolve_cad_in_workspace(workspace_root: str, candidate: str) -> Path | None:
    cleaned = candidate.replace("\\", "/").lstrip("./").strip()
    if not cleaned:
        return None
    try:
        target = resolve_within(workspace_root, cleaned)
    except WorkspaceViolation:
        return None
    if not target.is_file():
        return None
    if target.suffix.lower() not in {".dxf", ".dwg"}:
        return None
    return target


def _uri_to_workspace_relative(uri: str, root: Path) -> str | None:
    """Convert a file URI or path to workspace-relative path."""
    if uri.startswith("file://"):
        parsed = urlparse(uri)
        abs_path = Path(unquote(parsed.path))
    else:
        abs_path = Path(uri)

    try:
        rel = abs_path.relative_to(root)
        return str(rel)
    except ValueError:
        return None


def _resolve_cad_file_ref(req: ChatRequest, root: Path) -> str | None:
    """Resolve CAD file reference from request. Returns workspace-relative path or temp path."""
    # Path 1: dxf_text from viewer → write to temp file
    if req.dxf_text and req.dxf_text.strip():
        from ..cad.dwg import save_temp_dxf  # noqa: PLC0415

        try:
            tmp = save_temp_dxf(req.dxf_text, source_label="viewer")
        except Exception as exc:
            raise HTTPException(
                status_code=422, detail=f"DXF 文本保存失败: {exc}"
            ) from exc
        return str(tmp)

    # Path 2: cad_source_uri (right-click menu)
    source_uri = req.cad_source_uri or req.dxf_source_uri
    if source_uri:
        rel = _uri_to_workspace_relative(source_uri, root)
        if rel:
            # Validate file exists
            target = resolve_within(str(root), rel)
            if target.is_file() and target.suffix.lower() in {".dxf", ".dwg"}:
                return rel

    # Path 3: message text mentions .dxf/.dwg
    candidates = _extract_cad_candidates(req.message)
    for candidate in candidates:
        resolved = _resolve_cad_in_workspace(str(root), candidate)
        if resolved is not None:
            try:
                return str(resolved.relative_to(root))
            except ValueError:
                return str(resolved)

    return None


# --- DOCX 审阅分支 -------------------------------------------------------

_DOCX_TOKEN_RE = re.compile(
    r"""
    [\"'`]?
    (
        [^\s\"'`,;]*?
        [^\s\"'`,;/\\]+
        \.docx
    )
    [\"'`]?
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _extract_docx_candidates(message: str) -> list[str]:
    return [m.group(1) for m in _DOCX_TOKEN_RE.finditer(message)]


def _resolve_docx_in_workspace(workspace_root: str, candidate: str) -> Path | None:
    cleaned = candidate.replace("\\", "/").lstrip("./").strip()
    if not cleaned:
        return None
    try:
        target = resolve_within(workspace_root, cleaned)
    except WorkspaceViolation:
        return None
    if not target.is_file():
        return None
    if target.suffix.lower() != ".docx":
        return None
    return target


def _extract_docx_review_extras(
    req: ChatRequest, root: Path
) -> dict[str, Any] | None:
    """Detect a DOCX review request.

    Two trigger paths:
    1. Explicit ``docx_path`` field in request body (from future attachment UI).
    2. .docx file name/path mentioned in the user's message (like .dxf detection).
    """
    # Path 1: explicit docx_path
    path = req.docx_path
    if path:
        return _resolve_docx_path(str(root), path)

    # Path 2: .docx token in message text
    candidates = _extract_docx_candidates(req.message)
    for candidate in candidates:
        resolved = _resolve_docx_in_workspace(str(root), candidate)
        if resolved is not None:
            return _parse_docx_file(resolved)

    return None


def _resolve_docx_path(workspace_root: str, path: str) -> dict[str, Any]:
    try:
        target = resolve_within(workspace_root, path)
    except WorkspaceViolation:
        raise HTTPException(status_code=400, detail=f"路径越界: {path}") from None
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"文件不存在: {path}")
    if target.suffix.lower() != ".docx":
        raise HTTPException(status_code=400, detail=f"仅支持 .docx 文件: {path}")
    return _parse_docx_file(target)


def _parse_docx_file(target: Path) -> dict[str, Any]:
    from ..docx import parse_docx

    try:
        content = parse_docx(target)
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=422, detail=f"文档解析失败: {exc}"
        ) from exc
    return {"docx_content": content, "docx_source": str(target)}


# --- Attachments (Explorer / attachment UI) ----------------------------


def _resolve_attachments(req: ChatRequest, root: Path) -> list[dict[str, Any]]:
    """Resolve file attachments from the request.

    Returns a list of dicts with ``rel_path`` (workspace-relative) and ``name``.
    Files that cannot be resolved within the workspace are silently skipped.
    """
    if not req.attachments:
        return []

    result: list[dict[str, Any]] = []
    for att in req.attachments:
        rel = att.rel_path
        if not rel:
            rel = _uri_to_workspace_relative(att.uri, root)
        if not rel:
            _log.debug("attachment skipped (not in workspace): %s", att.uri)
            continue
        # Validate within workspace
        try:
            target = resolve_within(str(root), rel)
        except WorkspaceViolation:
            _log.debug("attachment skipped (path escape): %s", rel)
            continue
        if not target.is_file():
            _log.debug("attachment skipped (not a file): %s", rel)
            continue
        result.append({"rel_path": rel, "name": att.name})
    return result
