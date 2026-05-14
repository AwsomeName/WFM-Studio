"""Agent v2 context — carries workspace_root into every tool call."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class WfmAgentContext:
    workspace_root: str
