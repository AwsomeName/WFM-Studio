"""AgenticX engine backed by local DevUI."""

from __future__ import annotations

from typing import ClassVar

from .devui_engine import DevUIEngine


class AgenticxEngine(DevUIEngine):
    engine_id: ClassVar[str] = "agenticx"
    env_base_url: ClassVar[str] = "WFM_AGENTICX_DEVUI_URL"
    default_base_url: ClassVar[str] = "http://127.0.0.1:18081"
    env_entity_id: ClassVar[str] = "WFM_AGENTICX_ENTITY_ID"
    default_entity_id: ClassVar[str] = "agent_weather"
