"""DOCX document parsing — extract paragraphs, tables, and amounts."""

from __future__ import annotations

from .parser import (
    extract_amounts_from_table,
    format_docx_content,
    parse_docx,
)

__all__ = ["extract_amounts_from_table", "format_docx_content", "parse_docx"]
