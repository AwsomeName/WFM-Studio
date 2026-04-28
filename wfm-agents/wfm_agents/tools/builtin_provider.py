"""Builtin tools: wfm.workspace_read / wfm.workspace_write (DEV M1)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..fs_ops import read_text, write_text
from ..gateway.session import SessionContext
from ..workspace import WorkspaceViolation
from .spec import ToolResult, ToolSpec


class _ReadArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(..., min_length=1, description="Path relative to workspace_root.")


class _WriteArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(..., min_length=1)
    content: str = Field(...)
    overwrite: bool = True


class BuiltinToolProvider:
    """Registers workspace read/write backed by `fs_ops`."""

    _FQNS_READ = "wfm.workspace_read"
    _FQNS_WRITE = "wfm.workspace_write"

    def list_tool_specs(self, _ctx: SessionContext) -> list[ToolSpec]:
        return [
            ToolSpec(
                fqn=self._FQNS_READ,
                title="Read a UTF-8 file inside the workspace",
                json_schema=_ReadArgs.model_json_schema(),
                risk_tier="read",
                origin="builtin",
            ),
            ToolSpec(
                fqn=self._FQNS_WRITE,
                title="Write a UTF-8 file inside the workspace",
                json_schema=_WriteArgs.model_json_schema(),
                risk_tier="write",
                origin="builtin",
            ),
        ]

    def execute(self, fqn: str, args: dict[str, Any], ctx: SessionContext) -> ToolResult:
        if fqn == self._FQNS_READ:
            return self._read(ctx, args)
        if fqn == self._FQNS_WRITE:
            return self._write(ctx, args)
        return ToolResult(ok=False, data=None, error=f"builtin: unsupported fqn: {fqn}")

    def _read(self, ctx: SessionContext, args: dict[str, Any]) -> ToolResult:
        try:
            parsed = _ReadArgs.model_validate(args)
            text = read_text(ctx.workspace_root, parsed.path)
        except ValidationError as exc:
            return ToolResult(ok=False, data=None, error=str(exc))
        except WorkspaceViolation as exc:
            return ToolResult(ok=False, data=None, error=str(exc))
        except FileNotFoundError as exc:
            return ToolResult(ok=False, data=None, error=str(exc))
        except OSError as exc:
            return ToolResult(ok=False, data=None, error=str(exc))
        return ToolResult(ok=True, data={"content": text}, error=None)

    def _write(self, ctx: SessionContext, args: dict[str, Any]) -> ToolResult:
        try:
            parsed = _WriteArgs.model_validate(args)
            result = write_text(
                ctx.workspace_root,
                parsed.path,
                parsed.content,
                overwrite=parsed.overwrite,
            )
        except ValidationError as exc:
            return ToolResult(ok=False, data=None, error=str(exc))
        except WorkspaceViolation as exc:
            return ToolResult(ok=False, data=None, error=str(exc))
        except FileExistsError as exc:
            return ToolResult(ok=False, data=None, error=str(exc))
        except OSError as exc:
            return ToolResult(ok=False, data=None, error=str(exc))
        return ToolResult(
            ok=True,
            data={"written_path": result.written_path, "bytes_written": result.bytes_written},
            error=None,
        )
