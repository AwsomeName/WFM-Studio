"""Workspace binding and path-traversal guards.

The core security invariant: every filesystem operation requested by a client
must resolve to a path strictly inside the caller-declared `workspace_root`.
Any attempt to escape (via symlinks, `..`, absolute overrides, etc.) is
rejected up-front with a `WorkspaceViolation`.
"""

from __future__ import annotations

from pathlib import Path


class WorkspaceViolation(Exception):
    """Raised when a requested path escapes the declared workspace root."""


def resolve_workspace_root(workspace_root: str) -> Path:
    """Validate and canonicalize a workspace root.

    The directory must exist and be a directory. We intentionally do NOT create
    it on the fly: the client (IDE) must pass a user-selected folder.
    """
    if not workspace_root:
        raise WorkspaceViolation("workspace_root is required")

    root = Path(workspace_root).expanduser()
    if not root.is_absolute():
        raise WorkspaceViolation(
            f"workspace_root must be an absolute path, got: {workspace_root!r}"
        )

    resolved = root.resolve(strict=False)
    if not resolved.exists():
        raise WorkspaceViolation(f"workspace_root does not exist: {resolved}")
    if not resolved.is_dir():
        raise WorkspaceViolation(f"workspace_root is not a directory: {resolved}")

    return resolved


def resolve_within(workspace_root: str, relative_path: str) -> Path:
    """Resolve a relative path within a workspace root, rejecting traversal.

    Rules:
    - `relative_path` may be given with forward slashes; it must not be
      absolute; it must not resolve outside `workspace_root` after normalization
      (including following any existing symlinks).
    - Returns the canonical absolute path.
    """
    root = resolve_workspace_root(workspace_root)

    if not relative_path:
        raise WorkspaceViolation("path is required")

    candidate = Path(relative_path)
    if candidate.is_absolute():
        raise WorkspaceViolation(
            f"path must be relative to workspace_root, got absolute: {relative_path!r}"
        )

    # Join then resolve. `resolve(strict=False)` still normalizes `..` and
    # follows any existing symlink segments, which is exactly what we want for
    # the guard to be meaningful.
    target = (root / candidate).resolve(strict=False)

    try:
        target.relative_to(root)
    except ValueError as exc:
        raise WorkspaceViolation(
            f"path escapes workspace_root: {relative_path!r} -> {target}"
        ) from exc

    return target
