"""CAD tool provider — wraps text-to-cad CLI as builtin tools.

Exposes four tools that invoke the text-to-cad ``scripts/step``,
``scripts/inspect``, ``scripts/render``, and ``scripts/dxf`` CLIs via
subprocess.  All file paths are workspace-relative and validated through
:func:`~wfm_agents.workspace.resolve_within`.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
from os import getenv
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..gateway.session import SessionContext
from ..workspace import WorkspaceViolation, resolve_within
from .spec import ToolResult, ToolSpec

_log = logging.getLogger(__name__)


class _GenerateStepArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_path: str = Field(
        ...,
        min_length=1,
        description="Workspace-relative path to a Python file defining gen_step().",
    )
    output_path: str | None = Field(
        default=None,
        description="Optional workspace-relative output STEP path.",
    )
    kind: str | None = Field(
        default=None,
        description="Direct STEP/STP import kind: 'part' or 'assembly'.",
    )
    stl_path: str | None = Field(
        default=None,
        description="Optional workspace-relative STL sidecar path.",
    )


class _InspectArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target: str = Field(
        ...,
        min_length=1,
        description="Workspace-relative STEP path or @cad[...] reference.",
    )
    facts: bool = Field(default=True, description="Include geometry facts.")
    planes: bool = Field(default=True, description="Include planar face groups.")
    positioning: bool = Field(
        default=False, description="Include placement-ready frame facts."
    )


class _RenderArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input: str = Field(
        ...,
        min_length=1,
        description="Workspace-relative STEP/GLB path or @cad[...] reference.",
    )
    output_path: str = Field(
        ...,
        min_length=1,
        description="Workspace-relative output PNG/SVG path.",
    )
    camera: str = Field(default="iso", description="Camera preset (iso, front, top, etc.).")
    width: int = Field(default=1400, description="Output image width.")
    height: int = Field(default=900, description="Output image height.")


class _ExportDxfArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_path: str = Field(
        ...,
        min_length=1,
        description="Workspace-relative Python source defining gen_dxf().",
    )
    output_path: str | None = Field(
        default=None,
        description="Optional workspace-relative DXF output path.",
    )


class CadToolProvider:
    """Registers CAD generation/inspection/render/export tools backed by text-to-cad CLIs."""

    FQN_STEP = "wfm.cad_generate_step"
    FQN_INSPECT = "wfm.cad_inspect"
    FQN_RENDER = "wfm.cad_render"
    FQN_DXF = "wfm.cad_export_dxf"

    def __init__(self, cad_skill_dir: str | None = None) -> None:
        self._cad_skill_dir = Path(
            cad_skill_dir or getenv("WFM_CAD_SKILL_DIR", "")
        )
        if not self._cad_skill_dir:
            pkg_root = Path(__file__).resolve().parents[2]  # wfm-agents/
            self._cad_skill_dir = (
                pkg_root.parent / "third_party" / "text-to-cad" / "skills" / "cad"
            )

    def _python_bin(self) -> str:
        return getenv("WFM_CAD_PYTHON", "") or sys.executable

    def list_tool_specs(self, _ctx: SessionContext) -> list[ToolSpec]:
        return [
            ToolSpec(
                fqn=self.FQN_STEP,
                title="Generate STEP/STP CAD file from a build123d Python source.",
                json_schema=_GenerateStepArgs.model_json_schema(),
                risk_tier="write",
                origin="builtin",
            ),
            ToolSpec(
                fqn=self.FQN_INSPECT,
                title="Inspect STEP geometry: facts, planes, positioning.",
                json_schema=_InspectArgs.model_json_schema(),
                risk_tier="read",
                origin="builtin",
            ),
            ToolSpec(
                fqn=self.FQN_RENDER,
                title="Render a STEP/GLB model to PNG/SVG image.",
                json_schema=_RenderArgs.model_json_schema(),
                risk_tier="read",
                origin="builtin",
            ),
            ToolSpec(
                fqn=self.FQN_DXF,
                title="Export DXF from a Python source defining gen_dxf().",
                json_schema=_ExportDxfArgs.model_json_schema(),
                risk_tier="write",
                origin="builtin",
            ),
        ]

    def execute(
        self, fqn: str, args: dict[str, Any], ctx: SessionContext
    ) -> ToolResult:
        dispatch = {
            self.FQN_STEP: self._generate_step,
            self.FQN_INSPECT: self._inspect,
            self.FQN_RENDER: self._render,
            self.FQN_DXF: self._export_dxf,
        }
        handler = dispatch.get(fqn)
        if handler is None:
            return ToolResult(ok=False, error=f"cad: unsupported fqn: {fqn}")
        return handler(ctx, args)

    def _generate_step(self, ctx: SessionContext, args: dict[str, Any]) -> ToolResult:
        try:
            parsed = _GenerateStepArgs.model_validate(args)
        except ValidationError as exc:
            return ToolResult(ok=False, error=str(exc))

        try:
            source = resolve_within(ctx.workspace_root, parsed.source_path)
        except WorkspaceViolation as exc:
            return ToolResult(ok=False, error=str(exc))

        cmd: list[str] = [
            self._python_bin(),
            str(self._cad_skill_dir / "scripts" / "step"),
            str(source),
        ]

        if parsed.kind:
            cmd += ["--kind", parsed.kind]
        if parsed.output_path:
            try:
                output = resolve_within(ctx.workspace_root, parsed.output_path)
            except WorkspaceViolation as exc:
                return ToolResult(ok=False, error=str(exc))
            cmd += ["-o", str(output)]
        if parsed.stl_path:
            try:
                stl = resolve_within(ctx.workspace_root, parsed.stl_path)
            except WorkspaceViolation as exc:
                return ToolResult(ok=False, error=str(exc))
            cmd += ["--stl", str(stl)]
        cmd.append("--skip-explorer")

        return self._run_subprocess(cmd, ctx.workspace_root, timeout=120)

    def _inspect(self, ctx: SessionContext, args: dict[str, Any]) -> ToolResult:
        try:
            parsed = _InspectArgs.model_validate(args)
        except ValidationError as exc:
            return ToolResult(ok=False, error=str(exc))

        cmd: list[str] = [
            self._python_bin(),
            str(self._cad_skill_dir / "scripts" / "inspect"),
            "refs",
            parsed.target,
            "--format",
            "json",
        ]
        if parsed.facts:
            cmd.append("--facts")
        if parsed.planes:
            cmd.append("--planes")
        if parsed.positioning:
            cmd.append("--positioning")

        result = self._run_subprocess(cmd, ctx.workspace_root, timeout=30)
        if result.ok and result.data and result.data.get("stdout"):
            try:
                parsed_json = json.loads(result.data["stdout"])
                return ToolResult(ok=True, data=parsed_json)
            except json.JSONDecodeError:
                return ToolResult(ok=True, data={"raw": result.data["stdout"]})
        return result

    def _render(self, ctx: SessionContext, args: dict[str, Any]) -> ToolResult:
        try:
            parsed = _RenderArgs.model_validate(args)
        except ValidationError as exc:
            return ToolResult(ok=False, error=str(exc))

        try:
            input_path = resolve_within(ctx.workspace_root, parsed.input)
            output_path = resolve_within(ctx.workspace_root, parsed.output_path)
        except WorkspaceViolation as exc:
            return ToolResult(ok=False, error=str(exc))

        cmd: list[str] = [
            self._python_bin(),
            str(self._cad_skill_dir / "scripts" / "render"),
            "view",
            str(input_path),
            "--camera",
            parsed.camera,
            "-o",
            str(output_path),
            "--width",
            str(parsed.width),
            "--height",
            str(parsed.height),
        ]

        result = self._run_subprocess(cmd, ctx.workspace_root, timeout=60)
        if result.ok:
            return ToolResult(ok=True, data={"image_path": parsed.output_path})
        return result

    def _export_dxf(self, ctx: SessionContext, args: dict[str, Any]) -> ToolResult:
        try:
            parsed = _ExportDxfArgs.model_validate(args)
        except ValidationError as exc:
            return ToolResult(ok=False, error=str(exc))

        try:
            source = resolve_within(ctx.workspace_root, parsed.source_path)
        except WorkspaceViolation as exc:
            return ToolResult(ok=False, error=str(exc))

        cmd: list[str] = [
            self._python_bin(),
            str(self._cad_skill_dir / "scripts" / "dxf"),
            str(source),
        ]
        if parsed.output_path:
            try:
                output = resolve_within(ctx.workspace_root, parsed.output_path)
            except WorkspaceViolation as exc:
                return ToolResult(ok=False, error=str(exc))
            cmd += ["-o", str(output)]

        return self._run_subprocess(cmd, ctx.workspace_root, timeout=60)

    def _run_subprocess(
        self,
        cmd: list[str],
        cwd: str,
        *,
        timeout: int = 120,
    ) -> ToolResult:
        _log.info("cad_provider: %s", " ".join(cmd))
        try:
            proc = subprocess.run(
                cmd,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return ToolResult(ok=False, error=f"Command timed out after {timeout}s")
        except FileNotFoundError as exc:
            return ToolResult(ok=False, error=f"Command not found: {exc}")

        if proc.returncode != 0:
            stderr = proc.stderr.strip()
            _log.warning("cad_provider failed (rc=%d): %s", proc.returncode, stderr)
            return ToolResult(ok=False, error=stderr or f"Exit code {proc.returncode}")

        return ToolResult(
            ok=True,
            data={"stdout": proc.stdout.strip()} if proc.stdout.strip() else {},
        )
