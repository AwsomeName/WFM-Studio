"""Unit tests for the workspace path-traversal guard."""

from __future__ import annotations

from pathlib import Path

import pytest

from wfm_agents.workspace import (
    WorkspaceViolation,
    resolve_within,
    resolve_workspace_root,
)


def test_resolve_workspace_root_ok(tmp_path: Path) -> None:
    resolved = resolve_workspace_root(str(tmp_path))
    assert resolved == tmp_path.resolve()


def test_resolve_workspace_root_missing(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    with pytest.raises(WorkspaceViolation):
        resolve_workspace_root(str(missing))


def test_resolve_workspace_root_not_a_dir(tmp_path: Path) -> None:
    file_path = tmp_path / "file.txt"
    file_path.write_text("x")
    with pytest.raises(WorkspaceViolation):
        resolve_workspace_root(str(file_path))


def test_resolve_workspace_root_must_be_absolute() -> None:
    with pytest.raises(WorkspaceViolation):
        resolve_workspace_root("relative/path")


def test_resolve_within_plain(tmp_path: Path) -> None:
    target = resolve_within(str(tmp_path), "notes/draft.md")
    assert target == (tmp_path / "notes" / "draft.md").resolve()


def test_resolve_within_rejects_absolute(tmp_path: Path) -> None:
    with pytest.raises(WorkspaceViolation):
        resolve_within(str(tmp_path), "/etc/passwd")


def test_resolve_within_rejects_dotdot(tmp_path: Path) -> None:
    with pytest.raises(WorkspaceViolation):
        resolve_within(str(tmp_path), "../../etc/passwd")


def test_resolve_within_rejects_symlink_escape(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside-target"
    outside.mkdir(exist_ok=True)
    try:
        link = tmp_path / "escape"
        link.symlink_to(outside)
        with pytest.raises(WorkspaceViolation):
            resolve_within(str(tmp_path), "escape/secret.txt")
    finally:
        if outside.exists():
            for p in outside.iterdir():
                p.unlink()
            outside.rmdir()
