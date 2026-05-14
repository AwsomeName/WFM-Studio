"""Registry of engine_id → adapter (DEV M2).

CrewAI engine 通过 lazy import 接入：仅在 :func:`build_default_engine_registry`
里尝试 import；失败时跳过注册（请求 ``engine="crewai"`` 会拿到清晰的
``unknown engine_id`` 错误，而不是 ``ImportError`` 把整个 server 拖垮）。

设计目标：调试期默认走 OpenAI SDK，server 启动 import 链里**完全不碰
``crewai`` / ``litellm`` / ``chromadb``**，启动速度回到秒级。
"""

from __future__ import annotations

import logging

from .agenticx_engine import AgenticxEngine
from .base import EngineAdapter
from .maf_engine import MafEngine
from .openai_engine import OpenAIEngine

_log = logging.getLogger(__name__)


class EngineRegistry:
    def __init__(self, engines: dict[str, EngineAdapter]) -> None:
        self._engines = dict(engines)

    def get(self, engine_id: str) -> EngineAdapter:
        adapter = self._engines.get(engine_id)
        if adapter is None:
            msg = f"unknown engine_id: {engine_id!r}"
            raise KeyError(msg)
        return adapter

    def has(self, engine_id: str) -> bool:
        return engine_id in self._engines


def build_default_engine_registry() -> EngineRegistry:
    engines: dict[str, EngineAdapter] = {
        MafEngine.engine_id: MafEngine(),
        AgenticxEngine.engine_id: AgenticxEngine(),
        OpenAIEngine.engine_id: OpenAIEngine(),
    }
    # CrewAI 仅在用户明确请求 engine="crewai" 时才进入 run_turn；
    # 这里 lazy import 一次，缺包就静默跳过注册。
    try:
        from .crewai_engine import CrewAIEngine  # noqa: PLC0415

        engines[CrewAIEngine.engine_id] = CrewAIEngine()
    except ImportError as exc:
        _log.info(
            "CrewAI engine 未注册（缺少 crewai 依赖）；如需启用执行: "
            "uv sync --extra crewai。原因: %s",
            exc,
        )
    return EngineRegistry(engines)
