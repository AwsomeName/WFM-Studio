"""钢板下料图 2D → 3D：DWG/DXF 平面轮廓 → 挤出板厚 → STEP/STL/GLB。

适用场景
--------

**单视图钢板/板材零件下料图**（船舶、机械、风电、矿车等行业典型）。
图纸只画零件的"展开/正投影"轮廓，配一处板厚标注（如 ``t30``，"自动气割下料"）。
这类零件 3D 模型 = ``闭合外轮廓 (+ 内孔轮廓) × 板厚``，可全自动重建。

**不适用**：
- 三视图（主/俯/左）工程图——需要"view-to-solid"算法，不在本模块范围
- 装配图、原理图、电气图
- Logo / 示意图（本模块会拒绝并报告原因）

主要流程
--------

1. :func:`resolve_cad_file`（来自 :mod:`.dwg`）把 .dwg 转成 .dxf
2. :func:`collect_geometry` 递归扁平化 INSERT/BLOCK，按图层/块名黑名单丢掉
   图框、标题栏、PCCAD 模板块、标注/文字
3. :func:`build_polygons` 用 shapely ``polygonize`` 找到所有闭合面，最大面
   即外轮廓，被它包含的小面为孔
4. :func:`detect_thickness` 从 TITLE_BLOCK ATTRIB → TEXT regex（``t30``/
   ``厚度 30``）按优先级抽板厚
5. :func:`build_step` 用 build123d 构造 ``Sketch → extrude`` 得到 3D 实体，
   ``export_step / export_stl`` 落盘

设计原则
--------
- **黑名单优先**：图层/块名匹配业内常见命名（yhdim、6文字层、PC_*、tukuang*…），
  默认排除；用户也可用 ``layer_whitelist`` 强制只看几个图层
- **可观察性**：所有判断（板厚来源、丢掉了哪些图层、为什么不像零件）写进
  :class:`PlateExtractResult.warnings`，不要悄悄吞错
- **可分步**：解析、几何、板厚三步分开，方便测试和未来扩展
"""

from __future__ import annotations

import logging
import math
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

_log = logging.getLogger(__name__)

# ── 常量 / 默认配置 ───────────────────────────────────────────────────

#: 弧 / 样条曲线离散化的弦高误差（mm）。
#: 0.05mm 对 t≥6 的钢板已远小于切割精度，且让 polygonize 拼环时更稳。
DEFAULT_CHORD_TOL_MM = 0.05

#: 几何实体类型白名单：只有这些会参与轮廓拼装。
_GEOMETRY_TYPES = frozenset({
    "LINE", "LWPOLYLINE", "POLYLINE",
    "ARC", "CIRCLE", "ELLIPSE", "SPLINE",
})

#: 图层名黑名单（正则、不区分大小写）。匹配的图层一律忽略。
#:
#: - ``yhdim`` / ``*标注*`` / ``*dim*`` —— 标注图层
#: - ``yhtext`` / ``6文字层`` / ``*文字*`` / ``*text*`` —— 文字图层
#: - ``图框*`` —— 图框、标题栏辅助层
#: - ``Defpoints`` —— AutoCAD 内置不可见层
#: - ``yhcenter`` / ``*中心线*`` / ``yhthin`` —— 中心线、细线（轮廓不在这里）
#:
#: **不在黑名单**：
#: - ``yhblx`` —— 业内是"剥离/破断"波浪线，**属于零件轮廓的一部分**（钢板的
#:   削边、自由边切割口都画在这里），切不可过滤。
#: - ``yhsolid`` / ``1轮廓实线层`` —— 主轮廓
_DEFAULT_LAYER_BLACKLIST_RE = re.compile(
    r"^("
    r"yhdim.*|yhtext.*|yhcenter.*|yhthin.*"
    r"|.*dim.*|.*text.*|.*文字.*|.*标注.*|.*中心线.*|.*虚线.*"
    r"|图框.*|7标注层|6文字层|4虚线层|2细线层|3中心线层"
    r"|defpoints"
    r")$",
    re.IGNORECASE,
)

#: 块名黑名单 prefix：扁平化 INSERT 时跳过这些块（图框、标题栏、PCCAD 模板）。
_BLOCK_BLACKLIST_PREFIXES = (
    "PC_", "PCCAD", "tukuang", "CCD",
)

#: 标题栏 ATTRIB 里"板厚"字段可能用的 tag 名（小写比较）。
_THICKNESS_ATTRIB_TAGS = frozenset({
    "thickness", "厚度", "板厚", "t", "hd", "houdu",
})

#: PCCAD / 国内通用标题栏的"材料名称"字段 tag。值形如
#: ``"30钢板Q235-A"``——前缀数字就是板厚（mm）。
_MATERIAL_ATTRIB_TAGS = frozenset({
    "材料名称", "材料", "material", "mtl", "material_name",
})

#: 从"材料名称"字段（``30钢板Q235-A`` / ``δ12 Q345B`` / ``25mm Q235``）
#: 抽板厚的正则。优先匹配 ``XX钢板`` / ``XXmm`` 等明确格式。
_MATERIAL_THICKNESS_RE = re.compile(
    r"(?:^|[\s，,])"
    r"(?:δ\s*|t\s*|厚\s*(?:度)?\s*)?"
    r"(\d{1,3}(?:\.\d+)?)"
    r"\s*"
    r"(?:mm|MM|毫米|钢板|铁板|铜板|铝板|不锈钢|板|厚)",
)

#: TEXT/MTEXT 板厚识别正则。
#: 形如 ``t30``、``t 12``、``t=8``、``δ20``、``厚 25``、``厚度: 16``。
_THICKNESS_TEXT_RE = re.compile(
    r"(?:\bt\s*[=＝:：]?\s*(\d{1,3}(?:\.\d+)?)\b"
    r"|δ\s*[=＝:：]?\s*(\d{1,3}(?:\.\d+)?)"
    r"|厚\s*(?:度)?\s*[=＝:：]?\s*(\d{1,3}(?:\.\d+)?))",
    re.IGNORECASE,
)


# ── 错误类型 ──────────────────────────────────────────────────────────

class PlateToCadError(RuntimeError):
    """钢板 2D→3D 转换失败（无外轮廓 / 板厚未识别 / build123d 失败等）。"""


class NotAPlateError(PlateToCadError):
    """这张图不像钢板零件下料图（例如 Logo、示意图、空白图）。"""


# ── 结果类型 ──────────────────────────────────────────────────────────

@dataclass
class PlateExtractResult:
    """``extract_plate_geometry`` 的诊断结果（不含几何对象本身）。"""

    file: str
    thickness_mm: float | None
    thickness_source: str   # "param" | "title_attrib" | "text_token" | "unknown"
    outer_loop_points: int
    holes: int
    outer_bbox_mm: tuple[float, float] = (0.0, 0.0)
    outer_area_mm2: float = 0.0
    layers_considered: list[str] = field(default_factory=list)
    layers_ignored: list[str] = field(default_factory=list)
    blocks_ignored: list[str] = field(default_factory=list)
    raw_entity_counts: dict[str, int] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


@dataclass
class PlateConvertResult:
    """``plate_to_step`` 的端到端结果。"""

    source: str
    outputs: dict[str, str]   # {"step": "/abs/path", "stl": "...", ...}
    extract: PlateExtractResult
    volume_mm3: float
    mass_g_steel: float       # 估算质量（按 7.85 g/cm³ 钢密度）


# ── 实体收集 + 离散化 ────────────────────────────────────────────────

def _layer_excluded(
    layer: str,
    *,
    whitelist: Sequence[str] | None,
    blacklist_re: re.Pattern[str],
) -> bool:
    if whitelist:
        return layer not in whitelist
    return bool(blacklist_re.match(layer or ""))


def _block_excluded(block_name: str) -> bool:
    return any(block_name.upper().startswith(p.upper()) for p in _BLOCK_BLACKLIST_PREFIXES)


def _arc_to_segments(
    cx: float, cy: float, r: float,
    start_deg: float, end_deg: float,
    chord_tol: float,
) -> list[tuple[float, float]]:
    """把圆弧按弦高 ≤ chord_tol 离散化成折线点列表（含起止点）。

    端点角度按 AutoCAD 约定（逆时针、度）。
    """
    if r <= 0:
        return []
    # 归一化使 end >= start（逆时针扫过）
    while end_deg < start_deg:
        end_deg += 360.0
    sweep = math.radians(end_deg - start_deg)
    if sweep <= 0:
        return []
    # 弦高 s = r (1 - cos(theta/2)) → theta = 2 acos(1 - s/r)
    s = min(chord_tol, r * 0.99)
    try:
        step = 2 * math.acos(1 - s / r)
    except ValueError:
        step = math.pi / 8
    step = max(step, math.pi / 360)   # 至少 1°
    n = max(2, int(math.ceil(sweep / step)) + 1)
    pts: list[tuple[float, float]] = []
    a0 = math.radians(start_deg)
    for i in range(n):
        t = a0 + sweep * (i / (n - 1))
        pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    return pts


def _segments_from_entity(entity: Any, chord_tol: float) -> list[list[tuple[float, float]]]:
    """把单个 DXF 实体扁平成一组折线（每条是 [(x,y), ...]）。

    返回 list of polylines（每条 ≥ 2 点）。
    """
    t = entity.dxftype()
    out: list[list[tuple[float, float]]] = []
    try:
        if t == "LINE":
            s = entity.dxf.start
            e = entity.dxf.end
            out.append([(float(s.x), float(s.y)), (float(e.x), float(e.y))])
        elif t == "LWPOLYLINE":
            pts = [(float(x), float(y)) for x, y, *_ in entity.get_points("xyseb")]
            # 处理 bulge（弧段）
            if entity.has_arc:
                from ezdxf.math import bulge_to_arc  # noqa: PLC0415
                bulges = [b for _, _, _, _, b in entity.get_points("xyseb")]
                resolved: list[tuple[float, float]] = []
                n = len(pts)
                for i in range(n):
                    p0 = pts[i]
                    resolved.append(p0)
                    p1 = pts[(i + 1) % n] if entity.closed else (pts[i + 1] if i + 1 < n else None)
                    if p1 is None:
                        break
                    b = bulges[i]
                    if abs(b) < 1e-9:
                        continue
                    try:
                        center, _, _, radius = bulge_to_arc(p0, p1, b)
                        a0 = math.degrees(math.atan2(p0[1] - center.y, p0[0] - center.x))
                        a1 = math.degrees(math.atan2(p1[1] - center.y, p1[0] - center.x))
                        if b < 0:
                            a0, a1 = a1, a0
                        arc_pts = _arc_to_segments(center.x, center.y, radius, a0, a1, chord_tol)
                        resolved.extend(arc_pts[1:-1])  # 去掉端点（pts 里已有）
                    except Exception:  # pragma: no cover - 极端 bulge
                        continue
                pts = resolved
            if entity.closed and len(pts) >= 3:
                pts = list(pts) + [pts[0]]
            if len(pts) >= 2:
                out.append(list(pts))
        elif t == "POLYLINE":
            # 2D POLYLINE 可以含弧段 bulge；polyface/polymesh 这里跳过。
            if entity.is_3d_polyline or entity.is_polygon_mesh or entity.is_poly_face_mesh:
                return out
            try:
                pts = [(float(p.x), float(p.y)) for p in entity.flattening(chord_tol)]
            except Exception:
                pts = []
                for v in entity.vertices:
                    loc = v.dxf.location
                    pts.append((float(loc.x), float(loc.y)))
            if entity.is_closed and len(pts) >= 3 and pts[0] != pts[-1]:
                pts.append(pts[0])
            if len(pts) >= 2:
                out.append(pts)
        elif t == "ARC":
            pts = _arc_to_segments(
                float(entity.dxf.center.x), float(entity.dxf.center.y),
                float(entity.dxf.radius),
                float(entity.dxf.start_angle), float(entity.dxf.end_angle),
                chord_tol,
            )
            if len(pts) >= 2:
                out.append(pts)
        elif t == "CIRCLE":
            pts = _arc_to_segments(
                float(entity.dxf.center.x), float(entity.dxf.center.y),
                float(entity.dxf.radius), 0.0, 360.0, chord_tol,
            )
            if len(pts) >= 3:
                # 闭合
                pts.append(pts[0])
                out.append(pts)
        elif t == "ELLIPSE":
            try:
                pts = [(float(p.x), float(p.y)) for p in entity.flattening(chord_tol)]
                if len(pts) >= 2:
                    out.append(pts)
            except Exception:
                pass
        elif t == "SPLINE":
            try:
                pts = [(float(p[0]), float(p[1])) for p in entity.flattening(chord_tol)]
                if len(pts) >= 2:
                    out.append(pts)
            except Exception:
                pass
    except Exception as exc:  # pragma: no cover - 防御
        _log.debug("ignoring entity %s: %s", t, exc)
    return out


def collect_geometry(
    msp: Any,
    *,
    layer_whitelist: Sequence[str] | None = None,
    layer_blacklist_re: re.Pattern[str] = _DEFAULT_LAYER_BLACKLIST_RE,
    chord_tol: float = DEFAULT_CHORD_TOL_MM,
    straighten_splines: bool = False,
) -> tuple[list[list[tuple[float, float]]], dict[str, int], list[str], list[str]]:
    """递归展开 modelspace 中的所有 INSERT/BLOCK，按图层/块名过滤，
    返回（折线列表、原始实体类型计数、忽略的图层、忽略的块）。

    Args:
        straighten_splines: 把 SPLINE 实体简化为其首末两点的**直线段**。
            钢板下料图里 SPLINE 99% 是"破断线/波浪线"（用波浪图省略
            画长边），其首末端正好对应被省略的真实直边端点；用直线
            代替它们就能让主轮廓重新闭合。fallback 模式下启用。
    """
    polylines: list[list[tuple[float, float]]] = []
    entity_counts: dict[str, int] = {}
    ignored_layers: set[str] = set()
    ignored_blocks: set[str] = set()

    def _walk(entity: Any) -> None:
        t = entity.dxftype()
        entity_counts[t] = entity_counts.get(t, 0) + 1

        if t == "INSERT":
            bname = entity.dxf.name or ""
            if _block_excluded(bname):
                ignored_blocks.add(bname)
                return
            # 递归展开 block 内实体（已应用 INSERT 变换）
            try:
                for sub in entity.virtual_entities():
                    _walk(sub)
            except Exception as exc:  # pragma: no cover
                _log.debug("virtual_entities() failed for %s: %s", bname, exc)
            return

        layer = entity.dxf.layer if hasattr(entity, "dxf") else ""
        if _layer_excluded(layer, whitelist=layer_whitelist, blacklist_re=layer_blacklist_re):
            ignored_layers.add(layer)
            return

        if t not in _GEOMETRY_TYPES:
            return

        if straighten_splines and t == "SPLINE":
            try:
                flat = list(entity.flattening(chord_tol))
                if len(flat) >= 2:
                    polylines.append([
                        (float(flat[0].x), float(flat[0].y)),
                        (float(flat[-1].x), float(flat[-1].y)),
                    ])
            except Exception:  # pragma: no cover
                pass
            return

        polylines.extend(_segments_from_entity(entity, chord_tol))

    for e in msp:
        _walk(e)

    return polylines, entity_counts, sorted(ignored_layers), sorted(ignored_blocks)


# ── 多边形拼装 ───────────────────────────────────────────────────────

def _bridge_dangling_endpoints(
    chains: Sequence,
    *,
    gap_tol: float,
) -> list:
    """把链条端点中距离 < ``gap_tol`` 的悬空端点用直线段桥接。

    钢板下料图常见做法：用"破断线/波浪线"代替小段直边，导致主轮廓在 CAD
    层级上有 1~20 mm 的几何缺口。本函数贪心地把每个悬空端点连到最近的
    另一个悬空端点（同一个端点只用一次）。

    Args:
        chains: 输入 LineString 列表。
        gap_tol: 桥接距离上限（mm）。> 此距离的缺口不补，避免错误连接
            孔与边界。
    """
    from shapely.geometry import LineString  # noqa: PLC0415

    if gap_tol <= 0 or not chains:
        return list(chains)

    # 统计每个端点出现的次数；degree==1 → dangling
    from collections import Counter  # noqa: PLC0415
    endpoint_count: Counter = Counter()
    for ls in chains:
        coords = list(ls.coords)
        endpoint_count[coords[0]] += 1
        endpoint_count[coords[-1]] += 1

    dangling = [pt for pt, c in endpoint_count.items() if c == 1]
    if len(dangling) < 2:
        return list(chains)

    # 贪心配对：按距离从小到大配对，每个点只用一次
    used: set = set()
    pairs: list[tuple[tuple, tuple]] = []
    candidates: list[tuple[float, tuple, tuple]] = []
    for i, p1 in enumerate(dangling):
        for p2 in dangling[i + 1:]:
            dx, dy = p2[0] - p1[0], p2[1] - p1[1]
            d = (dx * dx + dy * dy) ** 0.5
            if 0 < d <= gap_tol:
                candidates.append((d, p1, p2))
    candidates.sort()
    for _d, p1, p2 in candidates:
        if p1 in used or p2 in used:
            continue
        pairs.append((p1, p2))
        used.add(p1)
        used.add(p2)

    out = list(chains)
    for p1, p2 in pairs:
        out.append(LineString([p1, p2]))
    return out


def build_polygons(
    polylines: Sequence[Sequence[tuple[float, float]]],
    *,
    snap_tol: float = 0.05,
    bridge_gap_tol: float = 20.0,
):
    """用 shapely 把折线集合拼成多边形列表（按面积降序）。

    关键算法：

    1. **端点 snap**：所有点坐标 round 到 ``snap_tol`` mm 精度，让浮点接近
       但不严格相等的端点（CAD 软件常见）能配对。
    2. **linemerge**：把端点共享的 LineString 串成长链——shapely
       ``unary_union`` 在端点完全相同的情况下不会主动连接，必须用
       ``linemerge``。
    3. **gap-bridge**：把 ``linemerge`` 后仍悬空、距离 ≤
       ``bridge_gap_tol`` mm 的端点用直线对接，修补破断线/工艺缺口。
    4. **polygonize_full**：把开链（dangles）从有效多边形中分离，避免
       焊缝/标记等附件线段污染主轮廓。

    返回 list of ``shapely.Polygon``，第一个是外轮廓。
    """
    from shapely.geometry import LineString, MultiLineString  # noqa: PLC0415
    from shapely.ops import linemerge, polygonize_full, unary_union  # noqa: PLC0415

    def _snap(p: tuple[float, float]) -> tuple[float, float]:
        return (round(p[0] / snap_tol) * snap_tol,
                round(p[1] / snap_tol) * snap_tol)

    lines = []
    for pl in polylines:
        if len(pl) < 2:
            continue
        snapped = [_snap(p) for p in pl]
        # 去掉连续重复点（snap 后可能出现）
        deduped = [snapped[0]]
        for p in snapped[1:]:
            if p != deduped[-1]:
                deduped.append(p)
        if len(deduped) < 2:
            continue
        try:
            ls = LineString(deduped)
        except Exception:
            continue
        if ls.is_empty or ls.length <= 0:
            continue
        lines.append(ls)
    if not lines:
        return []

    merged = linemerge(MultiLineString(lines))
    chains: list = list(merged.geoms) if hasattr(merged, "geoms") else [merged]

    # 桥接悬空端点（修补破断/工艺缺口）
    if bridge_gap_tol > 0:
        chains = _bridge_dangling_endpoints(chains, gap_tol=bridge_gap_tol)
        # 再次 linemerge 以让新桥接段和原链合并
        merged = linemerge(MultiLineString(chains))
        if isinstance(merged, LineString):
            merged = MultiLineString([merged])
    else:
        merged = MultiLineString(chains)

    # polygonize_full 把 dangles 和 invalids 分离出来，主轮廓更稳。
    polygons, _cuts, _dangles, _invalids = polygonize_full(merged)
    result = list(polygons.geoms) if hasattr(polygons, "geoms") else []

    # 如果 polygonize_full 没拼出来，回退到 unary_union + polygonize：
    # 处理"线段相交但端点不重合"的情况（noding）。
    if not result:
        from shapely.ops import polygonize  # noqa: PLC0415
        noded = unary_union(merged)
        if isinstance(noded, LineString):
            noded = MultiLineString([noded])
        result = list(polygonize(noded))

    result.sort(key=lambda p: p.area, reverse=True)
    return result


def select_outer_and_holes(polygons: Sequence) -> tuple[Any, list]:
    """从多边形列表中挑外轮廓 + 内孔。

    策略：

    1. 面积最大的 Polygon 为外轮廓——但**只取它的外环**（``exterior``），
       忽略它自带的 ``interiors``（shapely ``polygonize_full`` 会把封闭
       内圈直接作为 hole 塞进外环 Polygon）。
    2. 把 1 中外环转成新 ``Polygon``（无 hole）作为返回的 outer。
    3. 内孔 = ``outer.interiors`` + 列表里其它**完全位于 outer 内**且面积
       合理（> 0.01 mm²）的独立 Polygon（图纸里圆孔可能用独立 CIRCLE 实体
       画的，也可能用线段拼的）。
    """
    from shapely.geometry import Polygon  # noqa: PLC0415

    if not polygons:
        raise NotAPlateError("没有拼出任何闭合多边形（图层过滤后无几何）。")

    largest = polygons[0]
    # 重建 outer：只用外环，丢掉它自带的 interior
    outer = Polygon(list(largest.exterior.coords))

    # 1) largest 的 interior 是 shapely 自动检出的孔
    interior_holes: list = [Polygon(list(r.coords)) for r in largest.interiors]

    # 2) polygons[1:] 中被 outer 包含的独立 polygon 也可能是孔，
    # 但要去掉与 interior 重复的（shapely polygonize_full 经常把
    # 一个孔同时报告成"largest 的 interior"+"独立 disk polygon"）。
    def _same_hole(a, b, tol=0.05) -> bool:
        if abs(a.area - b.area) > max(0.5, tol * max(a.area, b.area)):
            return False
        return a.centroid.distance(b.centroid) < 1.0   # mm

    extra_holes: list = []
    for p in polygons[1:]:
        if p.area < 0.01:
            continue
        if not outer.contains(p):
            continue
        if any(_same_hole(p, h) for h in interior_holes):
            continue
        extra_holes.append(p)

    return outer, interior_holes + extra_holes


# ── 板厚识别 ─────────────────────────────────────────────────────────

def _attrib_thickness(doc: Any) -> tuple[float | None, str | None]:
    """扫所有 INSERT 的 ATTRIB，按以下优先级抽板厚：

    1. **专用厚度字段**（``厚度``/``thickness``/``t``…）—— 值就是数字。
    2. **材料名称字段**（``材料名称`` = ``"30钢板Q235-A"``）—— 用
       :data:`_MATERIAL_THICKNESS_RE` 抽数字前缀（PCCAD 等国内标题栏的
       标准做法）。
    """
    material_candidate: tuple[float, str] | None = None
    try:
        for insert in doc.modelspace().query("INSERT"):
            for attr in insert.attribs:
                tag_raw = (attr.dxf.tag or "").strip()
                tag = tag_raw.lower()
                val = (attr.dxf.text or "").strip()
                if not val:
                    continue
                if tag in _THICKNESS_ATTRIB_TAGS:
                    m = re.search(r"(\d+(?:\.\d+)?)", val)
                    if m:
                        return float(m.group(1)), f"ATTRIB[{tag_raw}]={val!r}"
                # 材料名称兜底
                if material_candidate is None and (
                    tag in _MATERIAL_ATTRIB_TAGS or tag_raw in _MATERIAL_ATTRIB_TAGS
                ):
                    m = _MATERIAL_THICKNESS_RE.search(val) or re.match(
                        r"\s*(\d{1,3}(?:\.\d+)?)", val,
                    )
                    if m:
                        v = float(m.group(1))
                        if 1.0 <= v <= 200.0:
                            material_candidate = (
                                v, f"ATTRIB[{tag_raw}]={val!r}",
                            )
    except Exception:  # pragma: no cover
        return None, None
    if material_candidate is not None:
        return material_candidate
    return None, None


def _text_thickness(doc: Any) -> tuple[float | None, str | None]:
    """扫所有 TEXT / MTEXT 找 ``t30`` / ``δ20`` / ``厚 25`` 形式。"""
    candidates: list[tuple[float, str]] = []
    try:
        for e in doc.modelspace():
            t = e.dxftype()
            if t == "TEXT":
                content = (e.dxf.text or "").strip()
            elif t == "MTEXT":
                content = (e.text or "").strip()
            else:
                continue
            for m in _THICKNESS_TEXT_RE.finditer(content):
                val = next((g for g in m.groups() if g), None)
                if val:
                    try:
                        v = float(val)
                    except ValueError:
                        continue
                    if 1.0 <= v <= 200.0:   # 钢板厚度合理范围 1~200mm
                        candidates.append((v, content))
    except Exception:  # pragma: no cover
        pass
    if not candidates:
        return None, None
    # 取出现频率最高的值（同一板厚可能在标题、技术要求里重复）
    from collections import Counter  # noqa: PLC0415
    c = Counter(v for v, _ in candidates)
    best, _count = c.most_common(1)[0]
    snippet = next(s for v, s in candidates if v == best)
    return best, f"TEXT={snippet!r}"


def detect_thickness(
    doc: Any,
    *,
    override: float | None = None,
) -> tuple[float | None, str]:
    """综合 ATTRIB → TEXT 抽板厚 mm。``override`` 非 None 时直接返回。"""
    if override is not None:
        return float(override), "param"
    v, src = _attrib_thickness(doc)
    if v is not None:
        return v, f"title_attrib({src})"
    v, src = _text_thickness(doc)
    if v is not None:
        return v, f"text_token({src})"
    return None, "unknown"


# ── 端到端 ───────────────────────────────────────────────────────────

def extract_plate_geometry(
    dxf_path: Path,
    *,
    layer_whitelist: Sequence[str] | None = None,
    chord_tol: float = DEFAULT_CHORD_TOL_MM,
    thickness_override: float | None = None,
):
    """从 DXF 文件解析钢板几何 + 板厚。

    Returns:
        ``(outer_polygon, hole_polygons, PlateExtractResult)``

    Raises:
        :class:`NotAPlateError`: 无法拼出任何外轮廓（图是 Logo / 空图等）。

    实施细节
    --------

    采用**两段式 fallback** 选层：

    1. **严格模式**（默认）：按 :data:`_DEFAULT_LAYER_BLACKLIST_RE` 排除标注/
       文字/图框层；适合"轮廓单独建层"的规范图纸（如 76315 配 yhblx 破断线）。
    2. **宽松模式**（当 1 拼不出闭合环时自动启用）：只过滤图框/标题栏类块
       和 ``Defpoints``；其余图层全部收，依赖实体类型白名单过滤掉 DIMENSION/
       TEXT。适合"破断线散布在 yhdim 等标注层里"的图纸（如 77150）。

    用户传 ``layer_whitelist`` 时直接生效，不再走 fallback。
    """
    import ezdxf  # noqa: PLC0415

    try:
        doc = ezdxf.readfile(str(dxf_path))
    except ezdxf.DXFStructureError as exc:
        # 走 recover 模式再试一次
        try:
            from ezdxf import recover  # noqa: PLC0415
            doc, _ = recover.readfile(str(dxf_path))
        except Exception:
            raise PlateToCadError(f"DXF 解析失败: {exc}") from exc

    msp = doc.modelspace()

    def _polylines_bbox(pls):
        if not pls:
            return None
        xs = [x for pl in pls for x, _ in pl]
        ys = [y for pl in pls for _, y in pl]
        return (min(xs), min(ys), max(xs), max(ys))

    # 第一阶段：严格黑名单
    polylines, counts, ig_layers, ig_blocks = collect_geometry(
        msp, layer_whitelist=layer_whitelist, chord_tol=chord_tol,
    )
    polygons = build_polygons(polylines)
    relaxed = False

    # fallback 触发条件：
    # (a) 完全拼不出闭合环；或
    # (b) 拼出来了但最大外轮廓 bbox << 收集到的所有几何 bbox（< 25% 面积），
    #     说明真正主轮廓被卡在了某个标注层里
    bbox_geom = _polylines_bbox(polylines)
    should_fallback = layer_whitelist is None and (
        not polygons
        or (
            bbox_geom
            and polygons
            and polygons[0].area > 0
            and (
                polygons[0].area
                < 0.25 * max(
                    1.0,
                    (bbox_geom[2] - bbox_geom[0]) * (bbox_geom[3] - bbox_geom[1]),
                )
            )
        )
    )
    if should_fallback:
        relaxed = True
        _log.info("plate_to_3d: 启用宽松模式（严格模式未拼出合理外轮廓）")
        loose_blacklist = re.compile(r"^defpoints$", re.IGNORECASE)
        # 宽松模式 = 所有图层都收 + SPLINE 用直线段简化（破断线拉直）
        # + 桥接更宽缺口
        polylines_loose, counts_loose, ig_layers_loose, ig_blocks_loose = collect_geometry(
            msp, layer_whitelist=None,
            layer_blacklist_re=loose_blacklist,
            chord_tol=chord_tol,
            straighten_splines=True,
        )
        polygons_loose = build_polygons(polylines_loose, bridge_gap_tol=30.0)
        # 取两者中外轮廓更大的（避免 fallback 反而变差）
        loose_area = polygons_loose[0].area if polygons_loose else 0
        strict_area = polygons[0].area if polygons else 0
        if loose_area > strict_area:
            polylines, counts, ig_layers, ig_blocks = (
                polylines_loose, counts_loose, ig_layers_loose, ig_blocks_loose,
            )
            polygons = polygons_loose

    if not polygons:
        raise NotAPlateError(
            "未找到任何闭合外轮廓。可能是：(1) Logo / 示意图，"
            "(2) 轮廓在被过滤的图层里——尝试 layer_whitelist 强制指定，"
            "(3) 轮廓由未闭合的折线组成。"
        )

    outer, holes = select_outer_and_holes(polygons)
    minx, miny, maxx, maxy = outer.bounds

    thickness, thickness_src = detect_thickness(doc, override=thickness_override)

    warnings: list[str] = []
    if relaxed:
        warnings.append(
            "启用宽松图层过滤（fallback）才拼出闭合外轮廓——可能少数标注层的"
            "辅助线被当成了几何。请人工核对结果尺寸是否合理。"
        )
    spline_count = counts.get("SPLINE", 0)
    if spline_count >= 2:
        warnings.append(
            f"图纸含 {spline_count} 条 SPLINE，常见为'破断/省略画法'。当前结果"
            "只覆盖图上实际绘出的几何；如果零件实际由破断省略了一长段，请人工"
            "确认输出 STEP 是真实零件的全长或只是中间一段，必要时手工补齐。"
        )
    if thickness is None:
        warnings.append(
            "板厚未识别。请在调用时显式传入 thickness_mm，"
            "或在图纸文字里写明 't30' / '厚 30' / 标题栏厚度字段。"
        )
    if outer.area < 100:  # < 1 cm²
        warnings.append(
            f"外轮廓面积仅 {outer.area:.1f} mm²，可能不是真正的零件主轮廓。"
        )

    result = PlateExtractResult(
        file=str(dxf_path),
        thickness_mm=thickness,
        thickness_source=thickness_src,
        outer_loop_points=len(outer.exterior.coords),
        holes=len(holes),
        outer_bbox_mm=(maxx - minx, maxy - miny),
        outer_area_mm2=outer.area,
        layers_considered=sorted({
            entity.dxf.layer
            for entity in msp
            if hasattr(entity, "dxf") and hasattr(entity.dxf, "layer")
            and not _layer_excluded(entity.dxf.layer, whitelist=layer_whitelist,
                                    blacklist_re=_DEFAULT_LAYER_BLACKLIST_RE)
        }),
        layers_ignored=ig_layers,
        blocks_ignored=ig_blocks,
        raw_entity_counts=counts,
        warnings=warnings,
    )
    return outer, holes, result


def _polygon_to_b3d_face(outer, holes):
    """把 shapely Polygon → build123d Face（带孔）。

    用 ``Polyline + make_face`` 路线（build123d 0.10 兼容）。
    """
    from build123d import (  # noqa: PLC0415
        Polyline, make_face, Vector,
    )

    def _coords(geom):
        return [Vector(float(x), float(y), 0.0) for x, y in list(geom.coords)]

    outer_face = make_face(Polyline(*_coords(outer.exterior)))
    if holes:
        hole_faces = [make_face(Polyline(*_coords(h.exterior))) for h in holes]
        for hf in hole_faces:
            outer_face = outer_face - hf
    return outer_face


def build_step(
    outer,
    holes,
    thickness_mm: float,
    output_step: Path,
    *,
    also_stl: Path | None = None,
    also_glb: Path | None = None,
):
    """用 build123d 构造 ``Sketch → extrude``，写出 STEP / 可选 STL/GLB。

    Returns:
        ``(volume_mm3, {format: path})``
    """
    from build123d import (  # noqa: PLC0415
        extrude, export_step, export_stl,
    )

    if thickness_mm <= 0:
        raise PlateToCadError(f"板厚必须为正数: {thickness_mm}")

    face = _polygon_to_b3d_face(outer, holes)
    solid = extrude(face, amount=thickness_mm)

    output_step.parent.mkdir(parents=True, exist_ok=True)
    export_step(solid, str(output_step))

    outputs: dict[str, str] = {"step": str(output_step)}

    if also_stl is not None:
        also_stl.parent.mkdir(parents=True, exist_ok=True)
        export_stl(solid, str(also_stl))
        outputs["stl"] = str(also_stl)

    if also_glb is not None:
        # build123d 没有内建 GLB；用 trimesh 从临时 STL 转
        try:
            import trimesh  # noqa: PLC0415
        except ImportError as exc:
            raise PlateToCadError("缺少 trimesh，无法导出 GLB") from exc
        tmp_stl = Path(tempfile.mkstemp(suffix=".stl", prefix="wfm_plate_")[1])
        try:
            export_stl(solid, str(tmp_stl))
            mesh = trimesh.load(str(tmp_stl), force="mesh")
            also_glb.parent.mkdir(parents=True, exist_ok=True)
            mesh.export(str(also_glb))
            outputs["glb"] = str(also_glb)
        finally:
            tmp_stl.unlink(missing_ok=True)

    try:
        volume = float(solid.volume)
    except Exception:
        volume = float(outer.area * thickness_mm) - sum(
            float(h.area * thickness_mm) for h in holes
        )

    return volume, outputs


def plate_to_step(
    source_path: Path,
    output_step: Path,
    *,
    thickness_mm: float | None = None,
    also_stl: Path | None = None,
    also_glb: Path | None = None,
    layer_whitelist: Sequence[str] | None = None,
    chord_tol: float = DEFAULT_CHORD_TOL_MM,
) -> PlateConvertResult:
    """端到端：``DWG/DXF → STEP``（可选附带 STL / GLB）。

    Args:
        source_path: 输入文件（.dwg 或 .dxf）。
        output_step: 输出 STEP 文件路径。
        thickness_mm: 显式板厚（mm）；为 ``None`` 时自动识别。
        also_stl / also_glb: 同时输出 STL / GLB 路径（可选）。
        layer_whitelist: 仅保留这些图层的几何；为 ``None`` 时用默认黑名单。
        chord_tol: 弧/样条曲线离散化弦高（mm）。

    Raises:
        :class:`NotAPlateError`: 图纸不像钢板零件下料图。
        :class:`PlateToCadError`: 板厚未识别且未显式指定、或建模失败。
    """
    from .dwg import resolve_cad_file  # noqa: PLC0415

    dxf_path = resolve_cad_file(Path(source_path))

    outer, holes, extract = extract_plate_geometry(
        dxf_path,
        layer_whitelist=layer_whitelist,
        chord_tol=chord_tol,
        thickness_override=thickness_mm,
    )

    if extract.thickness_mm is None:
        raise PlateToCadError(
            "无法识别板厚。请用 thickness_mm 参数显式指定（单位 mm），"
            "或在图纸标注里加 't30' / '厚 30' / 标题栏 ATTRIB 厚度字段。"
        )

    volume, outputs = build_step(
        outer, holes, extract.thickness_mm,
        output_step, also_stl=also_stl, also_glb=also_glb,
    )

    return PlateConvertResult(
        source=str(source_path),
        outputs=outputs,
        extract=extract,
        volume_mm3=volume,
        mass_g_steel=volume * 7.85e-3,   # 钢密度 7.85 g/cm³ = 7.85e-3 g/mm³
    )


__all__ = [
    "DEFAULT_CHORD_TOL_MM",
    "NotAPlateError",
    "PlateConvertResult",
    "PlateExtractResult",
    "PlateToCadError",
    "build_polygons",
    "build_step",
    "collect_geometry",
    "detect_thickness",
    "extract_plate_geometry",
    "plate_to_step",
    "select_outer_and_holes",
]
