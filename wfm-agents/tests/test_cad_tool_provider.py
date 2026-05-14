"""Unit tests for CadToolProvider and CadGenerationRecipe."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from wfm_agents.gateway.session import SessionContext
from wfm_agents.tools.cad_provider import CadToolProvider
from wfm_agents.tools.spec import ToolResult


@pytest.fixture
def ctx(tmp_path: Path) -> SessionContext:
    return SessionContext(
        workspace_root=str(tmp_path),
        trace_id="test-trace",
        session_id="test-session",
    )


@pytest.fixture
def provider(tmp_path: Path) -> CadToolProvider:
    skill_dir = tmp_path / "cad_skill"
    skill_dir.mkdir()
    (skill_dir / "scripts").mkdir()
    return CadToolProvider(cad_skill_dir=str(skill_dir))


class TestCadToolProviderSpecs:
    def test_lists_four_tools(self, provider: CadToolProvider, ctx: SessionContext):
        specs = provider.list_tool_specs(ctx)
        assert len(specs) == 4
        fqns = {s.fqn for s in specs}
        assert fqns == {
            "wfm.cad_generate_step",
            "wfm.cad_inspect",
            "wfm.cad_render",
            "wfm.cad_export_dxf",
        }

    def test_step_is_write_tier(self, provider: CadToolProvider, ctx: SessionContext):
        specs = provider.list_tool_specs(ctx)
        step = next(s for s in specs if s.fqn == "wfm.cad_generate_step")
        assert step.risk_tier == "write"
        assert step.origin == "builtin"

    def test_inspect_is_read_tier(self, provider: CadToolProvider, ctx: SessionContext):
        specs = provider.list_tool_specs(ctx)
        inspect = next(s for s in specs if s.fqn == "wfm.cad_inspect")
        assert inspect.risk_tier == "read"


class TestCadToolProviderExecute:
    def test_unknown_fqn_returns_error(
        self, provider: CadToolProvider, ctx: SessionContext
    ):
        result = provider.execute("wfm.unknown", {}, ctx)
        assert result.ok is False
        assert "unsupported fqn" in result.error

    def test_generate_step_resolves_paths(
        self, provider: CadToolProvider, ctx: SessionContext, tmp_path: Path
    ):
        src = tmp_path / "part.py"
        src.write_text("def gen_step(): pass")

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "OK"
        mock_proc.stderr = ""

        with patch("subprocess.run", return_value=mock_proc) as mock_run:
            result = provider.execute(
                "wfm.cad_generate_step",
                {"source_path": "part.py"},
                ctx,
            )

        assert result.ok is True
        cmd = mock_run.call_args[0][0]
        assert str(src) in cmd
        assert "--skip-explorer" in cmd

    def test_generate_step_handles_error(
        self, provider: CadToolProvider, ctx: SessionContext, tmp_path: Path
    ):
        src = tmp_path / "part.py"
        src.write_text("def gen_step(): pass")

        mock_proc = MagicMock()
        mock_proc.returncode = 1
        mock_proc.stdout = ""
        mock_proc.stderr = "build123d error"

        with patch("subprocess.run", return_value=mock_proc):
            result = provider.execute(
                "wfm.cad_generate_step",
                {"source_path": "part.py"},
                ctx,
            )

        assert result.ok is False
        assert "build123d error" in result.error

    def test_inspect_parses_json(
        self, provider: CadToolProvider, ctx: SessionContext, tmp_path: Path
    ):
        step_file = tmp_path / "part.step"
        step_file.write_text("dummy")

        inspect_data = {"facts": {"volume": 1234.5}, "planes": []}

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = json.dumps(inspect_data)
        mock_proc.stderr = ""

        with patch("subprocess.run", return_value=mock_proc) as mock_run:
            result = provider.execute(
                "wfm.cad_inspect",
                {"target": "part.step", "facts": True, "planes": True},
                ctx,
            )

        assert result.ok is True
        assert result.data["facts"]["volume"] == 1234.5
        cmd = mock_run.call_args[0][0]
        assert "--facts" in cmd
        assert "--planes" in cmd

    def test_render_command(
        self, provider: CadToolProvider, ctx: SessionContext, tmp_path: Path
    ):
        step_file = tmp_path / "part.step"
        step_file.write_text("dummy")

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""
        mock_proc.stderr = ""

        with patch("subprocess.run", return_value=mock_proc) as mock_run:
            result = provider.execute(
                "wfm.cad_render",
                {
                    "input": "part.step",
                    "output_path": "preview.png",
                    "camera": "iso",
                },
                ctx,
            )

        assert result.ok is True
        assert result.data["image_path"] == "preview.png"
        cmd = mock_run.call_args[0][0]
        assert "--camera" in cmd
        assert "iso" in cmd

    def test_path_traversal_rejected(
        self, provider: CadToolProvider, ctx: SessionContext
    ):
        result = provider.execute(
            "wfm.cad_generate_step",
            {"source_path": "../../etc/passwd"},
            ctx,
        )
        assert result.ok is False
        assert "workspace" in result.error.lower() or "escapes" in result.error.lower()

    def test_subprocess_timeout(
        self, provider: CadToolProvider, ctx: SessionContext, tmp_path: Path
    ):
        src = tmp_path / "part.py"
        src.write_text("def gen_step(): pass")

        with patch(
            "subprocess.run", side_effect=subprocess.TimeoutExpired(cmd=[], timeout=120)
        ):
            result = provider.execute(
                "wfm.cad_generate_step",
                {"source_path": "part.py"},
                ctx,
            )

        assert result.ok is False
        assert "timed out" in result.error
