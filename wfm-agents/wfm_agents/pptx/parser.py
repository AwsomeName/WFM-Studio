from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.oxml.ns import qn

logger = logging.getLogger(__name__)

_MAX_SLIDES = 100
_MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB
_MAX_RUNS_PER_SLIDE = 20

_INHERITED = "(inherited)"


def parse_pptx(path: Path, *, max_slides: int = _MAX_SLIDES) -> dict[str, Any]:
    if path.stat().st_size > _MAX_FILE_SIZE:
        raise ValueError(f"文件过大 ({path.stat().st_size / 1024 / 1024:.1f} MB)，上限 {_MAX_FILE_SIZE // 1024 // 1024} MB")

    prs = Presentation(str(path))

    metadata = {
        "title": prs.core_properties.title or "",
        "author": prs.core_properties.author or "",
        "created": str(prs.core_properties.created) if prs.core_properties.created else "",
        "slide_count": len(prs.slides),
        "slide_width_pt": prs.slide_width / 914400,
        "slide_height_pt": prs.slide_height / 914400,
    }

    slides_data: list[dict[str, Any]] = []
    truncated = False
    total_shapes = 0
    total_runs = 0

    for idx, slide in enumerate(prs.slides):
        if idx >= max_slides:
            truncated = True
            break

        layout_name = slide.slide_layout.name if slide.slide_layout else ""

        shapes_data: list[dict[str, Any]] = []
        for shape in slide.shapes:
            shape_info = _parse_shape(shape, slide.slide_layout)
            if shape_info:
                shapes_data.append(shape_info)
                total_shapes += 1
                total_runs += sum(
                    len(p.get("runs", [])) for p in shape_info.get("paragraphs", [])
                )

        slides_data.append({
            "index": idx + 1,
            "layout": layout_name,
            "shapes": shapes_data,
        })

    return {
        "metadata": metadata,
        "slides": slides_data,
        "stats": {
            "slides_total": metadata["slide_count"],
            "slides_returned": len(slides_data),
            "truncated": truncated,
            "shapes_total": total_shapes,
            "runs_total": total_runs,
        },
    }


def _parse_shape(shape: Any, slide_layout: Any) -> dict[str, Any] | None:
    shape_type = _shape_type_name(shape)
    placeholder_type = _classify_placeholder(shape)

    shape_info: dict[str, Any] = {
        "shape_id": shape.shape_id,
        "shape_type": shape_type,
        "placeholder_type": placeholder_type,
        "name": shape.name,
        "paragraphs": [],
    }

    if shape.has_table:
        _parse_table_shape(shape, shape_info)
    elif shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        _parse_group_shape(shape, shape_info, slide_layout, depth=0)
    elif shape.has_text_frame:
        _parse_text_frame(shape.text_frame, shape_info, slide_layout)
    else:
        return None

    if not shape_info["paragraphs"]:
        return None

    return shape_info


def _parse_text_frame(text_frame: Any, shape_info: dict[str, Any], slide_layout: Any) -> None:
    for para in text_frame.paragraphs:
        runs_data: list[dict[str, Any]] = []
        for run in para.runs:
            if not run.text.strip():
                continue
            runs_data.append({
                "text": run.text,
                "font": _get_font_info(run, slide_layout),
            })
        if runs_data:
            shape_info["paragraphs"].append({
                "text": para.text,
                "runs": runs_data,
            })


def _parse_table_shape(shape: Any, shape_info: dict[str, Any]) -> None:
    layout = None
    try:
        layout = shape._element.getparent().getparent()  # noqa: SLF001
    except Exception:
        pass

    for row in shape.table.rows:
        for cell in row.cells:
            for para in cell.text_frame.paragraphs:
                runs_data: list[dict[str, Any]] = []
                for run in para.runs:
                    if not run.text.strip():
                        continue
                    runs_data.append({
                        "text": run.text,
                        "font": _get_font_info(run, layout),
                    })
                if runs_data:
                    shape_info["paragraphs"].append({
                        "text": para.text,
                        "runs": runs_data,
                    })


def _parse_group_shape(
    shape: Any,
    shape_info: dict[str, Any],
    slide_layout: Any,
    depth: int,
) -> None:
    if depth > 10:
        return
    for child in shape.shapes:
        if child.has_text_frame:
            _parse_text_frame(child.text_frame, shape_info, slide_layout)
        elif child.has_table:
            _parse_table_shape(child, shape_info)
        elif child.shape_type == MSO_SHAPE_TYPE.GROUP:
            _parse_group_shape(child, shape_info, slide_layout, depth + 1)


def _get_font_info(run: Any, slide_layout: Any) -> dict[str, Any]:
    rPr = run._r.get_or_add_rPr()  # noqa: SLF001

    latin_el = rPr.find(qn("a:latin"))
    latin = latin_el.get("typeface") if latin_el is not None else None

    ea_el = rPr.find(qn("a:ea"))
    ea = ea_el.get("typeface") if ea_el is not None else None

    cs_el = rPr.find(qn("a:cs"))
    cs = cs_el.get("typeface") if cs_el is not None else None

    if latin is None:
        latin = _get_theme_font(slide_layout, "latin") or _INHERITED
    if ea is None:
        ea = _get_theme_font(slide_layout, "ea") or _INHERITED
    if cs is None:
        cs = _get_theme_font(slide_layout, "cs") or _INHERITED

    size_pt = run.font.size.pt if run.font.size else None

    return {
        "latin": latin,
        "ea": ea,
        "cs": cs,
        "size_pt": size_pt if size_pt is not None else _INHERITED,
        "bold": run.font.bold,
        "italic": run.font.italic,
    }


def _get_theme_font(slide_layout: Any, script_type: str) -> str | None:
    if slide_layout is None:
        return None
    try:
        master_el = slide_layout.slide_master.element
        font_scheme = master_el.find(".//" + qn("a:fontScheme"))
        if font_scheme is None:
            return None
        minor = font_scheme.find(qn("a:minorFont"))
        if minor is None:
            return None
        tag_map = {"latin": qn("a:latin"), "ea": qn("a:ea"), "cs": qn("a:cs")}
        el = minor.find(tag_map[script_type])
        return el.get("typeface") if el is not None else None
    except Exception:
        return None


def _classify_placeholder(shape: Any) -> str | None:
    if not shape.is_placeholder:
        return None
    ph = shape.placeholder_format
    from pptx.enum.shapes import PP_PLACEHOLDER  # noqa: PLC0415

    mapping = {
        PP_PLACEHOLDER.TITLE: "title",
        PP_PLACEHOLDER.CENTER_TITLE: "title",
        PP_PLACEHOLDER.SUBTITLE: "subtitle",
        PP_PLACEHOLDER.BODY: "body",
        PP_PLACEHOLDER.OBJECT: "body",
    }
    return mapping.get(ph.type)


def _shape_type_name(shape: Any) -> str:
    if shape.is_placeholder:
        return "placeholder"
    if shape.has_table:
        return "table"
    if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        return "group"
    if shape.has_text_frame:
        return "textbox"
    return "other"


def format_pptx_content(content: dict[str, Any], *, max_slides_preview: int = 30) -> str:
    meta = content["metadata"]
    lines: list[str] = [
        f"# Presentation: {meta['title'] or '(untitled)'}",
        f"{meta['slide_count']} 张幻灯片, {meta['slide_width_pt']:.0f}×{meta['slide_height_pt']:.0f} pt",
        "",
    ]

    for slide in content["slides"]:
        if slide["index"] > max_slides_preview:
            remaining = content["stats"]["slides_total"] - max_slides_preview
            lines.append(f"\n... (剩余 {remaining} 张幻灯片已省略，共 {content['stats']['slides_total']} 张)")
            break

        lines.append("---")
        lines.append(f"## Slide {slide['index']} (Layout: {slide['layout']})")
        lines.append("")

        for shape in slide["shapes"]:
            ph = shape["placeholder_type"]
            ph_tag = f" [placeholder: {ph}]" if ph else ""
            shape_name = shape["name"]
            shape_type = shape["shape_type"]
            lines.append(f'### Shape: "{shape_name}" [{shape_type}]{ph_tag}')

            run_count = 0
            for para in shape["paragraphs"]:
                for run in para["runs"]:
                    if run_count >= _MAX_RUNS_PER_SLIDE:
                        break
                    font = run["font"]
                    attrs = []
                    if font.get("latin"):
                        attrs.append(f"Latin: {font['latin']}")
                    if font.get("ea") and font["ea"] != _INHERITED:
                        attrs.append(f"CJK: {font['ea']}")
                    elif font.get("ea"):
                        attrs.append(f"CJK: {font['ea']}")
                    size = font.get("size_pt")
                    size_str = f"{size:.0f}pt" if isinstance(size, (int, float)) else str(size)
                    attrs.append(size_str)
                    if font.get("bold"):
                        attrs.append("bold")
                    if font.get("italic"):
                        attrs.append("italic")
                    run_text = run["text"]
                    attrs_str = ", ".join(attrs)
                    lines.append(f'Run: "{run_text}" — {attrs_str}')
                    run_count += 1
                if run_count >= _MAX_RUNS_PER_SLIDE:
                    break

            if run_count >= _MAX_RUNS_PER_SLIDE:
                total_in_shape = sum(len(p.get("runs", [])) for p in shape["paragraphs"])
                if total_in_shape > _MAX_RUNS_PER_SLIDE:
                    lines.append(f"... (剩余 {total_in_shape - _MAX_RUNS_PER_SLIDE} 个 run 已省略)")

            lines.append("")

    return "\n".join(lines)


def summarize_fonts(content: dict[str, Any]) -> dict[str, Any]:
    fonts: dict[str, dict[str, int]] = {"latin": {}, "ea": {}, "cs": {}}
    sizes: set[float] = set()
    total_runs = 0

    for slide in content["slides"]:
        for shape in slide["shapes"]:
            for para in shape["paragraphs"]:
                for run in para["runs"]:
                    total_runs += 1
                    font = run["font"]
                    for script in ("latin", "ea", "cs"):
                        name = font.get(script)
                        if name and name != _INHERITED:
                            fonts[script][name] = fonts[script].get(name, 0) + 1
                    size = font.get("size_pt")
                    if isinstance(size, (int, float)):
                        sizes.add(size)

    return {
        "fonts": fonts,
        "sizes": {
            "unique": sorted(sizes),
            "min": min(sizes) if sizes else None,
            "max": max(sizes) if sizes else None,
        },
        "total_runs": total_runs,
    }
