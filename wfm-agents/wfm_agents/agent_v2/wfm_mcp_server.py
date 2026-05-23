"""WFM Tools MCP Server — stdio transport for Claude Code CLI.

Exposes all WFM workspace, CAD, and DOCX tools as MCP tools so that
Claude Code can call them directly.  Started automatically by the
``claude`` CLI based on the ``--mcp-config`` JSON; workspace_root is
injected via the ``WFM_WORKSPACE_ROOT`` environment variable.

Usage (by Claude Code, not manually)::

    python -m wfm_agents.agent_v2.wfm_mcp_server
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from os import getenv
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("wfm-tools")


# ── Helpers ──────────────────────────────────────────────────────────


def _root() -> str:
    return os.environ["WFM_WORKSPACE_ROOT"]


def _resolve_path(path: str) -> str:
    p = Path(path)
    if p.is_absolute():
        if not p.is_file():
            raise FileNotFoundError(f"文件不存在: {path}")
        return str(p)
    from ..workspace import resolve_within  # noqa: PLC0415

    return str(resolve_within(_root(), path))


def _cad_skill_dir() -> Path:
    d = Path(getenv("WFM_CAD_SKILL_DIR", ""))
    if d.name:
        return d
    pkg_root = Path(__file__).resolve().parents[2]
    return pkg_root.parent / "third_party" / "text-to-cad" / "skills" / "cad"


def _python_bin() -> str:
    return getenv("WFM_CAD_PYTHON", "") or sys.executable


def _run_cad_subprocess(cmd: list[str], cwd: str, *, timeout: int = 120) -> str:
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return f"Error: Command timed out after {timeout}s"
    except FileNotFoundError as exc:
        return f"Error: Command not found: {exc}"
    if proc.returncode != 0:
        return f"Error: {proc.stderr.strip() or f'Exit code {proc.returncode}'}"
    return proc.stdout.strip() or "OK"


# ── Workspace tools ─────────────────────────────────────────────────


@mcp.tool()
def workspace_read(path: str) -> str:
    """Read a UTF-8 text file inside the workspace."""
    from ..fs_ops import read_text  # noqa: PLC0415

    try:
        return read_text(_root(), path)
    except Exception as exc:
        return f"Error: {exc}"


@mcp.tool()
def workspace_write(path: str, content: str, overwrite: bool = True) -> str:
    """Write a UTF-8 text file inside the workspace."""
    from ..fs_ops import write_text  # noqa: PLC0415

    try:
        result = write_text(_root(), path, content, overwrite=overwrite)
        return f"Written {result.bytes_written} bytes to {result.written_path}"
    except Exception as exc:
        return f"Error: {exc}"


# ── CAD review tools ────────────────────────────────────────────────


@mcp.tool()
def cad_file_read(path: str) -> str:
    """Read and parse a CAD file (DXF/DWG), returning structured overview
    with layers, entity counts, title block fields, and text/dim styles."""
    try:
        resolved = _resolve_path(path)
        from ..cad.parser import summarize_dxf_overview  # noqa: PLC0415

        return json.dumps(summarize_dxf_overview(resolved), ensure_ascii=False)
    except Exception as exc:
        return f"Error: {exc}"


@mcp.tool()
def cad_extract_texts(path: str, layer: str | None = None) -> str:
    """Extract text entities (TEXT + MTEXT) from a CAD file.
    Returns a compact summary.  For the full list use to_file to write
    results to a JSON file and read it with workspace_read."""
    try:
        resolved = _resolve_path(path)
        from ..cad.parser import summarize_dxf_texts  # noqa: PLC0415

        result = summarize_dxf_texts(resolved, layer=layer)
        count = result.get("count", 0)
        texts = result.get("texts", [])
        preview = texts[:10]
        return json.dumps(
            {
                "file": result.get("file"),
                "count": count,
                "preview": preview,
                "hint": f"{count} text entities found. First 10 shown."
                f" Use to_file='path.json' to export all." if count > 10 else "",
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        return f"Error: {exc}"


@mcp.tool()
def cad_translate_save(
    source_path: str,
    target_lang: str,
    translations: dict[str, str],
    output_path: str,
) -> str:
    """Translate texts in a DXF file and save as a new file.

    Args:
        source_path: Input DXF file path (workspace-relative or absolute).
        target_lang: Target language name (e.g. "Russian", "俄语").
        translations: Map of original text -> translated text.
        output_path: Where to save the translated DXF (workspace-relative).
    """
    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415

    root = _root()
    try:
        src = Path(_resolve_path(source_path))
        dst = resolve_within(root, output_path)
    except (WorkspaceViolation, FileNotFoundError) as exc:
        return f"Error: {exc}"

    if src.suffix.lower() != ".dxf":
        return f"Error: 仅支持 DXF 文件，收到 {src.suffix}"

    try:
        import ezdxf  # noqa: PLC0415

        doc = ezdxf.readfile(str(src))
    except Exception as exc:
        return f"Error: DXF 文件读取失败: {exc}"

    translated = 0
    missed: list[str] = []

    for entity in doc.modelspace():
        if entity.dxftype() not in {"TEXT", "MTEXT"}:
            continue
        old = ""
        if entity.dxftype() == "MTEXT":
            old = (entity.text or "").strip()
        else:
            old = (entity.dxf.text or "").strip()
        if not old:
            continue
        new = translations.get(old)
        if new is None:
            missed.append(old[:80])
            continue
        if entity.dxftype() == "MTEXT":
            entity.text = new
        else:
            entity.dxf.text = new
        translated += 1

    dst.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(str(dst))

    rel = dst.relative_to(root) if dst.is_relative_to(root) else str(dst)
    msg = f"翻译完成: {translated} 条文本已替换为{target_lang}，保存到 {rel}"
    if missed:
        msg += f"\n警告: {len(missed)} 条文本未在 translations 中找到匹配"
    return msg


@mcp.tool()
def cad_extract_dims(path: str, layer: str | None = None) -> str:
    """Extract dimension entities (DIMENSION) from a CAD file."""
    try:
        resolved = _resolve_path(path)
        from ..cad.parser import summarize_dxf_dims  # noqa: PLC0415

        return json.dumps(summarize_dxf_dims(resolved, layer=layer), ensure_ascii=False)
    except Exception as exc:
        return f"Error: {exc}"


@mcp.tool()
def cad_extract_blocks(path: str) -> str:
    """Extract block definitions (BLOCK) from a CAD file."""
    try:
        resolved = _resolve_path(path)
        from ..cad.parser import summarize_dxf_blocks  # noqa: PLC0415

        return json.dumps(summarize_dxf_blocks(resolved), ensure_ascii=False)
    except Exception as exc:
        return f"Error: {exc}"


@mcp.tool()
def cad_layer_inspect(path: str, layer: str) -> str:
    """Inspect a specific layer: entity types, coordinates, texts, dimensions."""
    try:
        resolved = _resolve_path(path)
        from ..cad.parser import summarize_dxf_layer  # noqa: PLC0415

        return json.dumps(summarize_dxf_layer(resolved, layer), ensure_ascii=False)
    except Exception as exc:
        return f"Error: {exc}"


@mcp.tool()
def cad_check_naming(path: str, rule_set: str = "default") -> str:
    """Check layer/block naming conventions."""
    try:
        resolved = _resolve_path(path)
        from ..cad.checks import check_naming  # noqa: PLC0415

        return json.dumps(check_naming(resolved, rule_set=rule_set), ensure_ascii=False)
    except Exception as exc:
        return f"Error: {exc}"


@mcp.tool()
def cad_check_titleblock(path: str) -> str:
    """Check title block field completeness and format."""
    try:
        resolved = _resolve_path(path)
        from ..cad.checks import check_titleblock  # noqa: PLC0415

        return json.dumps(check_titleblock(resolved), ensure_ascii=False)
    except Exception as exc:
        return f"Error: {exc}"


@mcp.tool()
def cad_check_dim_accuracy(path: str, tolerance: float = 0.01) -> str:
    """Check dimension accuracy by comparing measured vs text override values."""
    try:
        resolved = _resolve_path(path)
        from ..cad.checks import check_dim_accuracy  # noqa: PLC0415

        return json.dumps(check_dim_accuracy(resolved, tolerance=tolerance), ensure_ascii=False)
    except Exception as exc:
        return f"Error: {exc}"


@mcp.tool()
def cad_modify_colors(path: str, modifications: list[dict]) -> str:
    """Modify entity colors in a CAD file. Each modification has:
    handle (entity handle), property ('color'), value (color index 0-256)."""
    try:
        resolved = _resolve_path(path)
        import ezdxf  # noqa: PLC0415

        doc = ezdxf.readfile(resolved)
        msp = doc.modelspace()
        changed = []
        for mod in modifications:
            handle = mod.get("handle", "")
            value = mod.get("value", 0)
            for entity in msp:
                if entity.dxf.handle == handle:
                    entity.dxf.color = value
                    changed.append(mod)
                    break
        doc.saveas(resolved)
        return json.dumps({"modified": len(changed), "modifications": changed}, ensure_ascii=False)
    except Exception as exc:
        return f"Error: {exc}"


# ── CAD generation tools ────────────────────────────────────────────


@mcp.tool()
def cad_generate_step(
    source_path: str,
    output_path: str | None = None,
    kind: str | None = None,
    stl_path: str | None = None,
) -> str:
    """Compile a build123d Python source into a STEP model file."""
    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415

    root = _root()
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
    return _run_cad_subprocess(cmd, root)


@mcp.tool()
def cad_inspect(
    target: str,
    facts: bool = True,
    planes: bool = True,
    positioning: bool = False,
) -> str:
    """Inspect STEP geometry for facts, planes, and positioning."""
    cmd = [
        _python_bin(),
        str(_cad_skill_dir() / "scripts" / "inspect"),
        "refs", target, "--format", "json",
    ]
    if facts:
        cmd.append("--facts")
    if planes:
        cmd.append("--planes")
    if positioning:
        cmd.append("--positioning")

    raw = _run_cad_subprocess(cmd, _root(), timeout=30)
    try:
        return json.dumps(json.loads(raw), ensure_ascii=False)
    except (json.JSONDecodeError, TypeError):
        return raw


@mcp.tool()
def cad_render(
    input_path: str,
    output_path: str,
    camera: str = "iso",
    width: int = 1400,
    height: int = 900,
) -> str:
    """Render a STEP model to PNG image."""
    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415

    root = _root()
    try:
        src = resolve_within(root, input_path)
        dst = resolve_within(root, output_path)
    except WorkspaceViolation as exc:
        return f"Error: {exc}"

    cmd = [
        _python_bin(), str(_cad_skill_dir() / "scripts" / "render"),
        "view", str(src), "--camera", camera,
        "--width", str(width), "--height", str(height), "-o", str(dst),
    ]
    result = _run_cad_subprocess(cmd, root, timeout=120)
    if result.startswith("Error:"):
        return result
    return f"Rendered to {output_path}"


@mcp.tool()
def cad_export_dxf(source_path: str, output_path: str | None = None) -> str:
    """Export DXF from a Python source defining gen_dxf()."""
    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415

    root = _root()
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


@mcp.tool()
def cad_plate_to_step(
    source_path: str,
    output_path: str | None = None,
    thickness_mm: float | None = None,
    also_stl: bool = False,
    also_glb: bool = False,
    layer_whitelist: list[str] | None = None,
) -> str:
    """Convert a steel-plate fabrication drawing (单视图钢板下料图) to a 3D STEP file.

    The 2D outline is extruded along Z by the detected (or supplied) plate
    thickness, producing a watertight solid suitable for downstream CAD/CAE
    workflows.

    Args:
        source_path: Input ``.dwg`` or ``.dxf`` (workspace-relative or absolute).
        output_path: Output ``.step`` path (workspace-relative). Defaults to
            ``<source>.step`` next to the input.
        thickness_mm: Override the plate thickness in mm. When ``None`` the
            extractor reads it from title-block ATTRIB ("材料名称: 30钢板…")
            or text tokens like ``t30`` / ``δ20`` / ``厚 25``.
        also_stl: If True, also write a ``.stl`` mesh next to the STEP file.
        also_glb: If True, also write a ``.glb`` for web preview.
        layer_whitelist: Optional explicit list of DXF layers to use as
            geometry source. Skips the default layer blacklist heuristics.

    Returns:
        JSON: ``{outputs, thickness_mm, thickness_source, outer_bbox_mm,
        holes, volume_mm3, mass_g_steel, warnings, layers_used, layers_ignored}``.
        On failure returns ``Error: <reason>`` (e.g. drawing is a logo, no
        closed outline, thickness unknown).
    """
    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415
    from ..cad.plate_to_3d import (  # noqa: PLC0415
        NotAPlateError, PlateToCadError, plate_to_step,
    )

    root = _root()

    p = Path(source_path)
    if p.is_absolute():
        src = p
    else:
        try:
            src = resolve_within(root, source_path)
        except WorkspaceViolation as exc:
            return f"Error: {exc}"
    if not src.is_file():
        return f"Error: 文件不存在: {source_path}"
    if src.suffix.lower() not in (".dwg", ".dxf"):
        return f"Error: 仅支持 .dwg / .dxf 输入，收到 {src.suffix}"

    if output_path:
        out_p = Path(output_path)
        if out_p.is_absolute():
            dst_step = out_p
        else:
            try:
                dst_step = resolve_within(root, output_path)
            except WorkspaceViolation as exc:
                return f"Error: {exc}"
    else:
        dst_step = src.with_suffix(".step")

    dst_stl = dst_step.with_suffix(".stl") if also_stl else None
    dst_glb = dst_step.with_suffix(".glb") if also_glb else None

    try:
        result = plate_to_step(
            src, dst_step,
            thickness_mm=thickness_mm,
            also_stl=dst_stl,
            also_glb=dst_glb,
            layer_whitelist=layer_whitelist,
        )
    except NotAPlateError as exc:
        return f"Error: 不是有效的钢板零件图: {exc}"
    except PlateToCadError as exc:
        return f"Error: {exc}"
    except Exception as exc:
        return f"Error: {type(exc).__name__}: {exc}"

    # 路径转 workspace 相对（便于前端展示）
    def _rel(p_str: str) -> str:
        pp = Path(p_str)
        try:
            return str(pp.relative_to(root))
        except ValueError:
            return str(pp)

    e = result.extract
    return json.dumps({
        "outputs": {k: _rel(v) for k, v in result.outputs.items()},
        "thickness_mm": e.thickness_mm,
        "thickness_source": e.thickness_source,
        "outer_bbox_mm": list(e.outer_bbox_mm),
        "outer_area_mm2": round(e.outer_area_mm2, 1),
        "holes": e.holes,
        "volume_mm3": round(result.volume_mm3, 1),
        "mass_kg_steel": round(result.mass_g_steel / 1000.0, 3),
        "layers_used": e.layers_considered,
        "layers_ignored": e.layers_ignored,
        "blocks_ignored": e.blocks_ignored,
        "warnings": e.warnings,
    }, ensure_ascii=False)


@mcp.tool()
def cad_plate_inspect(source_path: str) -> str:
    """Dry-run the 2D-to-3D plate analysis: report detected outline, holes,
    thickness, layers used, and any warnings — without writing a STEP file.

    Useful to diagnose drawings that fail :func:`cad_plate_to_step` (e.g.
    thickness not auto-detectable, or shape under-segmented by 破断线).
    """
    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415
    from ..cad.plate_to_3d import (  # noqa: PLC0415
        NotAPlateError, PlateToCadError, extract_plate_geometry,
    )
    from ..cad.dwg import resolve_cad_file, ToolError  # noqa: PLC0415

    root = _root()
    p = Path(source_path)
    if p.is_absolute():
        src = p
    else:
        try:
            src = resolve_within(root, source_path)
        except WorkspaceViolation as exc:
            return f"Error: {exc}"
    if not src.is_file():
        return f"Error: 文件不存在: {source_path}"

    try:
        dxf_path = resolve_cad_file(src)
    except ToolError as exc:
        return f"Error: {exc}"

    try:
        _outer, _holes, ext = extract_plate_geometry(dxf_path)
    except NotAPlateError as exc:
        return json.dumps({
            "is_plate": False,
            "reason": str(exc),
        }, ensure_ascii=False)
    except PlateToCadError as exc:
        return f"Error: {exc}"

    return json.dumps({
        "is_plate": True,
        "thickness_mm": ext.thickness_mm,
        "thickness_source": ext.thickness_source,
        "outer_bbox_mm": list(ext.outer_bbox_mm),
        "outer_area_mm2": round(ext.outer_area_mm2, 1),
        "outer_loop_points": ext.outer_loop_points,
        "holes": ext.holes,
        "layers_used": ext.layers_considered,
        "layers_ignored": ext.layers_ignored,
        "blocks_ignored": ext.blocks_ignored,
        "raw_entity_counts": ext.raw_entity_counts,
        "warnings": ext.warnings,
    }, ensure_ascii=False)


@mcp.tool()
def cad_convert_format(source_path: str, output_path: str | None = None) -> str:
    """Convert DWG to DXF format."""
    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415
    from ..cad.dwg import ToolError, resolve_cad_file  # noqa: PLC0415

    root = _root()
    p = Path(source_path)
    if p.is_absolute():
        src = p
    else:
        try:
            src = resolve_within(root, source_path)
        except WorkspaceViolation as exc:
            return f"Error: {exc}"

    if not src.is_file():
        return f"Error: 文件不存在: {source_path}"
    if src.suffix.lower() not in (".dwg", ".dxf"):
        return f"Error: 不支持的格式: {src.suffix}"
    if src.suffix.lower() == ".dxf":
        return f"文件已经是 DXF 格式: {source_path}"

    try:
        converted = resolve_cad_file(src)
    except (ToolError, Exception) as exc:
        return f"Error: {exc}"

    if output_path:
        dst = Path(output_path)
        if not dst.is_absolute():
            try:
                dst = resolve_within(root, output_path)
            except WorkspaceViolation as exc:
                return f"Error: {exc}"
    else:
        dst = src.with_suffix(".dxf")

    try:
        shutil.move(str(converted), str(dst))
    except OSError as exc:
        return f"Error: 保存失败: {exc}"

    rel = dst.relative_to(root) if dst.is_relative_to(root) else str(dst)
    return f"转换完成: {rel}"


# ── DOCX tools ──────────────────────────────────────────────────────


@mcp.tool()
def docx_read(path: str, extract_tables_only: bool = False) -> str:
    """Read and parse a .docx file, returning formatted Markdown content."""
    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415
    from ..docx import parse_docx, format_docx_content  # noqa: PLC0415

    root = _root()
    try:
        target = resolve_within(root, path)
    except WorkspaceViolation as exc:
        return f"Error: {exc}"

    if not target.is_file():
        return f"Error: 文件不存在: {path}"
    if target.suffix.lower() != ".docx":
        return f"Error: 仅支持 .docx 文件: {path}"

    try:
        content = parse_docx(target)
    except Exception as exc:
        return f"Error: 文档解析失败: {exc}"

    if extract_tables_only:
        content = {
            "metadata": content["metadata"],
            "paragraphs": [],
            "tables": [{**t, "caption": None} for t in content["tables"]],
            "stats": content["stats"],
        }
    return format_docx_content(content)


@mcp.tool()
def docx_write(
    path: str,
    content: str,
    template_path: str | None = None,
    variables: str | None = None,
) -> str:
    """Create or overwrite a .docx file from Markdown content.

    Optionally inherits styles, headers, footers, and page setup from a
    template .docx file.  Use ``variables`` (JSON) to replace
    ``{{placeholder}}`` tokens in the template's headers and footers.

    Markdown subset supported:
      - Headings: # H1 through ###### H6
      - Paragraphs: plain text
      - Tables: | col | col | with |---|---| separator
      - Bullet lists: - item or * item
      - Numbered lists: 1. item
      - Inline: **bold**, *italic*

    Args:
        path: Output .docx path (workspace-relative).
        content: Markdown body content.
        template_path: Optional template .docx to inherit styles (workspace-relative).
        variables: Optional JSON ``{"key": "value"}`` for ``{{key}}`` replacement
            in template headers/footers.
    """
    import json  # noqa: PLC0415

    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415
    from ..docx.writer import write_docx_from_markdown  # noqa: PLC0415

    root = _root()
    try:
        dst = resolve_within(root, path)
    except WorkspaceViolation as exc:
        return f"Error: {exc}"

    if dst.suffix.lower() != ".docx":
        return f"Error: 仅支持 .docx 文件: {path}"

    tpl_path = None
    if template_path:
        try:
            tpl_path = resolve_within(root, template_path)
        except WorkspaceViolation as exc:
            return f"Error: {exc}"
        if not tpl_path.is_file():
            return f"Error: 模板文件不存在: {template_path}"

    variables_dict: dict[str, str] | None = None
    if variables:
        try:
            variables_dict = json.loads(variables)
        except json.JSONDecodeError as exc:
            return f"Error: variables JSON 解析失败: {exc}"
        if not isinstance(variables_dict, dict):
            return "Error: variables 必须是 JSON 对象 (字典)"

    try:
        return write_docx_from_markdown(dst, content, tpl_path, variables_dict)
    except Exception as exc:
        return f"Error: 文档生成失败: {exc}"


if __name__ == "__main__":
    mcp.run()
