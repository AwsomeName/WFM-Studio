"""Tool functions registered with @function_tool (OpenAI Agents SDK).

Each tool delegates to the same backend logic as the legacy
BuiltinToolProvider / CadToolProvider so behaviour is identical.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
from os import getenv
from pathlib import Path

from agents import RunContextWrapper, function_tool

from ..fs_ops import read_text, write_text
from ..workspace import WorkspaceViolation, resolve_within

_log = logging.getLogger(__name__)


# ── helpers ───────────────────────────────────────────────────────────


def _cad_skill_dir() -> Path:
    d = Path(getenv("WFM_CAD_SKILL_DIR", ""))
    if d.name:
        return d
    pkg_root = Path(__file__).resolve().parents[2]  # wfm-agents/
    return pkg_root.parent / "third_party" / "text-to-cad" / "skills" / "cad"


def _python_bin() -> str:
    return getenv("WFM_CAD_PYTHON", "") or sys.executable


def _run_cad_subprocess(cmd: list[str], cwd: str, *, timeout: int = 120) -> str:
    _log.info("cad_v2: %s", " ".join(cmd))
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        return f"Error: Command timed out after {timeout}s"
    except FileNotFoundError as exc:
        return f"Error: Command not found: {exc}"

    if proc.returncode != 0:
        return f"Error: {proc.stderr.strip() or f'Exit code {proc.returncode}'}"

    return proc.stdout.strip() or "OK"


# ── Builtin tools ─────────────────────────────────────────────────────


@function_tool
def workspace_read(ctx: RunContextWrapper, path: str) -> str:
    """Read a UTF-8 text file inside the workspace.

    Args:
        path: Relative path to the file within the workspace.
    """
    try:
        return read_text(ctx.context.workspace_root, path)
    except (WorkspaceViolation, FileNotFoundError, OSError) as exc:
        return f"Error: {exc}"


@function_tool
def workspace_write(
    ctx: RunContextWrapper, path: str, content: str, overwrite: bool = True
) -> str:
    """Write a UTF-8 text file inside the workspace.

    Args:
        path: Relative path to the file within the workspace.
        content: Text content to write.
        overwrite: Whether to overwrite an existing file. Default True.
    """
    try:
        result = write_text(
            ctx.context.workspace_root, path, content, overwrite=overwrite
        )
    except (WorkspaceViolation, FileExistsError, OSError) as exc:
        return f"Error: {exc}"
    return f"Written {result.bytes_written} bytes to {result.written_path}"


# ── CAD tools ─────────────────────────────────────────────────────────


@function_tool
def cad_generate_step(
    ctx: RunContextWrapper,
    source_path: str,
    output_path: str | None = None,
    kind: str | None = None,
    stl_path: str | None = None,
) -> str:
    """Generate a STEP/STP CAD file from a build123d Python source.

    Args:
        source_path: Workspace-relative path to the Python source file.
        output_path: Optional workspace-relative output STEP path.
        kind: Direct STEP/STP import kind ('part' or 'assembly').
        stl_path: Optional workspace-relative STL sidecar path.
    """
    root = ctx.context.workspace_root
    try:
        source = resolve_within(root, source_path)
    except WorkspaceViolation as exc:
        return f"Error: {exc}"

    cmd = [_python_bin(), str(_cad_skill_dir() / "scripts" / "step"), str(source)]
    if kind:
        cmd += ["--kind", kind]
    if output_path:
        try:
            out = resolve_within(root, output_path)
        except WorkspaceViolation as exc:
            return f"Error: {exc}"
        cmd += ["-o", str(out)]
    if stl_path:
        try:
            stl = resolve_within(root, stl_path)
        except WorkspaceViolation as exc:
            return f"Error: {exc}"
        cmd += ["--stl", str(stl)]
    cmd.append("--skip-explorer")

    return _run_cad_subprocess(cmd, root)


@function_tool
def cad_inspect(
    ctx: RunContextWrapper,
    target: str,
    facts: bool = True,
    planes: bool = True,
    positioning: bool = False,
) -> str:
    """Inspect STEP geometry for facts, planes, and positioning data.

    Args:
        target: Workspace-relative STEP path or @cad[...] reference.
        facts: Include geometry facts. Default True.
        planes: Include planar face groups. Default True.
        positioning: Include placement-ready frame facts. Default False.
    """
    root = ctx.context.workspace_root
    cmd = [
        _python_bin(),
        str(_cad_skill_dir() / "scripts" / "inspect"),
        "refs",
        target,
        "--format",
        "json",
    ]
    if facts:
        cmd.append("--facts")
    if planes:
        cmd.append("--planes")
    if positioning:
        cmd.append("--positioning")

    raw = _run_cad_subprocess(cmd, root, timeout=30)
    try:
        parsed = json.loads(raw)
        return json.dumps(parsed, ensure_ascii=False)
    except (json.JSONDecodeError, TypeError):
        return raw


@function_tool
def cad_render(
    ctx: RunContextWrapper,
    input_path: str,
    output_path: str,
    camera: str = "iso",
    width: int = 1400,
    height: int = 900,
) -> str:
    """Render a STEP/GLB model to a PNG or SVG image.

    Args:
        input_path: Workspace-relative STEP/GLB path or @cad[...] reference.
        output_path: Workspace-relative output PNG/SVG path.
        camera: Camera preset (iso, front, top, etc.). Default 'iso'.
        width: Output image width. Default 1400.
        height: Output image height. Default 900.
    """
    root = ctx.context.workspace_root
    try:
        src = resolve_within(root, input_path)
        dst = resolve_within(root, output_path)
    except WorkspaceViolation as exc:
        return f"Error: {exc}"

    cmd = [
        _python_bin(),
        str(_cad_skill_dir() / "scripts" / "render"),
        "view",
        str(src),
        "--camera",
        camera,
        "-o",
        str(dst),
        "--width",
        str(width),
        "--height",
        str(height),
    ]
    _run_cad_subprocess(cmd, root, timeout=60)
    return f"Rendered to {output_path}"


@function_tool
def cad_export_dxf(
    ctx: RunContextWrapper,
    source_path: str,
    output_path: str | None = None,
) -> str:
    """Export a DXF file from a Python source defining gen_dxf().

    Args:
        source_path: Workspace-relative Python source path.
        output_path: Optional workspace-relative DXF output path.
    """
    root = ctx.context.workspace_root
    try:
        source = resolve_within(root, source_path)
    except WorkspaceViolation as exc:
        return f"Error: {exc}"

    cmd = [_python_bin(), str(_cad_skill_dir() / "scripts" / "dxf"), str(source)]
    if output_path:
        try:
            out = resolve_within(root, output_path)
        except WorkspaceViolation as exc:
            return f"Error: {exc}"
        cmd += ["-o", str(out)]

    return _run_cad_subprocess(cmd, root, timeout=60)


# ── Exported tool lists for agents ────────────────────────────────────

builtin_tools = [workspace_read, workspace_write]
cad_tools = [
    workspace_read,
    workspace_write,
    cad_generate_step,
    cad_inspect,
    cad_render,
    cad_export_dxf,
]
