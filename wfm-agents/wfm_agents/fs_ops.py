"""Workspace filesystem helpers shared by HTTP routes and builtin tools.

All paths are constrained with `resolve_within` (ARCH §5.1).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .workspace import WorkspaceViolation, resolve_within


@dataclass(frozen=True)
class WriteResult:
    written_path: str
    bytes_written: int


def read_text(workspace_root: str, relative_path: str) -> str:
    """Read a UTF-8 text file inside the workspace."""
    target = resolve_within(workspace_root, relative_path)
    if not target.exists():
        raise FileNotFoundError(str(target))
    if not target.is_file():
        raise IsADirectoryError(str(target))
    return target.read_text(encoding="utf-8")


def write_text(
    workspace_root: str,
    relative_path: str,
    content: str,
    *,
    overwrite: bool = True,
) -> WriteResult:
    """Write UTF-8 text; creates parent directories. Raises FileExistsError if not overwrite."""
    target = resolve_within(workspace_root, relative_path)
    if target.exists() and not target.is_file():
        raise IsADirectoryError(str(target))
    if target.exists() and not overwrite:
        raise FileExistsError(str(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    data = content.encode("utf-8")
    target.write_bytes(data)
    return WriteResult(written_path=str(target), bytes_written=len(data))
