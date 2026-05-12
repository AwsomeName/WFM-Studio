"""Chat endpoint — thin HTTP layer over AgentGateway (DEV M2)."""

from __future__ import annotations

import re
from os import getenv
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..cad import (
    DxfParseError,
    RECIPE_ID as CAD_RECIPE_ID,
    cad_review_prompt,
    summarize_dxf,
    summarize_dxf_text,
)
from ..crewai_runtime import CrewRuntimeConfigError
from ..engines.openai_errors import OpenAIApiError, OpenAIConfigError
from ..engines.devui_engine import DevUIBridgeError
from ..gateway.agent_gateway import get_default_agent_gateway
from ..gateway.exceptions import EngineNotInstalledError
from ..gateway.models import EngineId, TurnRequest
from ..observability import errors as err_codes
from ..workspace import WorkspaceViolation, resolve_within, resolve_workspace_root

router = APIRouter(prefix="/v1", tags=["chat"])

ChatMode = Literal["echo", "single", "multi"]


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
        description="编排引擎；默认 crewai。可选 maf、agenticx、openai（需 OPENAI_API_KEY）。",
    )
    # v0.2 新增：浏览器内 cad-viewer/libredwg-web 解析得到的 DXF 文本。
    # 当字段存在且非空时，优先于消息文本里 .dxf token + 磁盘 lookup 进入审图分支。
    # workspace_root 仍要传（用于审计 / 后续 client_meta）。
    dxf_text: str | None = Field(
        default=None,
        description="可选：前端 viewer 直接附带的 DXF 文本，命中时跳过磁盘 lookup。",
    )
    dxf_source_uri: str | None = Field(
        default=None,
        description="可选：dxf_text 来源 URI（仅做审计标识，不会被解析为磁盘路径）。",
    )


class ChatReply(BaseModel):
    role: str = "assistant"
    content: str
    workspace_root: str
    received_at: str
    trace_id: str | None = Field(
        default=None,
        description="本轮 trace_id，用于日志与评测关联。",
    )


def turn_request_from_chat(req: ChatRequest, root: Path) -> TurnRequest:
    """Map legacy ChatRequest + resolved workspace path to TurnRequest."""
    mode = select_chat_mode(req)
    return TurnRequest(
        workspace_root=str(root),
        message=req.message,
        engine=req.engine or "crewai",
        recipe_id="wfm.echo" if mode == "echo" else None,
        client_meta={"wfm_chat_mode": mode},
    )


@router.post("/chat", response_model=ChatReply)
async def chat(req: ChatRequest) -> ChatReply:
    try:
        root = resolve_workspace_root(req.workspace_root)
    except WorkspaceViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    inline_turn = _try_build_inline_dxf_turn(req, root)
    if inline_turn is not None:
        turn = inline_turn
    else:
        cad_turn = _try_build_cad_review_turn(req, root)
        turn = cad_turn if cad_turn is not None else turn_request_from_chat(req, root)

    gateway = get_default_agent_gateway()
    try:
        result = await gateway.run_turn(turn)
    except CrewRuntimeConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OpenAIConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OpenAIApiError as exc:
        raise HTTPException(
            status_code=min(max(exc.status_code, 400), 599),
            detail=str(exc),
        ) from exc
    except EngineNotInstalledError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{err_codes.ENGINE_NOT_INSTALLED}: {exc.hint}",
        ) from exc
    except DevUIBridgeError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=f"{exc.code}: {exc}",
        ) from exc
    except Exception as exc:  # pragma: no cover - runtime provider/network errors
        raise HTTPException(
            status_code=502,
            detail=f"{err_codes.ENGINE_ERROR}: 引擎执行失败: {type(exc).__name__}: {exc}",
        ) from exc

    return ChatReply(
        content=result.content,
        workspace_root=result.workspace_root,
        received_at=result.received_at,
        trace_id=result.trace_id,
    )


def select_chat_mode(req: ChatRequest) -> ChatMode:
    if req.mode:
        return req.mode

    env_mode = (getenv("WFM_CHAT_MODE") or "echo").strip().lower()
    if env_mode in {"single", "multi", "echo"}:
        return env_mode
    return "echo"


# --- CAD 审图分支 -----------------------------------------------------------
# 触发条件：用户消息中出现一个工作区内实际存在的 .dxf 文件引用（路径或文件名）。
# 行为：把消息文本替换为带摘要的 cad_review_prompt，并把 recipe_id 设为
# wfm.cad_review；engine 沿用用户选择，mode 信息原样塞进 client_meta，便于审计。
# 这样 echo 模式下用户能看到"被 echo 的审图 prompt"，single/openai 模式下
# 拿到真正的审图意见。

# 匹配 .dxf 文件 token：允许相对路径（含 / 或 \）、可选引号/反引号包裹。
_DXF_TOKEN_RE = re.compile(
    r"""
    [\"'`]?              # 可选的引号
    (                    # group 1: 候选路径
        [^\s\"'`,;]*?    # 任意非空白字符（懒惰匹配）
        [^\s\"'`,;/\\]+  # 末段至少 1 个非分隔符
        \.dxf            # 必须以 .dxf 结尾
    )
    [\"'`]?
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _extract_dxf_candidates(message: str) -> list[str]:
    """从用户消息中抽取所有形如 ``foo/bar.dxf`` 的候选 token。"""
    return [m.group(1) for m in _DXF_TOKEN_RE.finditer(message)]


def _resolve_dxf_in_workspace(workspace_root: str, candidate: str) -> Path | None:
    """把 .dxf 候选 token 解析成工作区内的真实路径（不存在或越界返回 None）。"""
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


def _try_build_cad_review_turn(req: ChatRequest, root: Path) -> TurnRequest | None:
    """命中 CAD 审图分支时返回改造好的 TurnRequest，否则 None。"""
    candidates = _extract_dxf_candidates(req.message)
    if not candidates:
        return None

    resolved: Path | None = None
    for candidate in candidates:
        resolved = _resolve_dxf_in_workspace(str(root), candidate)
        if resolved is not None:
            break
    if resolved is None:
        # 用户提到了 .dxf 但都不在工作区里，落回普通 chat。
        return None

    try:
        summary = summarize_dxf(resolved)
    except DxfParseError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"DXF 解析失败: {exc}",
        ) from exc
    except FileNotFoundError as exc:  # 极少数竞态
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    prompt_text = cad_review_prompt(summary, req.message)
    mode = select_chat_mode(req)

    return TurnRequest(
        workspace_root=str(root),
        message=prompt_text,
        engine=req.engine or "crewai",
        recipe_id=CAD_RECIPE_ID,
        client_meta={
            "wfm_chat_mode": mode,
            "wfm_cad_dxf_path": str(resolved),
            "wfm_cad_dxf_source": "workspace_file",
        },
    )


def _try_build_inline_dxf_turn(req: ChatRequest, root: Path) -> TurnRequest | None:
    """v0.2: 命中 ``dxf_text`` inline 分支时返回改造好的 TurnRequest。

    与 :func:`_try_build_cad_review_turn` 不同，本分支不会去工作区里查找 .dxf
    文件——前端浏览器内 cad-viewer/libredwg-web 已经把 DXF 文本送过来了。
    """
    raw = req.dxf_text
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        # 字段存在但实际为空白：拒绝，避免静默回退到错误的工作区 lookup。
        raise HTTPException(
            status_code=400,
            detail="dxf_text 字段存在但为空字符串",
        )

    try:
        summary = summarize_dxf_text(raw, source_label=req.dxf_source_uri)
    except DxfParseError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"DXF 解析失败: {exc}",
        ) from exc

    prompt_text = cad_review_prompt(summary, req.message)
    mode = select_chat_mode(req)

    client_meta: dict[str, str] = {
        "wfm_chat_mode": mode,
        "wfm_cad_dxf_source": "viewer_inline",
    }
    if req.dxf_source_uri:
        client_meta["wfm_cad_dxf_source_uri"] = req.dxf_source_uri

    return TurnRequest(
        workspace_root=str(root),
        message=prompt_text,
        engine=req.engine or "crewai",
        recipe_id=CAD_RECIPE_ID,
        client_meta=client_meta,
    )
