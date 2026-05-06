"""Per-turn session context (trace, workspace binding, cancellation — M3+)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from ..tools.policy import ToolPolicy


@dataclass
class SessionContext:
    """Resolved workspace + correlation ids for one agent turn."""

    workspace_root: str
    trace_id: str
    message: str = ""
    session_id: str | None = None
    recipe_id: str | None = None
    model_override: str | None = None
    client_meta: dict[str, Any] | None = None
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    tool_policy: ToolPolicy | None = None
