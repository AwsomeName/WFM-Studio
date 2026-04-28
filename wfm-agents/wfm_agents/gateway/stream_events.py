"""SSE encoding for StreamEvent (ARCH §4.2 / DEV M3)."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pydantic import BaseModel


def encode_sse(event: BaseModel) -> bytes:
    """One SSE frame: `data: <single-line JSON>\\n\\n`."""
    payload = event.model_dump_json()
    return f"data: {payload}\n\n".encode("utf-8")
