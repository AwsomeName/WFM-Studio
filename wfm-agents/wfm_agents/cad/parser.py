"""DXF -> 结构化摘要 dict。

依赖 ``ezdxf``（运行时按需 import），把一份 DXF 文件抽取成对 LLM 友好的
摘要结构，避免直接把整张图喂给模型（DXF 文本可能上百万字）。

摘要包括：

- 头部要点：DXF 版本、文件单位、图框范围 (``$EXTMIN`` / ``$EXTMAX``)
- 图层列表：名称、颜色、是否冻结
- 实体计数：按图层 × 类型聚合
- 文字与标注：抽取所有 TEXT / MTEXT 内容、所有 DIMENSION 的标注文本
- 块定义：自定义块名清单
"""

from __future__ import annotations

import io
import os
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# 控制摘要规模，避免极端图把 prompt 撑爆。
_MAX_TEXTS = 200
_MAX_DIMS = 200
_MAX_LAYERS_DETAIL = 200
_MAX_BLOCKS = 200

#: 头部里我们关心的 DXF 系统变量（其它字段噪声大，跳过）。
_HEADER_KEYS_OF_INTEREST: tuple[str, ...] = (
    "$ACADVER",
    "$INSUNITS",
    "$EXTMIN",
    "$EXTMAX",
    "$LIMMIN",
    "$LIMMAX",
    "$DWGCODEPAGE",
    "$MEASUREMENT",
)


class DxfParseError(RuntimeError):
    """DXF 解析失败（含 ezdxf 未安装、文件结构错误等）。"""


@dataclass(frozen=True)
class _LayerInfo:
    name: str
    color: int | None
    frozen: bool
    locked: bool


def _require_ezdxf():
    try:
        import ezdxf  # noqa: PLC0415
    except ImportError as exc:
        raise DxfParseError(
            "未安装 ezdxf。请执行: pip install 'ezdxf>=1.3' "
            "或 uv add ezdxf"
        ) from exc
    return ezdxf


def _safe_attr(obj: Any, name: str, default: Any = None) -> Any:
    try:
        return getattr(obj, name, default)
    except Exception:  # pragma: no cover - 防御性
        return default


def _coerce_point(value: Any) -> tuple[float, float, float] | None:
    """把 ezdxf 的 Vec3 / 元组规范化成 (x, y, z) 浮点元组。"""
    if value is None:
        return None
    try:
        x = float(value[0])
        y = float(value[1])
        z = float(value[2]) if len(value) > 2 else 0.0  # type: ignore[arg-type]
    except (TypeError, ValueError, IndexError):
        return None
    return (x, y, z)


def _format_point(value: Any) -> list[float] | None:
    p = _coerce_point(value)
    if p is None:
        return None
    return [round(p[0], 4), round(p[1], 4), round(p[2], 4)]


def _extract_layers(doc: Any) -> list[_LayerInfo]:
    layers: list[_LayerInfo] = []
    for layer in doc.layers:  # type: ignore[attr-defined]
        layers.append(
            _LayerInfo(
                name=str(_safe_attr(layer.dxf, "name", "")),
                color=_safe_attr(layer.dxf, "color", None),
                frozen=bool(_safe_attr(layer, "is_frozen", lambda: False)())
                if callable(_safe_attr(layer, "is_frozen", None))
                else bool(_safe_attr(layer.dxf, "flags", 0) & 1),
                locked=bool(_safe_attr(layer, "is_locked", lambda: False)())
                if callable(_safe_attr(layer, "is_locked", None))
                else False,
            )
        )
    return layers


def _extract_header(doc: Any) -> dict[str, Any]:
    header_summary: dict[str, Any] = {}
    for key in _HEADER_KEYS_OF_INTEREST:
        try:
            value = doc.header[key]
        except KeyError:
            continue
        formatted = _format_point(value)
        if formatted is not None:
            header_summary[key] = formatted
        else:
            header_summary[key] = value
    return header_summary


def _scan_entities(doc: Any) -> tuple[
    dict[str, dict[str, int]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    """遍历 modelspace，返回 (按图层×类型计数, 文字, 标注)。"""
    by_layer_type: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    texts: list[dict[str, Any]] = []
    dimensions: list[dict[str, Any]] = []

    msp = doc.modelspace()
    for entity in msp:
        etype = entity.dxftype()
        layer = str(_safe_attr(entity.dxf, "layer", "0"))
        by_layer_type[layer][etype] += 1

        if etype in {"TEXT", "MTEXT"} and len(texts) < _MAX_TEXTS:
            content = ""
            if etype == "MTEXT":
                content = str(_safe_attr(entity, "text", "")).strip()
                if not content:
                    content = str(_safe_attr(entity, "plain_text", lambda: "")()
                                   if callable(_safe_attr(entity, "plain_text", None))
                                   else "")
            else:
                content = str(_safe_attr(entity.dxf, "text", "")).strip()
            if not content:
                continue
            position = _format_point(_safe_attr(entity.dxf, "insert", None))
            texts.append(
                {
                    "type": etype,
                    "layer": layer,
                    "text": content,
                    "position": position,
                }
            )
        elif etype == "DIMENSION" and len(dimensions) < _MAX_DIMS:
            measurement = _safe_attr(entity.dxf, "actual_measurement", None)
            text_override = str(_safe_attr(entity.dxf, "text", "") or "").strip()
            dimensions.append(
                {
                    "layer": layer,
                    "measurement": float(measurement)
                    if isinstance(measurement, (int, float))
                    else None,
                    "text_override": text_override or None,
                    "defpoint": _format_point(_safe_attr(entity.dxf, "defpoint", None)),
                }
            )

    # defaultdict -> 普通 dict，便于序列化
    return (
        {layer: dict(types) for layer, types in by_layer_type.items()},
        texts,
        dimensions,
    )


def _build_summary(doc: Any, file_meta: dict[str, Any]) -> dict[str, Any]:
    """已加载的 ezdxf Document -> 摘要 dict。供 readfile / read 流共享。"""
    layers = _extract_layers(doc)
    by_layer_type, texts, dimensions = _scan_entities(doc)

    block_names: list[str] = []
    for block in doc.blocks:  # type: ignore[attr-defined]
        name = str(_safe_attr(block, "name", ""))
        # 跳过 ezdxf 自动生成的匿名/系统块（以 * 开头）。
        if not name or name.startswith("*"):
            continue
        block_names.append(name)
        if len(block_names) >= _MAX_BLOCKS:
            break

    layer_counts = {layer: sum(types.values()) for layer, types in by_layer_type.items()}

    return {
        "file": file_meta,
        "header": _extract_header(doc),
        "layer_count": len(layers),
        "layers": [
            {
                "name": l.name,
                "color": l.color,
                "frozen": l.frozen,
                "locked": l.locked,
                "entity_count": layer_counts.get(l.name, 0),
            }
            for l in layers[:_MAX_LAYERS_DETAIL]
        ],
        "entities_by_layer": by_layer_type,
        "texts": texts,
        "dimensions": dimensions,
        "block_names": block_names,
        "limits": {
            "max_texts": _MAX_TEXTS,
            "max_dims": _MAX_DIMS,
            "max_layers_detail": _MAX_LAYERS_DETAIL,
            "max_blocks": _MAX_BLOCKS,
        },
    }


def summarize_dxf(path: str | os.PathLike[str]) -> dict[str, Any]:
    """读取一份 DXF 并返回 LLM 友好的摘要。"""
    ezdxf = _require_ezdxf()

    file_path = Path(os.fspath(path)).expanduser().resolve(strict=False)
    if not file_path.is_file():
        raise FileNotFoundError(f"DXF 文件不存在: {file_path}")

    try:
        doc = ezdxf.readfile(str(file_path))
    except Exception as exc:  # ezdxf 抛多种异常，统一包装
        raise DxfParseError(
            f"ezdxf 读取失败: {type(exc).__name__}: {exc}"
        ) from exc

    return _build_summary(
        doc,
        file_meta={
            "path": str(file_path),
            "size_bytes": file_path.stat().st_size,
        },
    )


def summarize_dxf_text(
    dxf_text: str,
    *,
    source_label: str | None = None,
) -> dict[str, Any]:
    """直接解析一段 DXF 文本（来自浏览器内 LibreDWG/cad-viewer）。

    与 :func:`summarize_dxf` 行为一致，但不需要落盘。``source_label`` 用于在
    摘要 ``file.path`` 字段里给出可读的来源标识（例如前端文件 URI），不会被
    当作磁盘路径解析。
    """
    if not isinstance(dxf_text, str) or not dxf_text:
        raise DxfParseError("dxf_text 为空")

    ezdxf = _require_ezdxf()

    try:
        doc = ezdxf.read(io.StringIO(dxf_text))
    except Exception as exc:  # ezdxf 抛多种异常，统一包装
        raise DxfParseError(
            f"ezdxf 读取（in-memory）失败: {type(exc).__name__}: {exc}"
        ) from exc

    return _build_summary(
        doc,
        file_meta={
            "path": source_label or "<viewer-inline>",
            "size_bytes": len(dxf_text.encode("utf-8")),
        },
    )
