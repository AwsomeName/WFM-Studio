"""SSE event constants + frame encoder (replaces old agent/events.py).

Wire format is identical so the front-end's ``EventSource`` consumer keeps
working unchanged: each event is a ``data: <single-line JSON>\\n\\n`` frame.
"""

from __future__ import annotations

import json
from typing import Any, Final

EVENT_SESSION: Final = "session"
EVENT_TEXT_DELTA: Final = "text_delta"
EVENT_TOOL_CALL_STARTED: Final = "tool_call_started"
EVENT_TOOL_CALL_DONE: Final = "tool_call_done"
EVENT_ERROR: Final = "error"
EVENT_DONE: Final = "done"


def encode_sse(event: dict[str, Any]) -> bytes:
    """Encode one event dict as an SSE frame."""
    payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    return f"data: {payload}\n\n".encode("utf-8")
