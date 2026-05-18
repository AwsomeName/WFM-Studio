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
_MAX_STYLES = 50         # text styles / dim styles / linetypes 各自上限
_MAX_LAYOUTS = 20

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


def _scan_entities_in(
    container: Any,
    *,
    by_layer_type: dict[str, dict[str, int]],
    texts: list[dict[str, Any]],
    dimensions: list[dict[str, Any]],
    text_total: list[int],
    dim_total: list[int],
) -> None:
    """Scan one DXF entity container (modelspace / one paperspace layout).

    Mutates the four collectors in-place. Counters in ``text_total`` /
    ``dim_total`` track total entities seen *before* truncation so the
    top-level ``truncated`` field can report how many were dropped.
    """
    for entity in container:
        etype = entity.dxftype()
        layer = str(_safe_attr(entity.dxf, "layer", "0"))
        by_layer_type[layer][etype] += 1

        handle = str(_safe_attr(entity.dxf, "handle", "") or "") or None

        if etype in {"TEXT", "MTEXT"}:
            text_total[0] += 1
            if len(texts) >= _MAX_TEXTS:
                continue
            content = ""
            if etype == "MTEXT":
                content = str(_safe_attr(entity, "text", "")).strip()
                if not content:
                    content = str(
                        _safe_attr(entity, "plain_text", lambda: "")()
                        if callable(_safe_attr(entity, "plain_text", None))
                        else ""
                    )
            else:
                content = str(_safe_attr(entity.dxf, "text", "")).strip()
            if not content:
                continue
            position = _format_point(_safe_attr(entity.dxf, "insert", None))
            texts.append(
                {
                    "handle": handle,
                    "type": etype,
                    "layer": layer,
                    "text": content,
                    "position": position,
                }
            )
        elif etype == "DIMENSION":
            dim_total[0] += 1
            if len(dimensions) >= _MAX_DIMS:
                continue
            measurement = _safe_attr(entity.dxf, "actual_measurement", None)
            text_override = str(_safe_attr(entity.dxf, "text", "") or "").strip()
            dimensions.append(
                {
                    "handle": handle,
                    "layer": layer,
                    "measurement": float(measurement)
                    if isinstance(measurement, (int, float))
                    else None,
                    "text_override": text_override or None,
                    "defpoint": _format_point(_safe_attr(entity.dxf, "defpoint", None)),
                }
            )


def _scan_entities(doc: Any) -> tuple[
    dict[str, dict[str, int]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    dict[str, dict[str, int]],
    list[dict[str, Any]],
]:
    """Walk modelspace + paperspace layouts.

    Returns a 5-tuple:
    ``(by_layer_type, texts, dimensions, totals, layouts)``

    * ``by_layer_type`` includes paperspace entities too (they share layers
      with modelspace in DXF semantics).
    * ``totals`` is ``{"texts": {"kept", "total"}, "dims": {...}}`` so the
      top-level summary can expose truncation info.
    * ``layouts`` is per-paperspace ``{"name", "texts", "dims"}`` counts.
    """
    by_layer_type: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    texts: list[dict[str, Any]] = []
    dimensions: list[dict[str, Any]] = []
    text_total = [0]
    dim_total = [0]

    _scan_entities_in(
        doc.modelspace(),
        by_layer_type=by_layer_type,
        texts=texts,
        dimensions=dimensions,
        text_total=text_total,
        dim_total=dim_total,
    )

    layouts: list[dict[str, Any]] = []
    layout_names_fn = _safe_attr(doc, "layout_names", None)
    names: list[str] = []
    if callable(layout_names_fn):
        try:
            names = [str(n) for n in layout_names_fn()]
        except Exception:  # pragma: no cover - upstream variance
            names = []
    for name in names:
        if name == "Model":
            continue
        if len(layouts) >= _MAX_LAYOUTS:
            break
        try:
            layout = doc.layouts.get(name)
        except Exception:  # pragma: no cover - upstream variance
            continue
        before_t, before_d = text_total[0], dim_total[0]
        _scan_entities_in(
            layout,
            by_layer_type=by_layer_type,
            texts=texts,
            dimensions=dimensions,
            text_total=text_total,
            dim_total=dim_total,
        )
        layouts.append(
            {
                "name": name,
                "texts": text_total[0] - before_t,
                "dims": dim_total[0] - before_d,
            }
        )

    totals = {
        "texts": {"kept": len(texts), "total": text_total[0]},
        "dims": {"kept": len(dimensions), "total": dim_total[0]},
    }
    return (
        {layer: dict(types) for layer, types in by_layer_type.items()},
        texts,
        dimensions,
        totals,
        layouts,
    )


def _extract_named_table(table: Any, *, attr: str = "name") -> list[str]:
    """Generic ``Iterable[Entity] → list[name]`` for text/dim styles + linetypes."""
    out: list[str] = []
    if table is None:
        return out
    try:
        iterable = list(table)
    except TypeError:  # pragma: no cover - upstream variance
        return out
    for entry in iterable:
        try:
            name = str(_safe_attr(entry.dxf, attr, "") or "")
        except Exception:  # pragma: no cover
            continue
        if not name or name.startswith("*"):
            continue
        out.append(name)
        if len(out) >= _MAX_STYLES:
            break
    return out


def _build_summary(doc: Any, file_meta: dict[str, Any]) -> dict[str, Any]:
    """已加载的 ezdxf Document -> 摘要 dict。供 readfile / read 流共享。"""
    layers = _extract_layers(doc)
    by_layer_type, texts, dimensions, totals, layouts = _scan_entities(doc)

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

    text_styles = _extract_named_table(_safe_attr(doc, "styles", None))
    dim_styles = _extract_named_table(_safe_attr(doc, "dimstyles", None))
    linetypes = _extract_named_table(_safe_attr(doc, "linetypes", None))

    truncated = {
        "texts": totals["texts"],
        "dims": totals["dims"],
        "layers_detail": {
            "kept": min(len(layers), _MAX_LAYERS_DETAIL),
            "total": len(layers),
        },
        "blocks": {"kept": len(block_names), "total": len(block_names)},
        "text_styles": {"kept": len(text_styles), "total": len(text_styles)},
        "dim_styles": {"kept": len(dim_styles), "total": len(dim_styles)},
        "linetypes": {"kept": len(linetypes), "total": len(linetypes)},
    }

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
        "text_styles": text_styles,
        "dim_styles": dim_styles,
        "linetypes": linetypes,
        "layouts": layouts,
        "truncated": truncated,
        "limits": {
            "max_texts": _MAX_TEXTS,
            "max_dims": _MAX_DIMS,
            "max_layers_detail": _MAX_LAYERS_DETAIL,
            "max_blocks": _MAX_BLOCKS,
            "max_styles": _MAX_STYLES,
            "max_layouts": _MAX_LAYOUTS,
        },
    }


def _load_doc(path: str | os.PathLike[str]) -> tuple[Any, dict[str, Any]]:
    """加载 CAD 文件（DXF/DWG）为 ezdxf Document。

    自动处理 DWG→DXF 转换（通过 :func:`cad.dwg.resolve_cad_file`）。
    返回 ``(doc, file_meta)`` 供粒度化子函数共用。
    """
    from .dwg import resolve_cad_file  # noqa: PLC0415

    ezdxf = _require_ezdxf()

    file_path = Path(os.fspath(path)).expanduser().resolve(strict=False)
    if not file_path.is_file():
        raise FileNotFoundError(f"文件不存在: {file_path}")

    resolved = resolve_cad_file(file_path)
    is_temp = resolved != file_path

    try:
        doc = ezdxf.readfile(str(resolved))
    except Exception as exc:
        raise DxfParseError(
            f"ezdxf 读取失败: {type(exc).__name__}: {exc}"
        ) from exc
    finally:
        if is_temp:
            try:
                resolved.unlink(missing_ok=True)
            except OSError:
                pass

    file_meta = {
        "path": str(file_path),
        "size_bytes": file_path.stat().st_size,
    }
    return doc, file_meta


def summarize_dxf_overview(path: str | os.PathLike[str]) -> dict[str, Any]:
    """读取 CAD 文件并返回结构化总览摘要。

    包含文件元数据、图层列表（含实体计数）、实体统计、标题块字段等，
    但不含完整的文字/标注/块列表（由专用工具按需取）。
    """
    doc, file_meta = _load_doc(path)

    layers = _extract_layers(doc)
    by_layer_type, texts, dimensions, totals, layouts = _scan_entities(doc)
    layer_counts = {layer: sum(types.values()) for layer, types in by_layer_type.items()}

    text_styles = _extract_named_table(_safe_attr(doc, "styles", None))
    dim_styles = _extract_named_table(_safe_attr(doc, "dimstyles", None))

    # 尝试提取标题块信息
    title_block: dict[str, str | None] = {}
    title_keywords = {"图名", "图号", "审核", "设计", "日期", "比例", "材料", "project", "title", "date", "checked", "designed", "scale", "material"}
    for t in texts:
        content = t.get("text", "").strip()
        layer_name = t.get("layer", "")
        if layer_name and any(kw in layer_name.lower() for kw in ("title", "图框", "标题", "block")):
            for kw in title_keywords:
                if kw.lower() in content.lower() and ":" in content:
                    val = content.split(":", 1)[1].strip()
                    if val:
                        title_block[kw] = val
                    break

    return {
        "file": file_meta,
        "header": _extract_header(doc),
        "layer_count": len(layers),
        "layers": [
            {
                "name": l.name,
                "entity_count": layer_counts.get(l.name, 0),
                "types": dict(by_layer_type.get(l.name, {})),
            }
            for l in layers[:_MAX_LAYERS_DETAIL]
        ],
        "stats": {
            "total_entities": sum(layer_counts.values()),
            "texts": totals["texts"]["total"],
            "dimensions": totals["dims"]["total"],
            "blocks": sum(
                1 for b in doc.blocks  # type: ignore[attr-defined]
                if not str(_safe_attr(b, "name", "")).startswith("*")
            ),
        },
        "title_block": title_block or None,
        "text_styles": text_styles,
        "dim_styles": dim_styles,
    }


def summarize_dxf_texts(
    path: str | os.PathLike[str],
    *,
    layer: str | None = None,
) -> dict[str, Any]:
    """提取 CAD 文件中的文字内容（TEXT + MTEXT）。

    Args:
        path: 工作区相对路径或绝对路径。
        layer: 可选，只提取指定图层的文字。
    """
    doc, file_meta = _load_doc(path)
    _, texts, _, _, _ = _scan_entities(doc)

    if layer:
        texts = [t for t in texts if t.get("layer") == layer]

    return {
        "file": file_meta,
        "count": len(texts),
        "texts": texts,
    }


def summarize_dxf_dims(
    path: str | os.PathLike[str],
    *,
    layer: str | None = None,
) -> dict[str, Any]:
    """提取标注信息（DIMENSION），含测量值、文字覆盖、关联实体。

    Args:
        path: 工作区相对路径或绝对路径。
        layer: 可选，只提取指定图层的标注。
    """
    doc, file_meta = _load_doc(path)
    _, _, dimensions, _, _ = _scan_entities(doc)

    if layer:
        dimensions = [d for d in dimensions if d.get("layer") == layer]

    return {
        "file": file_meta,
        "count": len(dimensions),
        "dimensions": dimensions,
    }


def summarize_dxf_blocks(path: str | os.PathLike[str]) -> dict[str, Any]:
    """提取块定义（BLOCK），含名称、实体组成。

    Args:
        path: 工作区相对路径或绝对路径。
    """
    doc, file_meta = _load_doc(path)

    blocks: list[dict[str, Any]] = []
    for block in doc.blocks:  # type: ignore[attr-defined]
        name = str(_safe_attr(block, "name", ""))
        if not name or name.startswith("*"):
            continue
        entity_types: dict[str, int] = {}
        for entity in block:
            etype = entity.dxftype()
            entity_types[etype] = entity_types.get(etype, 0) + 1
        blocks.append({
            "name": name,
            "entity_count": sum(entity_types.values()),
            "entity_types": entity_types,
        })
        if len(blocks) >= _MAX_BLOCKS:
            break

    return {
        "file": file_meta,
        "count": len(blocks),
        "blocks": blocks,
    }


def summarize_dxf_layer(
    path: str | os.PathLike[str],
    layer: str,
) -> dict[str, Any]:
    """深入检查单个图层：实体类型分布、文字内容、标注值。

    Args:
        path: 工作区相对路径或绝对路径。
        layer: 图层名称。
    """
    doc, file_meta = _load_doc(path)
    by_layer_type, texts, dimensions, _, _ = _scan_entities(doc)

    types = dict(by_layer_type.get(layer, {}))
    layer_texts = [t for t in texts if t.get("layer") == layer]
    layer_dims = [d for d in dimensions if d.get("layer") == layer]

    return {
        "file": file_meta,
        "layer": layer,
        "entity_count": sum(types.values()),
        "entity_types": types,
        "texts": layer_texts,
        "dimensions": layer_dims,
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
