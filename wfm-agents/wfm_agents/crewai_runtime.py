"""CrewAI runtime for WFM chat endpoint (Step E skeleton).

This module keeps CrewAI-specific logic outside FastAPI routes:
- parse runtime config from environment variables
- build single-task and multi-task crews
- normalize Crew output into plain text

Lazy import 说明
----------------
``from crewai import ...`` 被推迟到 :func:`_require_crewai` 内。理由：
``crewai`` 在 import 期会顺带把 ``litellm`` / ``chromadb`` / ``pyarrow`` 等大依赖
一起拖进内存（>1s + 数十 MB 占用），而当前默认引擎已切回 OpenAI SDK（见
``routes/chat.py``），绝大多数请求不需要 CrewAI 也不应被它的 import 拖累。
仅当用户显式 ``engine="crewai"`` 才在 run_turn 调链时触发真正的 import。
"""

from __future__ import annotations

from dataclasses import dataclass
from os import getenv
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:  # pragma: no cover - typing only
    from crewai import LLM as _LLM  # noqa: F401

ChatMode = Literal["echo", "single", "multi"]


def _require_crewai() -> SimpleNamespace:
    """按需 import crewai；不存在时给出友好提示。"""
    try:
        from crewai import Agent, Crew, LLM, Process, Task  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover - graceful fallback
        raise CrewRuntimeConfigError(
            "CrewAI 未安装。当前默认引擎为 openai；如需 crewai 引擎请执行: "
            "uv sync --extra crewai （或 pip install 'crewai>=1.14.2'）。"
        ) from exc
    return SimpleNamespace(Agent=Agent, Crew=Crew, LLM=LLM, Process=Process, Task=Task)


class CrewRuntimeConfigError(ValueError):
    """Raised when CrewAI runtime config is missing or invalid."""


@dataclass(frozen=True)
class CrewRuntimeConfig:
    model: str
    api_key: str | None
    base_url: str | None
    temperature: float
    max_iter: int


def run_crewai_chat(
    *,
    mode: ChatMode,
    message: str,
    workspace_root: str,
) -> str:
    """Run CrewAI pipeline for the given mode and return plain assistant text."""
    crewai = _require_crewai()
    cfg = load_runtime_config()
    llm = build_llm(cfg, crewai=crewai)

    if mode == "single":
        return run_single_task(
            llm=llm,
            max_iter=cfg.max_iter,
            message=message,
            workspace_root=workspace_root,
            crewai=crewai,
        )
    if mode == "multi":
        return run_multi_task(
            llm=llm,
            max_iter=cfg.max_iter,
            message=message,
            workspace_root=workspace_root,
            crewai=crewai,
        )
    raise CrewRuntimeConfigError(f"unsupported CrewAI mode: {mode}")


def load_runtime_config() -> CrewRuntimeConfig:
    """Load CrewAI runtime config from environment.

    Required:
    - WFM_CREWAI_MODEL: model id, e.g. `openai/gpt-4.1-mini`

    Optional:
    - WFM_CREWAI_API_KEY
    - WFM_CREWAI_BASE_URL
    - WFM_CREWAI_TEMPERATURE (default 0.2)
    - WFM_CREWAI_MAX_ITER (default 8)
    """
    model = (getenv("WFM_CREWAI_MODEL") or "").strip()
    if not model:
        raise CrewRuntimeConfigError(
            "CrewAI 模式未配置：请设置环境变量 WFM_CREWAI_MODEL "
            "(例如 openai/gpt-4.1-mini)。"
        )

    temp_raw = (getenv("WFM_CREWAI_TEMPERATURE") or "0.2").strip()
    max_iter_raw = (getenv("WFM_CREWAI_MAX_ITER") or "8").strip()
    try:
        temperature = float(temp_raw)
    except ValueError as exc:
        raise CrewRuntimeConfigError(
            f"WFM_CREWAI_TEMPERATURE 非法: {temp_raw!r}"
        ) from exc
    try:
        max_iter = int(max_iter_raw)
    except ValueError as exc:
        raise CrewRuntimeConfigError(
            f"WFM_CREWAI_MAX_ITER 非法: {max_iter_raw!r}"
        ) from exc

    if max_iter <= 0:
        raise CrewRuntimeConfigError("WFM_CREWAI_MAX_ITER 必须 > 0")

    return CrewRuntimeConfig(
        model=model,
        api_key=(getenv("WFM_CREWAI_API_KEY") or "").strip() or None,
        base_url=(getenv("WFM_CREWAI_BASE_URL") or "").strip() or None,
        temperature=temperature,
        max_iter=max_iter,
    )


def build_llm(cfg: CrewRuntimeConfig, *, crewai: SimpleNamespace | None = None) -> Any:
    crewai = crewai or _require_crewai()
    kwargs: dict[str, object] = {
        "model": cfg.model,
        "temperature": cfg.temperature,
    }
    if cfg.api_key:
        kwargs["api_key"] = cfg.api_key
    if cfg.base_url:
        kwargs["base_url"] = cfg.base_url
    return crewai.LLM(**kwargs)


def run_single_task(
    *,
    llm: Any,
    max_iter: int,
    message: str,
    workspace_root: str,
    crewai: SimpleNamespace | None = None,
) -> str:
    """Step E-1: one agent + one task."""
    crewai = crewai or _require_crewai()
    Agent, Crew, Process, Task = crewai.Agent, crewai.Crew, crewai.Process, crewai.Task
    writer = Agent(
        role="WFM Writer",
        goal="给出可执行、结构清晰的中文回复",
        backstory="你是 WFM Studio 的写作助手，优先给出直接可落地建议。",
        llm=llm,
        verbose=False,
        allow_delegation=False,
        max_iter=max_iter,
    )
    task = Task(
        description=(
            "用户当前工作区为: {workspace_root}\n"
            "用户消息: {message}\n\n"
            "请直接给出中文回复。若涉及代码改动，优先列出可执行步骤。"
        ),
        expected_output="一个简洁、可执行的中文回复。",
        agent=writer,
    )
    crew = Crew(
        agents=[writer],
        tasks=[task],
        process=Process.sequential,
        verbose=False,
    )
    result = crew.kickoff(inputs={"workspace_root": workspace_root, "message": message})
    return stringify_output(result)


def run_multi_task(
    *,
    llm: Any,
    max_iter: int,
    message: str,
    workspace_root: str,
    crewai: SimpleNamespace | None = None,
) -> str:
    """Step E-2 skeleton: researcher -> writer -> reviewer."""
    crewai = crewai or _require_crewai()
    Agent, Crew, Process, Task = crewai.Agent, crewai.Crew, crewai.Process, crewai.Task
    researcher = Agent(
        role="Researcher",
        goal="提炼需求要点、限制和风险",
        backstory="你擅长把含糊需求拆成可执行要点。",
        llm=llm,
        verbose=False,
        allow_delegation=False,
        max_iter=max_iter,
    )
    writer = Agent(
        role="Writer",
        goal="输出结构化执行方案",
        backstory="你把研究结论组织为清晰计划与产出。",
        llm=llm,
        verbose=False,
        allow_delegation=False,
        max_iter=max_iter,
    )
    reviewer = Agent(
        role="Reviewer",
        goal="审查可行性并给出最终版",
        backstory="你会修正不现实步骤并补齐边界条件。",
        llm=llm,
        verbose=False,
        allow_delegation=False,
        max_iter=max_iter,
    )

    t1 = Task(
        description=(
            "工作区: {workspace_root}\n"
            "用户消息: {message}\n"
            "输出需求拆解（目标、输入、约束、风险、验收标准）。"
        ),
        expected_output="结构化需求拆解清单。",
        agent=researcher,
    )
    t2 = Task(
        description=(
            "基于上一任务结果，产出可执行方案："
            "包含步骤、注意事项、最小验证清单。"
        ),
        expected_output="可执行方案草稿。",
        agent=writer,
        context=[t1],
    )
    t3 = Task(
        description="审查并改写为最终回复，要求准确、简洁、可直接执行。",
        expected_output="最终中文回复。",
        agent=reviewer,
        context=[t2],
    )

    crew = Crew(
        agents=[researcher, writer, reviewer],
        tasks=[t1, t2, t3],
        process=Process.sequential,
        verbose=False,
    )
    result = crew.kickoff(inputs={"workspace_root": workspace_root, "message": message})
    return stringify_output(result)


def stringify_output(result: object) -> str:
    """Normalize Crew/CrewOutput/TaskOutput into plain text."""
    # CrewOutput usually has .raw / .output attributes.
    for attr in ("raw", "output", "result"):
        value = getattr(result, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()

    # Fallback: stringify object
    text = str(result).strip()
    if text:
        return text
    return "CrewAI 执行完成，但未返回可展示文本。"

