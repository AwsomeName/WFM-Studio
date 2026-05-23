"""CAD 审图 prompt 拼装。

设计要点
--------
- 输入是 :func:`wfm_agents.cad.parser.summarize_dxf` 的 dict 摘要 + 用户原始问题。
- 输出是一段已经"上下文齐全"的纯文本 prompt：包含"审图任务说明 + 摘要文本 +
  用户问题 + 输出格式要求"。
- 只产文本；不调 LLM、不感知 engine 类型——任何 engine 拿到这段 message
  都能直接转发给底层模型。
"""

from __future__ import annotations

from typing import Any

#: cad_review 路由使用此值作为审图分支的标识。
RECIPE_ID = "wfm.cad_review"

_OUTPUT_FORMAT_SPEC = """请按如下结构输出审图意见：

## 总体评价
（1~2 句话整体评价）

## 关键问题
- [严重程度] [所在图层/位置] 问题描述
  - 证据：（基于摘要里的具体文字/标注/坐标）
  - 建议：（如何修改）

## 风险与建议
- 中长期可优化点（命名规范、图层组织等）

## 信息缺口
- 如果摘要不足以判断，请明确指出还需要哪些信息（例如规范号、设计意图、专业类型）

严重程度只用三档：error / warning / info。"""


def format_summary_text(summary: dict[str, Any]) -> str:
    """把 :func:`summarize_dxf` 输出渲染成人类可读的多段文本。"""
    lines: list[str] = []

    file_info = summary.get("file") or {}
    lines.append(f"文件: {file_info.get('path', '?')}")
    if "size_bytes" in file_info:
        size_kb = file_info["size_bytes"] / 1024
        lines.append(f"大小: {size_kb:.1f} KB")

    header = summary.get("header") or {}
    if header:
        lines.append("")
        lines.append("DXF 头部:")
        for key, value in header.items():
            lines.append(f"  {key} = {value}")

    layer_count = summary.get("layer_count", 0)
    layers = summary.get("layers") or []
    lines.append("")
    lines.append(f"图层 ({layer_count} 个):")
    for layer in layers:
        flags: list[str] = []
        if layer.get("frozen"):
            flags.append("frozen")
        if layer.get("locked"):
            flags.append("locked")
        flag_str = f" [{','.join(flags)}]" if flags else ""
        lines.append(
            f"  {layer.get('name')!r} color={layer.get('color')} "
            f"entities={layer.get('entity_count', 0)}{flag_str}"
        )

    by_layer_type = summary.get("entities_by_layer") or {}
    if by_layer_type:
        lines.append("")
        lines.append("各图层实体类型计数:")
        for layer_name, types in by_layer_type.items():
            type_str = ", ".join(
                f"{t}={c}" for t, c in sorted(types.items(), key=lambda kv: -kv[1])
            )
            lines.append(f"  {layer_name!r}: {type_str}")

    texts = summary.get("texts") or []
    if texts:
        lines.append("")
        lines.append(f"图中文字 ({len(texts)} 条，可能截断):")
        for t in texts:
            pos = t.get("position")
            pos_str = f" @ {pos}" if pos else ""
            lines.append(
                f"  [{t.get('layer')}] {t.get('type')}: {t.get('text')!r}{pos_str}"
            )

    dimensions = summary.get("dimensions") or []
    if dimensions:
        lines.append("")
        lines.append(f"尺寸标注 ({len(dimensions)} 条，可能截断):")
        for d in dimensions:
            measurement = d.get("measurement")
            override = d.get("text_override")
            if override:
                value_str = f"标注文本={override!r}"
            elif measurement is not None:
                value_str = f"实测={measurement}"
            else:
                value_str = "（无文本/实测）"
            lines.append(f"  [{d.get('layer')}] {value_str} defpoint={d.get('defpoint')}")

    blocks = summary.get("block_names") or []
    if blocks:
        lines.append("")
        lines.append(f"自定义块 ({len(blocks)} 个):")
        lines.append("  " + ", ".join(blocks))

    return "\n".join(lines).rstrip()


def cad_review_prompt(summary: dict[str, Any], user_message: str) -> str:
    """把摘要 + 用户原话拼成完整审图 prompt。

    ``user_message`` 通常来自前端"任务对话"里用户输入的文本。
    """
    summary_text = format_summary_text(summary)
    user = (user_message or "").strip() or "（用户未提供具体审图要求，请按通用方法审）"

    return (
        "你是一位资深 CAD 图纸审图工程师。下面是从用户提供的 DXF 文件中"
        "抽取的结构化摘要（已限制条目数以避免噪声）。请基于摘要回答用户问题，"
        "若信息不足请明确指出，不要臆造数据。\n"
        "\n"
        f"### DXF 摘要\n```\n{summary_text}\n```\n"
        "\n"
        f"### 用户问题\n{user}\n"
        "\n"
        f"### 输出要求\n{_OUTPUT_FORMAT_SPEC}\n"
    )
