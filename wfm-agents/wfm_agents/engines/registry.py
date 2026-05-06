"""Registry of engine_id → adapter (DEV M2)."""

from __future__ import annotations

from .agenticx_engine import AgenticxEngine
from .anthropic_engine import AnthropicEngine
from .base import EngineAdapter
from .crewai_engine import CrewAIEngine
from .maf_engine import MafEngine


class EngineRegistry:
    def __init__(self, engines: dict[str, EngineAdapter]) -> None:
        self._engines = dict(engines)

    def get(self, engine_id: str) -> EngineAdapter:
        adapter = self._engines.get(engine_id)
        if adapter is None:
            msg = f"unknown engine_id: {engine_id!r}"
            raise KeyError(msg)
        return adapter


def build_default_engine_registry() -> EngineRegistry:
    return EngineRegistry(
        {
            CrewAIEngine.engine_id: CrewAIEngine(),
            MafEngine.engine_id: MafEngine(),
            AgenticxEngine.engine_id: AgenticxEngine(),
            AnthropicEngine.engine_id: AnthropicEngine(),
        }
    )
