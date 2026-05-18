"""Parse .docx files into structured dicts using python-docx."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml.ns import qn


_MAX_PARAGRAPHS = 500
_MAX_TABLES = 50
_MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

# Amount patterns: 5,000.00 / ￥1,200 / 3.14 / 3.45万元
_AMOUNT_RE = re.compile(
    r"[￥¥]?\s*[\d,]+(?:\.\d{1,2})?\s*(?:万?元|万?RMB)?",
    re.IGNORECASE,
)


# ── Merged-cell expansion ──────────────────────────────────────────────


def _expand_merged_cells(table: Any) -> list[list[str]]:
    """Expand gridSpan / vMerge into a uniform row × col matrix."""
    grid: list[list[list[str]]] = []
    row_span_map: dict[tuple[int, int], int] = {}  # (r,c) → remaining vSpan

    for ri, row in enumerate(table.rows):
        cells: list[list[str]] = []
        ci = 0
        for cell in row.cells:
            # Account for vertical spans from rows above.
            while (ri, ci) in row_span_map:
                span_val = row_span_map.pop((ri, ci))
                cell_text = grid[ri - 1][ci][0] if ri > 0 else ""
                cells.append([cell_text] * 1)
                if span_val > 1:
                    row_span_map[(ri + 1, ci)] = span_val - 1
                ci += 1

            text = cell.text.strip()
            tc = cell._tc  # noqa: SLF001
            grid_col = tc.get(qn("w:gridSpan"))
            col_span = int(grid_col) if grid_col is not None else 1

            v_merge = tc.get(qn("w:vMerge"))
            is_continue = v_merge is not None and v_merge != "restart"

            if is_continue:
                # Pull text from the row that started the merge.
                parent_text = ""
                for pr in range(ri - 1, -1, -1):
                    if ci < len(grid[pr]) and grid[pr][ci]:
                        parent_text = grid[pr][ci][0]
                        break
                cells.append([parent_text] * col_span)
            else:
                cells.append([text] * col_span)
                v_span_attr = tc.get(qn("w:rowSpan"))
                v_span = int(v_span_attr) if v_span_attr is not None else 1
                if v_span > 1:
                    for dr in range(1, v_span):
                        row_span_map[(ri + dr, ci)] = v_span - dr

            ci += col_span
        grid.append(cells)

    # Flatten inner lists → plain strings per cell.
    result: list[list[str]] = []
    for row_cells in grid:
        flat: list[str] = []
        for entry in row_cells:
            if isinstance(entry, list):
                flat.extend(entry)
            else:
                flat.append(entry)
        result.append(flat)
    return result


# ── Public API ─────────────────────────────────────────────────────────


def parse_docx(
    path: Path,
    *,
    max_paragraphs: int = _MAX_PARAGRAPHS,
    max_tables: int = _MAX_TABLES,
) -> dict[str, Any]:
    """Parse a .docx file into a structured dict.

    Returns:
        {
            "metadata": {"title": str, "author": str, "created": str},
            "paragraphs": [{"index": int, "style": str, "text": str}],
            "tables": [{
                "index": int, "caption": str | None,
                "headers": [str], "rows": [[str]],
                "row_count": int, "col_count": int,
            }],
            "stats": {
                "paragraphs_total": int, "tables_total": int,
                "paragraphs_kept": int, "tables_kept": int,
            },
        }
    """
    if path.stat().st_size > _MAX_FILE_SIZE:
        raise ValueError(
            f"文件过大: {path.stat().st_size / 1024 / 1024:.1f} MB (上限 10 MB)"
        )

    doc = Document(str(path))

    # Metadata
    props = doc.core_properties
    metadata = {
        "title": props.title or "",
        "author": props.author or "",
        "created": props.created.isoformat() if props.created else "",
    }

    # Paragraphs
    all_paragraphs = [
        {"index": i, "style": p.style.name if p.style else "", "text": p.text}
        for i, p in enumerate(doc.paragraphs)
        if p.text.strip()
    ]
    paragraphs = all_paragraphs[:max_paragraphs]

    # Build a lookup: paragraph index → text (for table captions)
    para_texts = {i: p.text for i, p in enumerate(doc.paragraphs)}

    # Tables
    all_tables_raw = []
    for ti, table in enumerate(doc.tables):
        matrix = _expand_merged_cells(table)
        if not matrix:
            continue

        # Try to infer caption from the paragraph just before this table.
        # python-docx doesn't expose table position directly, so we scan.
        caption = None
        tbl_element = table._tbl  # noqa: SLF001
        prev = tbl_element.getprevious()
        if prev is not None and prev.tag.endswith("}p"):
            prev_text = "".join(
                t.text or "" for t in prev.iter(qn("w:t"))
            ).strip()
            if prev_text and len(prev_text) < 100:
                caption = prev_text

        # First row as headers if it looks like a header row.
        headers = [c.strip() for c in matrix[0]]
        rows = [[c.strip() for c in row] for row in matrix[1:]]

        all_tables_raw.append({
            "index": ti,
            "caption": caption,
            "headers": headers,
            "rows": rows,
            "row_count": len(rows),
            "col_count": len(headers),
        })

    tables = all_tables_raw[:max_tables]

    return {
        "metadata": metadata,
        "paragraphs": paragraphs,
        "tables": tables,
        "stats": {
            "paragraphs_total": len(all_paragraphs),
            "tables_total": len(all_tables_raw),
            "paragraphs_kept": len(paragraphs),
            "tables_kept": len(tables),
        },
    }


def extract_amounts_from_table(table: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract suspected amount cells from a single table dict."""
    amounts: list[dict[str, Any]] = []
    headers = table.get("headers", [])
    for ri, row in enumerate(table.get("rows", [])):
        for ci, raw in enumerate(row):
            raw = raw.strip()
            if not raw:
                continue
            if not _AMOUNT_RE.search(raw):
                continue
            # Try to parse the numeric value.
            cleaned = raw.replace("￥", "").replace("¥", "").replace(",", "")
            cleaned = re.sub(r"(万?元|万?RMB)", "", cleaned, flags=re.IGNORECASE).strip()
            try:
                value = float(cleaned)
            except ValueError:
                continue
            header = headers[ci] if ci < len(headers) else ""
            amounts.append({
                "row": ri,
                "col": ci,
                "raw": raw,
                "value": value,
                "header": header,
            })
    return amounts


def format_docx_content(content: dict[str, Any]) -> str:
    """Format parsed docx content into Markdown text for LLM consumption."""
    parts: list[str] = []

    meta = content.get("metadata", {})
    if meta.get("title"):
        parts.append(f"# {meta['title']}\n")

    for para in content.get("paragraphs", []):
        text = para.get("text", "")
        if text:
            parts.append(text)

    for table in content.get("tables", []):
        parts.append("")  # blank line
        caption = table.get("caption")
        if caption:
            parts.append(f"**{caption}**\n")

        headers = table.get("headers", [])
        rows = table.get("rows", [])

        if headers:
            parts.append("| " + " | ".join(headers) + " |")
            parts.append("| " + " | ".join("---" for _ in headers) + " |")
        for row in rows:
            # Pad row to header length
            padded = list(row) + [""] * (len(headers) - len(row))
            parts.append("| " + " | ".join(padded[: len(headers)]) + " |")

    stats = content.get("stats", {})
    if stats.get("tables_total", 0) > stats.get("tables_kept", 0):
        parts.append(
            f"\n> 截断提示：共 {stats['tables_total']} 个表格，保留 {stats['tables_kept']} 个。"
        )

    return "\n".join(parts)
