"""Generate .docx files from Markdown content, optionally using a template for styles."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor


# ── Markdown Lexer ─────────────────────────────────────────────────────


@dataclass
class _MdToken:
    type: str  # heading | paragraph | table | bullet | ordered
    payload: dict[str, Any] = field(default_factory=dict)


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_BULLET_RE = re.compile(r"^[-*]\s+(.+)$")
_ORDERED_RE = re.compile(r"^(\d+)\.\s+(.+)$")
_TABLE_SEP_RE = re.compile(r"^\|([\s:]*[-:]+[\s:]*\|)+$")


def _lex_markdown(text: str) -> list[_MdToken]:
    lines = text.split("\n")
    tokens: list[_MdToken] = []
    i = 0

    while i < len(lines):
        line = lines[i]

        # Skip blank lines
        if not line.strip():
            i += 1
            continue

        # Heading
        m = _HEADING_RE.match(line)
        if m:
            tokens.append(_MdToken("heading", {"level": len(m.group(1)), "text": m.group(2)}))
            i += 1
            continue

        # Table — collect consecutive | lines
        if line.startswith("|"):
            table_lines: list[str] = []
            while i < len(lines) and lines[i].startswith("|"):
                table_lines.append(lines[i])
                i += 1
            tokens.append(_parse_table_block(table_lines))
            continue

        # Bullet list
        m = _BULLET_RE.match(line)
        if m:
            tokens.append(_MdToken("bullet", {"text": m.group(1)}))
            i += 1
            continue

        # Ordered list
        m = _ORDERED_RE.match(line)
        if m:
            tokens.append(_MdToken("ordered", {"number": int(m.group(1)), "text": m.group(2)}))
            i += 1
            continue

        # Paragraph (fallback)
        tokens.append(_MdToken("paragraph", {"text": line}))
        i += 1

    return tokens


def _parse_table_block(lines: list[str]) -> _MdToken:
    """Parse consecutive pipe-delimited lines into a table token."""
    cells = [_split_pipe_line(ln) for ln in lines]

    # Find separator row
    sep_idx = -1
    for idx, ln in enumerate(lines):
        if _TABLE_SEP_RE.match(ln.strip()):
            sep_idx = idx
            break

    if sep_idx < 1:
        # No valid separator — treat as paragraph
        return _MdToken("paragraph", {"text": "\n".join(lines)})

    headers = cells[0]
    rows = [cells[r] for r in range(sep_idx + 1, len(cells))]
    return _MdToken("table", {"headers": headers, "rows": rows})


def _split_pipe_line(line: str) -> list[str]:
    """Split '| a | b | c |' into ['a', 'b', 'c']."""
    parts = line.strip().strip("|").split("|")
    return [p.strip() for p in parts]


# ── Inline Formatting ──────────────────────────────────────────────────


_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_ITALIC_RE = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", re.DOTALL)


def _parse_inline(text: str) -> list[tuple[str, str]]:
    """Split text into (kind, text) segments where kind is normal/bold/italic."""
    segments: list[tuple[str, str]] = []
    # Pass 1: split by **bold**
    bold_parts = _BOLD_RE.split(text)
    for part in bold_parts:
        if part is None:
            continue
        # Check if this part was a bold capture group (odd indices in split)
        pass

    # Rebuild using finditer for cleaner logic
    segments = []
    last = 0
    # Bold first
    bold_spans: list[tuple[int, int, str]] = []
    for m in _BOLD_RE.finditer(text):
        bold_spans.append((m.start(), m.end(), m.group(1)))
    italic_spans: list[tuple[int, int, str]] = []
    for m in _ITALIC_RE.finditer(text):
        # Skip if inside a bold span
        if any(bs <= m.start() and m.end() <= be for bs, be, _ in bold_spans):
            continue
        italic_spans.append((m.start(), m.end(), m.group(1)))

    all_spans: list[tuple[int, int, str, str]] = []
    for s, e, t in bold_spans:
        all_spans.append((s, e, t, "bold"))
    for s, e, t in italic_spans:
        all_spans.append((s, e, t, "italic"))
    all_spans.sort(key=lambda x: x[0])

    pos = 0
    for start, end, content, kind in all_spans:
        if pos < start:
            segments.append(("normal", text[pos:start]))
        segments.append((kind, content))
        pos = end
    if pos < len(text):
        segments.append(("normal", text[pos:]))

    if not segments:
        segments = [("normal", text)]
    return segments


def _apply_inline(paragraph: Any, segments: list[tuple[str, str]]) -> None:
    """Create Runs in paragraph with bold/italic from parsed inline segments."""
    for kind, text in segments:
        if not text:
            continue
        run = paragraph.add_run(text)
        if kind == "bold":
            run.bold = True
        elif kind == "italic":
            run.italic = True


# ── Template Helpers ───────────────────────────────────────────────────


def _clear_body(doc: Document) -> None:
    """Remove all body content elements, preserving section properties."""
    body = doc.element.body
    to_remove = [child for child in body if child.tag != qn("w:sectPr")]
    for child in to_remove:
        body.remove(child)


def _apply_variables(doc: Document, variables: dict[str, str]) -> None:
    """Replace {{key}} placeholders in headers/footers with variable values."""
    if not variables:
        return

    # Process headers and footers
    for section in doc.sections:
        for header_footer in (section.header, section.footer):
            if header_footer.is_linked_to_previous:
                continue
            for para in header_footer.paragraphs:
                _replace_in_paragraph_runs(para, variables)


def _replace_in_paragraph_runs(para: Any, variables: dict[str, str]) -> None:
    """Replace {{key}} in a paragraph's runs, handling split-run edge cases."""
    # Simple case: check each run individually
    full_text = para.text
    has_placeholder = any(f"{{{{{k}}}}}" in full_text for k in variables)
    if not has_placeholder:
        return

    # If a placeholder spans multiple runs, consolidate into one run first
    runs = para.runs
    if len(runs) > 1:
        # Check if any {{...}} spans run boundaries
        joined = "".join(r.text for r in runs)
        needs_consolidation = False
        for key in variables:
            placeholder = f"{{{{{key}}}}}"
            if placeholder in joined:
                # Check if it's split across runs
                for i in range(len(runs)):
                    for j in range(i + 1, len(runs) + 1):
                        fragment = "".join(r.text for r in runs[i:j])
                        if placeholder in fragment and placeholder not in runs[i].text:
                            needs_consolidation = True
                            break
                    if needs_consolidation:
                        break
            if needs_consolidation:
                break

        if needs_consolidation:
            # Consolidate all runs into the first run
            first = runs[0]
            first.text = joined
            for r in runs[1:]:
                r.text = ""

    # Now do simple per-run replacement
    for run in para.runs:
        for key, value in variables.items():
            run.text = run.text.replace(f"{{{{{key}}}}}", value)


def _apply_default_styles(doc: Document) -> None:
    """Apply CJK-friendly default styles to a new document."""
    style_normal = doc.styles["Normal"]
    font = style_normal.font
    font.size = Pt(12)
    rpr = style_normal.element.get_or_add_rPr()
    rFonts = rpr.find(qn("w:rFonts"))
    if rFonts is None:
        from docx.oxml import OxmlElement
        rFonts = OxmlElement("w:rFonts")
        rpr.insert(0, rFonts)
    rFonts.set(qn("w:eastAsia"), "宋体")
    rFonts.set(qn("w:ascii"), "Times New Roman")
    rFonts.set(qn("w:hAnsi"), "Times New Roman")

    for level, size in [(1, 16), (2, 14), (3, 12)]:
        style = doc.styles[f"Heading {level}"]
        style.font.size = Pt(size)
        style.font.bold = True
        rpr = style.element.get_or_add_rPr()
        rFonts = rpr.find(qn("w:rFonts"))
        if rFonts is None:
            from docx.oxml import OxmlElement
            rFonts = OxmlElement("w:rFonts")
            rpr.insert(0, rFonts)
        rFonts.set(qn("w:eastAsia"), "黑体")
        rFonts.set(qn("w:ascii"), "Times New Roman")
        rFonts.set(qn("w:hAnsi"), "Times New Roman")


# ── Document Builder ───────────────────────────────────────────────────


def _build_document(
    tokens: list[_MdToken],
    template_doc: Document | None = None,
) -> Document:
    """Build a python-docx Document from parsed Markdown tokens."""
    if template_doc is not None:
        doc = template_doc
        _clear_body(doc)
    else:
        doc = Document()
        _apply_default_styles(doc)

    for idx, token in enumerate(tokens):
        if token.type == "heading":
            level = min(token.payload["level"], 6)
            para = doc.add_heading(level=level)
            _apply_inline(para, _parse_inline(token.payload["text"]))

        elif token.type == "paragraph":
            para = doc.add_paragraph(style="Normal")
            _apply_inline(para, _parse_inline(token.payload["text"]))

        elif token.type == "bullet":
            para = doc.add_paragraph(style="List Bullet")
            _apply_inline(para, _parse_inline(token.payload["text"]))

        elif token.type == "ordered":
            para = doc.add_paragraph(style="List Number")
            _apply_inline(para, _parse_inline(token.payload["text"]))

        elif token.type == "table":
            headers = token.payload["headers"]
            rows = token.payload["rows"]
            col_count = len(headers)
            if col_count == 0:
                continue

            table = doc.add_table(rows=1 + len(rows), cols=col_count)
            try:
                table.style = doc.styles["Table Grid"]
            except KeyError:
                table.style = "Table Grid"

            # Header row
            for ci, h in enumerate(headers):
                cell = table.rows[0].cells[ci]
                cell.paragraphs[0].clear()
                run = cell.paragraphs[0].add_run(h)
                run.bold = True

            # Data rows
            for ri, row in enumerate(rows):
                for ci in range(col_count):
                    val = row[ci] if ci < len(row) else ""
                    cell = table.rows[ri + 1].cells[ci]
                    cell.paragraphs[0].clear()
                    _apply_inline(cell.paragraphs[0], _parse_inline(val))

    return doc


# ── Public API ─────────────────────────────────────────────────────────


def markdown_to_docx(
    path: Path,
    content: str,
    template_path: Path | None = None,
    variables: dict[str, str] | None = None,
) -> Path:
    """Create a .docx file from Markdown content.

    Args:
        path: Output file path.
        content: Markdown body content.
        template_path: Optional template .docx to inherit styles.
        variables: Optional {key: value} for {{placeholder}} replacement.

    Returns:
        The output file path.
    """
    template_doc = None
    if template_path is not None:
        template_doc = Document(str(template_path))

    tokens = _lex_markdown(content)
    doc = _build_document(tokens, template_doc)

    if variables:
        _apply_variables(doc, variables)

    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(path))
    return path


def write_docx_from_markdown(
    path: str | Path,
    content: str,
    template_path: str | Path | None = None,
    variables_dict: dict[str, str] | None = None,
) -> str:
    """Convenience wrapper returning a summary string.

    Returns:
        A human-readable summary of the generated document.
    """
    path = Path(path)
    tpl = Path(template_path) if template_path else None

    result = markdown_to_docx(path, content, tpl, variables_dict)

    size_kb = result.stat().st_size / 1024
    parts = [f"文档已生成: {result} ({size_kb:.1f} KB)"]

    tokens = _lex_markdown(content)
    headings = sum(1 for t in tokens if t.type == "heading")
    paragraphs = sum(1 for t in tokens if t.type == "paragraph")
    tables = sum(1 for t in tokens if t.type == "table")
    bullet_items = sum(1 for t in tokens if t.type == "bullet")
    ordered_items = sum(1 for t in tokens if t.type == "ordered")

    detail_parts: list[str] = []
    if headings:
        detail_parts.append(f"{headings} 个标题")
    if paragraphs:
        detail_parts.append(f"{paragraphs} 个段落")
    if tables:
        detail_parts.append(f"{tables} 个表格")
    if bullet_items:
        detail_parts.append(f"{bullet_items} 个列表项")
    if ordered_items:
        detail_parts.append(f"{ordered_items} 个编号项")

    if detail_parts:
        parts.append("包含: " + "、".join(detail_parts))

    if template_path:
        parts.append(f"使用模板: {template_path}")
    if variables_dict:
        parts.append(f"替换变量: {', '.join(variables_dict.keys())}")

    return "\n".join(parts)
