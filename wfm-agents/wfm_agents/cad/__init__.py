"""CAD 审图：DXF 摘要与审图 prompt 拼装。

模块边界
--------
- :mod:`.parser`    负责 DXF -> 结构化摘要 dict（依赖 ezdxf）
- :mod:`.recipes`   负责把摘要 + 用户问题拼成 prompt 文本

不在本模块负责的事
------------------
- HTTP 路由：见 :mod:`wfm_agents.routes.chat`（`/v1/chat`，可携带 ``dxf_text``）
- DWG -> DXF 转换：v0.2 已整组下线，浏览器内由 LibreDWG WASM + cad-viewer
  解析与渲染（见 ``docs/ARCH_CAD_REVIEW.md``）
"""

from __future__ import annotations

from .parser import DxfParseError, summarize_dxf, summarize_dxf_text
from .recipes import RECIPE_ID, cad_review_prompt, format_summary_text

__all__ = [
    "DxfParseError",
    "RECIPE_ID",
    "cad_review_prompt",
    "format_summary_text",
    "summarize_dxf",
    "summarize_dxf_text",
]
