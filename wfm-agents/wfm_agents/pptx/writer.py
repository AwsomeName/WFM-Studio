from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from lxml import etree
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.oxml.ns import qn
from pptx.util import Pt

_MAX_GROUP_DEPTH = 10

_VALID_SCOPES = {"title", "body", "subtitle", "textbox", "all"}


def apply_font_rules(
    path: Path,
    font_rules: list[dict[str, Any]],
    output_path: Path | None = None,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    prs = Presentation(str(path))

    if dry_run:
        return _dry_run(prs, font_rules)

    _apply_rules_to_presentation(prs, font_rules)

    dst = output_path or path
    if dst == path:
        tmp = Path(tempfile.mktemp(suffix=".pptx", dir=path.parent))
        prs.save(str(tmp))
        shutil.move(str(tmp), str(path))
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        prs.save(str(dst))

    return _count_stats(prs, font_rules)


def _apply_rules_to_presentation(prs: Presentation, font_rules: list[dict[str, Any]]) -> None:
    for idx, slide in enumerate(prs.slides):
        for shape in slide.shapes:
            _process_shape(shape, font_rules, idx + 1, slide.slide_layout)


def _process_shape(
    shape: Any,
    font_rules: list[dict[str, Any]],
    slide_index: int,
    slide_layout: Any,
) -> None:
    placeholder_type = _classify_placeholder(shape)
    is_table = shape.has_table
    is_group = shape.shape_type == MSO_SHAPE_TYPE.GROUP

    if is_table:
        for row in shape.table.rows:
            for cell in row.cells:
                for para in cell.text_frame.paragraphs:
                    for run in para.runs:
                        if not run.text.strip():
                            continue
                        for rule in font_rules:
                            if _rule_matches(rule, slide_index, placeholder_type, is_table=True, is_group=False):
                                _apply_rule_to_run(run, rule)
                                break
    elif is_group:
        _process_group(shape.shapes, font_rules, slide_index, slide_layout, depth=0)
    elif shape.has_text_frame:
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                if not run.text.strip():
                    continue
                for rule in font_rules:
                    if _rule_matches(rule, slide_index, placeholder_type, is_table=False, is_group=False):
                        _apply_rule_to_run(run, rule)
                        break


def _process_group(
    shapes: Any,
    font_rules: list[dict[str, Any]],
    slide_index: int,
    slide_layout: Any,
    depth: int,
) -> None:
    if depth > _MAX_GROUP_DEPTH:
        return
    for shape in shapes:
        _process_shape(shape, font_rules, slide_index, slide_layout)


def _rule_matches(
    rule: dict[str, Any],
    slide_index: int,
    placeholder_type: str | None,
    *,
    is_table: bool,
    is_group: bool,
) -> bool:
    scope = rule.get("scope", "all")
    if scope not in _VALID_SCOPES:
        return False

    if not _in_slide_range(slide_index, rule):
        return False

    if scope == "all":
        pass
    elif scope == "textbox":
        if placeholder_type is not None:
            return False
    else:
        if placeholder_type != scope:
            return False

    include_tables = rule.get("include_tables", False)
    if is_table and not include_tables and scope != "all":
        return False

    return True


def _in_slide_range(slide_index: int, rule: dict[str, Any]) -> bool:
    sr = rule.get("slide_range")
    if sr is None:
        return True
    lo, hi = sr[0], sr[1]
    if lo is not None and slide_index < lo:
        return False
    if hi is not None and slide_index > hi:
        return False
    return True


def _apply_rule_to_run(run: Any, rule: dict[str, Any]) -> bool:
    rPr = run._r.get_or_add_rPr()  # noqa: SLF001
    modified = False

    if rule.get("latin"):
        modified |= _set_font_element(rPr, qn("a:latin"), rule["latin"])

    if rule.get("ea"):
        modified |= _set_font_element(rPr, qn("a:ea"), rule["ea"])

    if rule.get("cs"):
        modified |= _set_font_element(rPr, qn("a:cs"), rule["cs"])

    if rule.get("size_pt") is not None:
        new_size = Pt(rule["size_pt"])
        if run.font.size != new_size:
            run.font.size = new_size
            modified = True

    if rule.get("bold") is not None and run.font.bold != rule["bold"]:
        run.font.bold = rule["bold"]
        modified = True

    if rule.get("italic") is not None and run.font.italic != rule["italic"]:
        run.font.italic = rule["italic"]
        modified = True

    return modified


def _set_font_element(rPr: Any, tag: str, typeface: str) -> bool:
    el = rPr.find(tag)
    if el is not None:
        if el.get("typeface") != typeface:
            el.set("typeface", typeface)
            return True
    else:
        el = etree.SubElement(rPr, tag)
        el.set("typeface", typeface)
        return True
    return False


def _classify_placeholder(shape: Any) -> str | None:
    if not shape.is_placeholder:
        return None
    from pptx.enum.shapes import PP_PLACEHOLDER  # noqa: PLC0415

    mapping = {
        PP_PLACEHOLDER.TITLE: "title",
        PP_PLACEHOLDER.CENTER_TITLE: "title",
        PP_PLACEHOLDER.SUBTITLE: "subtitle",
        PP_PLACEHOLDER.BODY: "body",
        PP_PLACEHOLDER.OBJECT: "body",
    }
    return mapping.get(shape.placeholder_format.type)


def _dry_run(
    prs: Presentation,
    font_rules: list[dict[str, Any]],
) -> dict[str, Any]:
    changes: list[dict[str, str]] = []

    for idx, slide in enumerate(prs.slides):
        slide_index = idx + 1
        for shape in slide.shapes:
            _dry_run_shape(shape, font_rules, slide_index, changes)

    return {
        "would_modify": changes,
        "total_changes": len(changes),
    }


def _dry_run_shape(
    shape: Any,
    font_rules: list[dict[str, Any]],
    slide_index: int,
    changes: list[dict[str, str]],
) -> None:
    placeholder_type = _classify_placeholder(shape)

    runs: list[Any] = []
    if shape.has_table:
        for row in shape.table.rows:
            for cell in row.cells:
                for para in cell.text_frame.paragraphs:
                    runs.extend(para.runs)
    elif shape.has_text_frame:
        for para in shape.text_frame.paragraphs:
            runs.extend(para.runs)
    elif shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        _dry_run_group(shape.shapes, font_rules, slide_index, changes)
        return

    for run in runs:
        if not run.text.strip():
            continue
        for rule in font_rules:
            is_table = shape.has_table
            if _rule_matches(rule, slide_index, placeholder_type, is_table=is_table, is_group=False):
                _collect_changes(run, rule, slide_index, shape.name, changes)
                break


def _dry_run_group(
    shapes: Any,
    font_rules: list[dict[str, Any]],
    slide_index: int,
    changes: list[dict[str, str]],
    depth: int = 0,
) -> None:
    if depth > _MAX_GROUP_DEPTH:
        return
    for shape in shapes:
        _dry_run_shape(shape, font_rules, slide_index, changes)


def _collect_changes(
    run: Any,
    rule: dict[str, Any],
    slide_index: int,
    shape_name: str,
    changes: list[dict[str, str]],
) -> None:
    rPr = run._r.get_or_add_rPr()  # noqa: SLF001

    for field, tag in [("latin", qn("a:latin")), ("ea", qn("a:ea")), ("cs", qn("a:cs"))]:
        if rule.get(field):
            el = rPr.find(tag)
            old = el.get("typeface") if el is not None else "(inherited)"
            if old != rule[field]:
                changes.append({
                    "slide": str(slide_index),
                    "shape": shape_name,
                    "field": field,
                    "old": old,
                    "new": rule[field],
                })

    if rule.get("size_pt") is not None:
        old_size = run.font.size
        old_str = f"{old_size.pt:.1f}" if old_size else "(inherited)"
        new_str = f"{rule['size_pt']:.1f}"
        if old_str != new_str:
            changes.append({
                "slide": str(slide_index),
                "shape": shape_name,
                "field": "size_pt",
                "old": old_str,
                "new": new_str,
            })

    if rule.get("bold") is not None and run.font.bold != rule["bold"]:
        changes.append({
            "slide": str(slide_index),
            "shape": shape_name,
            "field": "bold",
            "old": str(run.font.bold),
            "new": str(rule["bold"]),
        })

    if rule.get("italic") is not None and run.font.italic != rule["italic"]:
        changes.append({
            "slide": str(slide_index),
            "shape": shape_name,
            "field": "italic",
            "old": str(run.font.italic),
            "new": str(rule["italic"]),
        })


def _count_stats(
    prs: Presentation,
    font_rules: list[dict[str, Any]],
) -> dict[str, Any]:
    slides = 0
    shapes_affected = 0
    runs_modified = 0

    for idx, slide in enumerate(prs.slides):
        slide_index = idx + 1
        slide_touched = False
        for shape in slide.shapes:
            shape_touched = False
            run_count = 0

            runs: list[Any] = []
            if shape.has_table:
                for row in shape.table.rows:
                    for cell in row.cells:
                        for para in cell.text_frame.paragraphs:
                            runs.extend(para.runs)
            elif shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    runs.extend(para.runs)

            for run in runs:
                if not run.text.strip():
                    continue
                for rule in font_rules:
                    is_table = shape.has_table
                    ph = _classify_placeholder(shape)
                    if _rule_matches(rule, slide_index, ph, is_table=is_table, is_group=False):
                        run_count += 1
                        break

            if run_count > 0:
                shape_touched = True
                runs_modified += run_count

            if shape_touched:
                shapes_affected += 1
                slide_touched = True

        if slide_touched:
            slides += 1

    return {
        "slides": slides,
        "shapes_affected": shapes_affected,
        "runs_modified": runs_modified,
    }
