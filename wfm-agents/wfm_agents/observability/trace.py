"""trace_id / span_id generation for structured logs (ARCH §10)."""

from __future__ import annotations

import uuid


def new_trace_id() -> str:
    """Return a new UUID string for one agent turn."""
    return str(uuid.uuid4())


def new_span_id() -> str:
    """Return a new UUID string for a nested span (tool / LLM)."""
    return str(uuid.uuid4())
