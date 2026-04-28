"""Load mcp_servers.yaml; expand ${env:NAME} and ${secret:NAME} (ARCH §3.5)."""

from __future__ import annotations

import os
import re
import wfm_agents
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator

_TEMPL = re.compile(r"\$\{(?P<kind>env|secret):(?P<name>[^}]+)\}")


def _expand_str(value: str) -> str:
    def repl(m: re.Match[str]) -> str:
        k = m.group("name")
        v = os.environ.get(k)
        if v is None or v == "":
            msg = f"mcp config: {m.group(0)} not set in environment (key={k!r})"
            raise ValueError(msg)
        return v

    return _TEMPL.sub(repl, value)


def expand_config_strings(obj: Any) -> Any:
    if isinstance(obj, str):
        if "${" in obj:
            return _expand_str(obj)
        return obj
    if isinstance(obj, list):
        return [expand_config_strings(x) for x in obj]
    if isinstance(obj, dict):
        return {k: expand_config_strings(v) for k, v in obj.items()}
    return obj


class McpServerEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(
        ...,
        pattern=r"^[a-z0-9_-]+$",
        description="Used in fqn mcp.{id}.* (ARCH).",
    )
    transport: Literal["stdio", "sse"]
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    url: str | None = None
    env: dict[str, str] = Field(default_factory=dict)
    risk_tier: Literal["read", "write", "exec"] = "read"

    @field_validator("id")
    @classmethod
    def id_lower(cls, v: str) -> str:
        if v != v.lower():
            msg = "MCP server id must be lowercase [a-z0-9_-]+"
            raise ValueError(msg)
        return v


class McpConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    servers: list[McpServerEntry] = Field(default_factory=list)


def default_config_path() -> Path:
    root = os.environ.get("WFM_MCP_CONFIG")
    if root:
        return Path(root).expanduser().resolve()
    return Path(wfm_agents.__file__).resolve().parent / "config" / "mcp_servers.yaml"


def load_mcp_config(path: Path | None = None) -> McpConfig:
    p = path or default_config_path()
    if not p.is_file():
        return McpConfig(servers=[])
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        msg = f"mcp config: expected mapping at top level, got {type(raw)}"
        raise ValueError(msg)
    expanded = expand_config_strings(raw)
    return McpConfig.model_validate(expanded)
