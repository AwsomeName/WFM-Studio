"""Shared Markdown lexer — tokenizes Markdown text for docx/xlsx writers."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class MdToken:
    type: str  # heading | paragraph | table | bullet | ordered
    payload: dict[str, Any] = field(default_factory=dict)


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_BULLET_RE = re.compile(r"^[-*]\s+(.+)$")
_ORDERED_RE = re.compile(r"^(\d+)\.\s+(.+)$")
_TABLE_SEP_RE = re.compile(r"^\|([\s:]*[-:]+[\s:]*\|)+$")


def lex_markdown(text: str) -> list[MdToken]:
    """Tokenize Markdown text into a list of MdToken objects."""
    lines = text.split("\n")
    tokens: list[MdToken] = []
    i = 0

    while i < len(lines):
        line = lines[i]

        if not line.strip():
            i += 1
            continue

        m = _HEADING_RE.match(line)
        if m:
            tokens.append(MdToken("heading", {"level": len(m.group(1)), "text": m.group(2)}))
            i += 1
            continue

        if line.startswith("|"):
            table_lines: list[str] = []
            while i < len(lines) and lines[i].startswith("|"):
                table_lines.append(lines[i])
                i += 1
            tokens.append(_parse_table_block(table_lines))
            continue

        m = _BULLET_RE.match(line)
        if m:
            tokens.append(MdToken("bullet", {"text": m.group(1)}))
            i += 1
            continue

        m = _ORDERED_RE.match(line)
        if m:
            tokens.append(MdToken("ordered", {"number": int(m.group(1)), "text": m.group(2)}))
            i += 1
            continue

        tokens.append(MdToken("paragraph", {"text": line}))
        i += 1

    return tokens


def _parse_table_block(lines: list[str]) -> MdToken:
    """Parse consecutive pipe-delimited lines into a table token."""
    cells = [_split_pipe_line(ln) for ln in lines]

    sep_idx = -1
    for idx, ln in enumerate(lines):
        if _TABLE_SEP_RE.match(ln.strip()):
            sep_idx = idx
            break

    if sep_idx < 1:
        return MdToken("paragraph", {"text": "\n".join(lines)})

    headers = cells[0]
    rows = [cells[r] for r in range(sep_idx + 1, len(cells))]
    return MdToken("table", {"headers": headers, "rows": rows})


def _split_pipe_line(line: str) -> list[str]:
    """Split '| a | b | c |' into ['a', 'b', 'c']."""
    parts = line.strip().strip("|").split("|")
    return [p.strip() for p in parts]
