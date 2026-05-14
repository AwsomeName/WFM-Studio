"""Agent runner configuration (env-driven, see ARCH_AGENT_SDK_NATIVE §5)."""

from __future__ import annotations

from dataclasses import dataclass
from os import getenv

DEFAULT_MODEL = "gpt-4.1-mini"


class AgentConfigError(RuntimeError):
    """Raised when required env vars are missing or malformed."""


@dataclass(frozen=True)
class AgentConfig:
    api_key: str
    base_url: str | None
    model: str
    fallback_models: tuple[str, ...]
    use_responses_api: bool
    request_timeout: float
    max_retries: int
    temperature: float
    max_tool_rounds: int
    session_ttl_sec: int
    allow_image: bool


def _read_float(name: str, default: str) -> float:
    raw = (getenv(name) or default).strip()
    try:
        return float(raw)
    except ValueError as exc:  # pragma: no cover - configuration error path
        raise AgentConfigError(f"{name} 非法: {raw!r}") from exc


def _read_int(name: str, default: str) -> int:
    raw = (getenv(name) or default).strip()
    try:
        return int(raw)
    except ValueError as exc:  # pragma: no cover - configuration error path
        raise AgentConfigError(f"{name} 非法: {raw!r}") from exc


def _read_bool(name: str, default: str = "false") -> bool:
    raw = (getenv(name) or default).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def load_config(
    *,
    model_override: str | None = None,
    temperature_override: float | None = None,
) -> AgentConfig:
    """Load AgentConfig from environment variables.

    ``model_override`` takes precedence over ``WFM_AGENT_MODEL`` /
    ``WFM_OPENAI_MODEL`` so recipes (e.g. CAD review) can request a specific
    model without mutating the global env.
    """
    api_key = (getenv("WFM_OPENAI_API_KEY") or getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise AgentConfigError(
            "未配置 OpenAI API Key：请设置 WFM_OPENAI_API_KEY 或 OPENAI_API_KEY。"
        )
    base_url = (getenv("WFM_OPENAI_BASE_URL") or "").strip() or None

    model = (
        model_override
        or getenv("WFM_AGENT_MODEL")
        or getenv("WFM_OPENAI_MODEL")
        or DEFAULT_MODEL
    ).strip()

    fallbacks_raw = (getenv("WFM_AGENT_FALLBACKS") or "").strip()
    fallback_models = tuple(
        f.strip() for f in fallbacks_raw.split(",") if f.strip()
    )

    api_mode = (getenv("WFM_AGENT_API") or "responses").strip().lower()
    if api_mode not in {"responses", "chat"}:
        raise AgentConfigError(
            f"WFM_AGENT_API 必须是 'responses' 或 'chat'，收到 {api_mode!r}"
        )
    use_responses = api_mode == "responses"

    temperature = (
        temperature_override
        if temperature_override is not None
        else _read_float("WFM_AGENT_TEMP", "0.3")
    )

    return AgentConfig(
        api_key=api_key,
        base_url=base_url,
        model=model,
        fallback_models=fallback_models,
        use_responses_api=use_responses,
        request_timeout=_read_float("WFM_AGENT_TIMEOUT", "120"),
        max_retries=_read_int("WFM_AGENT_RETRIES", "2"),
        temperature=temperature,
        max_tool_rounds=_read_int("WFM_AGENT_MAX_TOOL_ROUNDS", "8"),
        session_ttl_sec=_read_int("WFM_AGENT_SESSION_TTL_SEC", "3600"),
        allow_image=_read_bool("WFM_AGENT_ALLOW_IMAGE", "false"),
    )
