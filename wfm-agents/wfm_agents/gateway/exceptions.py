"""Gateway-specific errors surfaced to HTTP (DEV M2 / ARCH §12)."""

from __future__ import annotations


class EngineNotInstalledError(Exception):
    """Requested engine adapter is not available (ENGINE_NOT_INSTALLED)."""

    def __init__(self, engine_id: str, hint: str = "") -> None:
        self.engine_id = engine_id
        self.hint = hint or f"engine {engine_id!r} is not installed"
        super().__init__(self.hint)
