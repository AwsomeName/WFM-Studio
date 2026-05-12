"""OpenAI engine configuration and upstream errors."""

from __future__ import annotations


class OpenAIConfigError(ValueError):
    """Missing or invalid OpenAI env configuration (HTTP 400)."""


class OpenAIApiError(Exception):
    """OpenAI API request failed; carries HTTP status for routes."""

    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code
