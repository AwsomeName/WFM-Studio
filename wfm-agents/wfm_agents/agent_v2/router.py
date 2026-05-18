"""Route /v1/chat/v2 — OpenAI Agents SDK Runner PoC.

Dispatches to ``plain_chat_agent`` or ``cad_review_agent`` based on the
same CAD-detection logic as ``/v1/chat``.  Returns extra fields
(tool_call_count, usage, raw_final_output) so the caller can compare
behaviour with the old runner.
"""

from __future__ import annotations

import datetime
import json
import logging
import re
from typing import Any

import httpx
from openai import AsyncOpenAI

from agents import RunConfig, Runner
from agents.model_settings import ModelSettings
from agents.models.openai_provider import OpenAIProvider
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..agent.config import AgentConfigError, load_config
from ..cad.review import CadReviewReport, render_markdown
from ..observability import errors as err_codes
from ..routes.chat import (
    ChatReply,
    ChatRequest,
    _resolve_cad_file_ref,
)
from ..workspace import WorkspaceViolation, resolve_workspace_root

from .agents import cad_review_agent, plain_chat_agent
from .context import WfmAgentContext

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["chat-v2"])


# ── Response model ────────────────────────────────────────────────────


class ChatV2Reply(BaseModel):
    role: str = "assistant"
    content: str
    workspace_root: str
    received_at: str
    trace_id: str | None = None
    session_id: str | None = None
    # V2 extras for comparison
    agent_name: str = ""
    raw_final_output: Any = None
    tool_call_count: int = 0
    total_turns: int = 0
    usage: dict[str, int] | None = None


# ── Provider / config helpers ─────────────────────────────────────────


def _build_run_config() -> tuple[RunConfig, float]:
    cfg = load_config()
    client = AsyncOpenAI(
        api_key=cfg.api_key,
        base_url=cfg.base_url,
        timeout=httpx.Timeout(cfg.request_timeout, connect=10.0),
    )
    provider = OpenAIProvider(
        openai_client=client,
        use_responses=cfg.use_responses_api,
    )
    return (
        RunConfig(
            model=cfg.model,
            model_provider=provider,
            model_settings=ModelSettings(temperature=cfg.temperature),
        ),
        cfg.max_tool_rounds,
    )


def _extract_usage(result: Any) -> dict[str, int] | None:
    if not result.raw_responses:
        return None
    last = result.raw_responses[-1]
    usage = getattr(last, "usage", None)
    if usage is None:
        return None
    return {
        "input_tokens": getattr(usage, "input_tokens", 0) or 0,
        "output_tokens": getattr(usage, "output_tokens", 0) or 0,
        "total_tokens": getattr(usage, "total_tokens", 0) or 0,
    }


def _count_tool_calls(result: Any) -> int:
    count = 0
    for item in result.new_items:
        t = getattr(item, "type", "")
        if "tool_call" in t and "output" not in t:
            count += 1
    return count


# ── JSON parsing for CAD review (handles code fences from GLM) ────────

_FENCE_RE = re.compile(r"```(?:json)?\s*\n?(.*?)\n?\s*```", re.DOTALL)


def _parse_cad_review(text: str) -> tuple[str, dict | None]:
    """Try to parse a CadReviewReport from raw model text.

    Strips markdown code fences, then validates against CadReviewReport.
    Returns (markdown_content, raw_dict) or (raw_text, None) on failure.
    """
    # Strip code fences
    m = _FENCE_RE.search(text)
    json_str = m.group(1).strip() if m else text.strip()

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError:
        _log.warning("cad_review v2: failed to parse JSON from model output")
        return text, None

    try:
        report = CadReviewReport.model_validate(data)
        return render_markdown(report), report.model_dump()
    except Exception:
        _log.warning("cad_review v2: JSON parsed but schema validation failed")
        return text, data


# ── Endpoint ──────────────────────────────────────────────────────────


@router.post("/chat/v2", response_model=ChatV2Reply)
async def chat_v2(req: ChatRequest) -> ChatV2Reply:
    # 1. Validate workspace
    try:
        root = resolve_workspace_root(req.workspace_root)
    except WorkspaceViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 2. Resolve CAD file path (agent will call tools autonomously)
    cad_file_path = _resolve_cad_file_ref(req, root)

    # 3. Build RunConfig from the same env vars as the legacy runner
    try:
        run_config, max_turns = _build_run_config()
    except AgentConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 4. Select agent + build prompt
    ctx = WfmAgentContext(workspace_root=str(root))
    is_cad = cad_file_path is not None

    if is_cad:
        agent = cad_review_agent
        prompt = (
            f"请审图，文件路径: {cad_file_path}\n"
            f"用户要求: {req.message}"
        )
    else:
        agent = plain_chat_agent
        prompt = req.message

    # 5. Run
    try:
        result = await Runner.run(
            starting_agent=agent,
            input=prompt,
            context=ctx,
            run_config=run_config,
            max_turns=max_turns,
        )
    except Exception as exc:
        _log.exception("Runner.run failed")
        raise HTTPException(
            status_code=502,
            detail=(
                f"{err_codes.ENGINE_ERROR}: "
                f"Runner.run 失败: {type(exc).__name__}: {exc}"
            ),
        ) from exc

    # 6. Format reply
    final = result.final_output
    if is_cad and isinstance(final, str):
        content, raw_output = _parse_cad_review(final)
    elif isinstance(final, CadReviewReport):
        content = render_markdown(final)
        raw_output = final.model_dump()
    else:
        content = str(final)
        raw_output = None

    return ChatV2Reply(
        content=content,
        workspace_root=str(root),
        received_at=datetime.datetime.now(tz=datetime.timezone.utc).isoformat(),
        trace_id=None,
        session_id=req.session_id,
        agent_name=agent.name,
        raw_final_output=raw_output,
        tool_call_count=_count_tool_calls(result),
        total_turns=len(result.raw_responses),
        usage=_extract_usage(result),
    )
