"""CAD 审图工具集 — 8 个 @function_tool。

Tier 1 总览：cad_file_read
Tier 2 按需深挖：cad_extract_texts / cad_extract_dims / cad_extract_blocks / cad_layer_inspect
Tier 3 专项检查：cad_check_naming / cad_check_titleblock / cad_check_dim_accuracy
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from agents import RunContextWrapper, function_tool

from ..workspace import WorkspaceViolation, resolve_within

_log = logging.getLogger(__name__)


def _resolve(ctx: RunContextWrapper, path: str) -> str:
    """解析路径，失败时返回 Error 前缀字符串。

    绝对路径直接接受（后端生成的临时文件等场景），
    相对路径受 workspace 沙箱约束。
    """
    p = Path(path)
    if p.is_absolute():
        if not p.is_file():
            return f"Error: 文件不存在: {path}"
        return str(p)
    try:
        abs_path = resolve_within(ctx.context.workspace_root, path)
    except WorkspaceViolation as exc:
        return f"Error: {exc}"
    if not abs_path.is_file():
        return f"Error: 文件不存在: {path}"
    return str(abs_path)


# ── Tier 1: 总览 ───────────────────────────────────────────────────────


@function_tool
def cad_file_read(ctx: RunContextWrapper, path: str) -> str:
    """读取 CAD 文件并返回结构化总览摘要。

    支持 .dxf 和 .dwg 格式。返回文件元数据、图层列表（含实体计数）、
    文字/标注/块的数量统计、标题块字段、图纸单位等。

    Args:
        path: 工作区相对路径或绝对路径，如 'drawings/总布置图.dwg'
    """
    resolved = _resolve(ctx, path)
    if resolved.startswith("Error:"):
        return resolved
    try:
        from .parser import summarize_dxf_overview  # noqa: PLC0415

        result = summarize_dxf_overview(resolved)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        return f"Error: 文件解析失败: {exc}"


# ── Tier 2: 按需深挖 ─────────────────────────────────────────────────


@function_tool
def cad_extract_texts(
    ctx: RunContextWrapper,
    path: str,
    layer: str | None = None,
) -> str:
    """提取 CAD 文件中的文字内容（TEXT + MTEXT）。

    Args:
        path: 工作区相对路径或绝对路径。
        layer: 可选，只提取指定图层的文字。
    """
    resolved = _resolve(ctx, path)
    if resolved.startswith("Error:"):
        return resolved
    try:
        from .parser import summarize_dxf_texts  # noqa: PLC0415

        result = summarize_dxf_texts(resolved, layer=layer)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        return f"Error: 文字提取失败: {exc}"


@function_tool
def cad_extract_dims(
    ctx: RunContextWrapper,
    path: str,
    layer: str | None = None,
) -> str:
    """提取标注信息（DIMENSION），含测量值、文字覆盖、关联实体。

    Args:
        path: 工作区相对路径或绝对路径。
        layer: 可选，只提取指定图层的标注。
    """
    resolved = _resolve(ctx, path)
    if resolved.startswith("Error:"):
        return resolved
    try:
        from .parser import summarize_dxf_dims  # noqa: PLC0415

        result = summarize_dxf_dims(resolved, layer=layer)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        return f"Error: 标注提取失败: {exc}"


@function_tool
def cad_extract_blocks(ctx: RunContextWrapper, path: str) -> str:
    """提取块定义（BLOCK），含名称、实体组成、嵌套关系。

    Args:
        path: 工作区相对路径或绝对路径。
    """
    resolved = _resolve(ctx, path)
    if resolved.startswith("Error:"):
        return resolved
    try:
        from .parser import summarize_dxf_blocks  # noqa: PLC0415

        result = summarize_dxf_blocks(resolved)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        return f"Error: 块提取失败: {exc}"


@function_tool
def cad_layer_inspect(
    ctx: RunContextWrapper,
    path: str,
    layer: str,
) -> str:
    """深入检查单个图层：实体类型分布、坐标范围、文字内容、标注值。

    Args:
        path: 工作区相对路径或绝对路径。
        layer: 图层名称。
    """
    resolved = _resolve(ctx, path)
    if resolved.startswith("Error:"):
        return resolved
    try:
        from .parser import summarize_dxf_layer  # noqa: PLC0415

        result = summarize_dxf_layer(resolved, layer)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        return f"Error: 图层检查失败: {exc}"


# ── Tier 3: 专项检查 ─────────────────────────────────────────────────


@function_tool
def cad_check_naming(
    ctx: RunContextWrapper,
    path: str,
    rule_set: str = "default",
) -> str:
    """检查图层/块命名是否符合规范。

    Args:
        path: 工作区相对路径或绝对路径。
        rule_set: 命名规则集（default / iso / company_xxx）。
    """
    resolved = _resolve(ctx, path)
    if resolved.startswith("Error:"):
        return resolved
    try:
        from .checks import check_naming  # noqa: PLC0415

        result = check_naming(resolved, rule_set=rule_set)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        return f"Error: 命名检查失败: {exc}"


@function_tool
def cad_check_titleblock(ctx: RunContextWrapper, path: str) -> str:
    """检查标题块字段完整性和格式（日期格式、图号规范等）。

    Args:
        path: 工作区相对路径或绝对路径。
    """
    resolved = _resolve(ctx, path)
    if resolved.startswith("Error:"):
        return resolved
    try:
        from .checks import check_titleblock  # noqa: PLC0415

        result = check_titleblock(resolved)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        return f"Error: 标题块检查失败: {exc}"


@function_tool
def cad_check_dim_accuracy(
    ctx: RunContextWrapper,
    path: str,
    tolerance: float = 0.01,
) -> str:
    """检查标注精度：用 ezdxf 计算几何长度，与 DIMENSION 文字覆盖对比，
    找出不一致的标注。

    Args:
        path: 工作区相对路径或绝对路径。
        tolerance: 允许的误差范围，默认 0.01。
    """
    resolved = _resolve(ctx, path)
    if resolved.startswith("Error:"):
        return resolved
    try:
        from .checks import check_dim_accuracy  # noqa: PLC0415

        result = check_dim_accuracy(resolved, tolerance=tolerance)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        return f"Error: 标注精度检查失败: {exc}"


# ── 工具集导出 ────────────────────────────────────────────────────────

cad_review_tools = [
    cad_file_read,
    cad_extract_texts,
    cad_extract_dims,
    cad_extract_blocks,
    cad_layer_inspect,
    cad_check_naming,
    cad_check_titleblock,
    cad_check_dim_accuracy,
]
