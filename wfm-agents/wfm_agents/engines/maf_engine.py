"""Microsoft Agent Framework engine backed by local DevUI."""

from __future__ import annotations

from typing import ClassVar

from .devui_engine import DevUIEngine


class MafEngine(DevUIEngine):
    engine_id: ClassVar[str] = "maf"
    env_base_url: ClassVar[str] = "WFM_MAF_DEVUI_URL"
    default_base_url: ClassVar[str] = "http://127.0.0.1:18082"
    env_entity_id: ClassVar[str] = "WFM_MAF_ENTITY_ID"
    default_entity_id: ClassVar[str] = "agent_weather"
