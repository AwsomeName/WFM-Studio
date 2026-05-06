"""Chat endpoint — thin HTTP layer over AgentGateway (DEV M2)."""

from __future__ import annotations

from os import getenv
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..crewai_runtime import CrewRuntimeConfigError
from ..engines.anthropic_errors import AnthropicApiError, AnthropicConfigError
from ..engines.devui_engine import DevUIBridgeError
from ..gateway.agent_gateway import get_default_agent_gateway
from ..gateway.exceptions import EngineNotInstalledError
from ..gateway.models import EngineId, TurnRequest
from ..observability import errors as err_codes
from ..workspace import WorkspaceViolation, resolve_workspace_root

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
        description="编排引擎；默认 crewai。可选 maf、agenticx、anthropic（后者需 extras）。",
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

    turn = turn_request_from_chat(req, root)

    gateway = get_default_agent_gateway()
    try:
        result = await gateway.run_turn(turn)
    except CrewRuntimeConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except AnthropicConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except AnthropicApiError as exc:
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
