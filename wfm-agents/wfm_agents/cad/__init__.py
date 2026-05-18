"""CAD 审图：DXF/DWG 解析、工具集、审图 prompt。

模块边界
--------
- :mod:`.parser`    DXF → 结构化摘要 dict（依赖 ezdxf）
- :mod:`.dwg`       DWG → DXF 转换 + 临时文件管理
- :mod:`.tools`     8 个 @function_tool（cad_file_read / cad_extract_* / cad_check_*）
- :mod:`.checks`    专项检查逻辑（命名规范、标题块、标注精度）
- :mod:`.recipes`   prompt 拼装（route 层不再调用，保留兼容）
- :mod:`.review`    CadReviewReport Pydantic schema
"""

from __future__ import annotations

from .dwg import resolve_cad_file, save_temp_dxf
from .parser import DxfParseError, summarize_dxf, summarize_dxf_text
from .recipes import RECIPE_ID, cad_review_prompt, format_summary_text

__all__ = [
    "DxfParseError",
    "RECIPE_ID",
    "cad_review_prompt",
    "format_summary_text",
    "resolve_cad_file",
    "save_temp_dxf",
    "summarize_dxf",
    "summarize_dxf_text",
]
