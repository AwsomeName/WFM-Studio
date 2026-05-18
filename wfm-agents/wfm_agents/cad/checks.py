"""CAD 专项检查：命名规范、标题块、标注精度。

每个函数接受文件路径，返回结构化检查结果 dict。
"""

from __future__ import annotations

import re
from typing import Any

# 图层命名前缀规范（AIA 类）
_LAYER_PREFIXES = {"A", "M", "S", "C", "E", "P", "G", "L", "R", "V", "X"}
# 标题块常见字段关键词（中英文）
_TITLEBLOCK_FIELDS = {
    "图名": ("title", "图名"),
    "图号": ("drawing_number", "图号"),
    "审核": ("checked_by", "审核"),
    "设计": ("designed_by", "设计"),
    "日期": ("date", "日期"),
    "比例": ("scale", "比例"),
    "材料": ("material", "材料"),
    "项目": ("project", "项目"),
    "阶段": ("phase", "阶段"),
}
# 标题块图层关键词
_TITLEBLOCK_LAYER_PATTERNS = re.compile(
    r"(title|block|图框|标题|stamp)", re.IGNORECASE
)


def check_naming(
    path: str | Any,
    *,
    rule_set: str = "default",
) -> dict[str, Any]:
    """检查图层/块命名是否符合规范。

    Args:
        path: 文件路径。
        rule_set: 命名规则集（default / iso / company_xxx）。
    """
    from .parser import _load_doc, _safe_attr  # noqa: PLC0415

    doc, _ = _load_doc(path)

    issues: list[dict[str, str]] = []

    # 检查图层命名
    for layer in doc.layers:  # type: ignore[attr-defined]
        name = str(_safe_attr(layer.dxf, "name", ""))
        if not name or name in ("0", "Defpoints"):
            continue
        if " " in name:
            issues.append({
                "type": "layer",
                "name": name,
                "issue": "图层名含空格",
                "suggestion": f"将 '{name}' 改为 '{name.replace(' ', '-')}'",
            })
        if any(ord(c) > 0x4E00 for c in name):
            issues.append({
                "type": "layer",
                "name": name,
                "issue": "图层名含中文字符",
                "suggestion": f"建议使用英文前缀命名（如 A-WALL, M-EQUIP）",
            })

    # 检查块命名
    for block in doc.blocks:  # type: ignore[attr-defined]
        name = str(_safe_attr(block, "name", ""))
        if not name or name.startswith("*"):
            continue
        if " " in name:
            issues.append({
                "type": "block",
                "name": name,
                "issue": "块名含空格",
                "suggestion": f"将 '{name}' 改为 '{name.replace(' ', '_')}'",
            })

    return {
        "rule_set": rule_set,
        "issues": issues,
        "total_issues": len(issues),
    }


def check_titleblock(
    path: str | Any,
) -> dict[str, Any]:
    """检查标题块字段完整性和格式。

    在标题块图层中查找常见字段（图名、图号、日期、审核等），
    报告缺失或为空的字段。
    """
    from .parser import _load_doc, _scan_entities, _safe_attr  # noqa: PLC0415

    doc, _ = _load_doc(path)
    _, texts, _, _, _ = _scan_entities(doc)

    # 找标题块图层中的文字
    tb_texts: list[dict[str, Any]] = []
    for t in texts:
        layer_name = t.get("layer", "")
        if _TITLEBLOCK_LAYER_PATTERNS.search(layer_name):
            tb_texts.append(t)

    # 也检查 "0" 图层中的常见标题字段
    for t in texts:
        content = t.get("text", "").strip()
        for cn_name, (_, en_name) in _TITLEBLOCK_FIELDS.items():
            if cn_name in content or en_name.lower() in content.lower():
                if t not in tb_texts:
                    tb_texts.append(t)
                break

    # 分析字段
    fields: dict[str, dict[str, str | None]] = {}
    for cn_name, (en_key, _) in _TITLEBLOCK_FIELDS.items():
        found_value: str | None = None
        for t in tb_texts:
            content = t.get("text", "").strip()
            if cn_name in content or en_key.lower() in content.lower():
                if ":" in content or "：" in content:
                    val = re.split(r"[:：]", content, 1)[1].strip()
                    if val:
                        found_value = val
                break
        fields[cn_name] = {"value": found_value, "status": "ok" if found_value else "missing"}

    missing = [k for k, v in fields.items() if v["status"] == "missing"]
    # 日期格式检查
    date_val = fields.get("日期", {}).get("value")
    date_issue = None
    if date_val:
        if not re.search(r"\d{4}", date_val):
            date_issue = f"日期格式异常: '{date_val}'（建议 YYYY-MM-DD）"

    issues: list[dict[str, str]] = []
    for f in missing:
        issues.append({
            "field": f,
            "issue": "字段为空或未找到",
            "suggestion": f"请在标题块中填写 '{f}' 字段",
        })
    if date_issue:
        issues.append({"field": "日期", "issue": date_issue})

    return {
        "fields": fields,
        "issues": issues,
        "total_issues": len(issues),
    }


def check_dim_accuracy(
    path: str | Any,
    *,
    tolerance: float = 0.01,
) -> dict[str, Any]:
    """检查标注精度：用 ezdxf 计算几何长度与 DIMENSION 文字覆盖对比。

    Args:
        path: 文件路径。
        tolerance: 允许的误差范围，默认 0.01。
    """
    from .parser import _load_doc, _scan_entities  # noqa: PLC0415

    doc, _ = _load_doc(path)
    _, _, dimensions, _, _ = _scan_entities(doc)

    mismatches: list[dict[str, Any]] = []
    checked = 0

    for dim in dimensions:
        measurement = dim.get("measurement")
        text_override = dim.get("text_override")

        if measurement is None or text_override is None:
            continue
        if not text_override or text_override in ("<>", " "):
            continue

        # 尝试解析文字覆盖为数值
        try:
            text_val = float(text_override.replace(",", "").replace(" ", ""))
        except (ValueError, TypeError):
            continue

        checked += 1
        diff = abs(measurement - text_val)
        if diff > tolerance:
            mismatches.append({
                "handle": dim.get("handle"),
                "layer": dim.get("layer"),
                "measurement": round(measurement, 4),
                "text_override": text_override,
                "difference": round(diff, 4),
            })

    return {
        "total_checked": checked,
        "total_mismatches": len(mismatches),
        "tolerance": tolerance,
        "mismatches": mismatches,
    }
