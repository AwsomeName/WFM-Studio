"""Tests for :mod:`wfm_agents.cad.plate_to_3d`.

Unit tests build small in-memory DXF documents with ``ezdxf`` and exercise the
extraction / extrusion pipeline.  Integration tests against real DWG fixtures
are gated behind the ``integration`` marker and the ``WFM_PLATE_FIXTURES``
environment variable (point it to a folder of ``.dwg`` / ``.dxf`` files).
"""

from __future__ import annotations

import math
import os
from pathlib import Path

import ezdxf
import pytest

from wfm_agents.cad.plate_to_3d import (
    NotAPlateError,
    PlateConvertResult,
    PlateToCadError,
    _bridge_dangling_endpoints,
    _segments_from_entity,
    build_polygons,
    collect_geometry,
    detect_thickness,
    extract_plate_geometry,
    plate_to_step,
    select_outer_and_holes,
)


# ── helpers ──────────────────────────────────────────────────────────


def _new_doc():
    """Fresh DXF doc with a single ``yhsolid`` layer (most common in our 图纸)."""
    doc = ezdxf.new(setup=True)
    doc.layers.add("yhsolid", color=7)
    return doc


def _save(doc, tmp_path: Path, name: str = "drawing.dxf") -> Path:
    p = tmp_path / name
    doc.saveas(str(p))
    return p


def _rect_polyline(msp, x0, y0, x1, y1, *, layer="yhsolid", closed=True):
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    msp.add_lwpolyline(pts, dxfattribs={"layer": layer, "closed": closed})


# ── _segments_from_entity ────────────────────────────────────────────


def test_segments_from_line():
    doc = _new_doc()
    msp = doc.modelspace()
    e = msp.add_line((0, 0), (10, 0), dxfattribs={"layer": "yhsolid"})
    out = _segments_from_entity(e, chord_tol=0.05)
    assert out == [[(0.0, 0.0), (10.0, 0.0)]]


def test_segments_from_arc_quarter_circle():
    doc = _new_doc()
    msp = doc.modelspace()
    e = msp.add_arc(center=(0, 0), radius=10, start_angle=0, end_angle=90,
                    dxfattribs={"layer": "yhsolid"})
    pts = _segments_from_entity(e, chord_tol=0.1)[0]
    assert pts[0] == pytest.approx((10.0, 0.0), abs=0.01)
    assert pts[-1] == pytest.approx((0.0, 10.0), abs=0.01)
    # 90° 弧、chord_tol 0.1mm → 至少 6 段（向上取整保证误差不超）
    assert len(pts) >= 6


def test_segments_from_circle_closes():
    doc = _new_doc()
    msp = doc.modelspace()
    e = msp.add_circle(center=(0, 0), radius=5, dxfattribs={"layer": "yhsolid"})
    pts = _segments_from_entity(e, chord_tol=0.05)[0]
    assert pts[0] == pts[-1]   # 闭合
    assert len(pts) > 20


def test_segments_from_lwpolyline_closed():
    doc = _new_doc()
    msp = doc.modelspace()
    e = msp.add_lwpolyline([(0, 0), (10, 0), (10, 5), (0, 5)],
                           dxfattribs={"layer": "yhsolid", "closed": True})
    pts = _segments_from_entity(e, chord_tol=0.05)[0]
    # 闭合 LWPOLYLINE 会回到起点
    assert pts[0] == pts[-1]


# ── collect_geometry: layer / block filters ──────────────────────────


def test_collect_skips_blacklisted_layers():
    doc = _new_doc()
    doc.layers.add("yhdim", color=2)
    doc.layers.add("yhtext", color=2)
    msp = doc.modelspace()
    msp.add_line((0, 0), (10, 0), dxfattribs={"layer": "yhsolid"})
    msp.add_line((0, 0), (10, 0), dxfattribs={"layer": "yhdim"})    # 应忽略
    msp.add_line((0, 0), (10, 0), dxfattribs={"layer": "yhtext"})   # 应忽略
    msp.add_text("note", dxfattribs={"layer": "yhsolid"})            # 类型黑名单
    pls, counts, ig_lay, _ig_blk = collect_geometry(msp)
    assert len(pls) == 1
    assert "yhdim" in ig_lay and "yhtext" in ig_lay
    assert counts.get("LINE") == 3
    assert counts.get("TEXT") == 1


def test_collect_skips_pccad_blocks():
    doc = _new_doc()
    # 自定义块名以 PC_ 开头：会被忽略
    blk = doc.blocks.new("PC_TITLE_BLOCK")
    blk.add_line((0, 0), (5, 5))
    msp = doc.modelspace()
    msp.add_blockref("PC_TITLE_BLOCK", (0, 0))
    msp.add_line((0, 0), (10, 0), dxfattribs={"layer": "yhsolid"})
    pls, _counts, _ig_lay, ig_blk = collect_geometry(msp)
    assert "PC_TITLE_BLOCK" in ig_blk
    # 只有 modelspace 的那条 LINE
    assert len(pls) == 1


# ── build_polygons / gap bridge / outer & holes ─────────────────────


def test_build_polygons_simple_square():
    """4 个角点的 LINE 直接拼出闭合环"""
    segs = [
        [(0, 0), (10, 0)],
        [(10, 0), (10, 10)],
        [(10, 10), (0, 10)],
        [(0, 10), (0, 0)],
    ]
    polys = build_polygons(segs)
    assert len(polys) == 1
    assert polys[0].area == pytest.approx(100.0, rel=1e-3)


def test_build_polygons_with_5mm_gap_bridges():
    """3 段 LINE + 1 处 5mm 缺口；gap-bridge 应该补上"""
    segs = [
        [(0, 0), (10, 0)],     # 下
        [(15, 0), (15, 10)],   # 右（左端有 5mm 缺口）
        [(15, 10), (0, 10)],   # 上
        [(0, 10), (0, 0)],     # 左
    ]
    polys = build_polygons(segs, bridge_gap_tol=10.0)
    assert len(polys) == 1
    assert polys[0].area == pytest.approx(150.0, rel=0.05)


def test_build_polygons_gap_too_large_not_bridged():
    segs = [
        [(0, 0), (10, 0)],
        [(60, 0), (60, 10)],    # 50mm 缺口
        [(60, 10), (0, 10)],
        [(0, 10), (0, 0)],
    ]
    polys = build_polygons(segs, bridge_gap_tol=10.0)
    assert polys == []


def test_bridge_dangling_endpoints_pairs_nearest():
    from shapely.geometry import LineString
    chains = [
        LineString([(0, 0), (10, 0)]),
        LineString([(15, 0), (25, 0)]),
        LineString([(200, 100), (210, 100)]),
    ]
    out = _bridge_dangling_endpoints(chains, gap_tol=8.0)
    # 期望补一条 (10,0)-(15,0)（距离 5mm，<gap_tol）
    # 远端 200,100 处的两端互相 10mm > gap_tol，且与近端组距离 >> gap_tol → 不连
    assert len(out) == len(chains) + 1


def test_select_outer_and_holes_picks_largest():
    from shapely.geometry import Polygon
    outer = Polygon([(0, 0), (100, 0), (100, 100), (0, 100)])    # 1e4
    hole = Polygon([(40, 40), (60, 40), (60, 60), (40, 60)])      # 400
    other = Polygon([(200, 200), (210, 200), (210, 210), (200, 210)])  # 远离
    chosen, holes = select_outer_and_holes([outer, hole, other])
    assert chosen.equals(outer)
    assert len(holes) == 1
    assert holes[0].equals(hole)


def test_select_outer_raises_on_empty():
    with pytest.raises(NotAPlateError):
        select_outer_and_holes([])


# ── detect_thickness：4 条优先级 ─────────────────────────────────────


def test_detect_thickness_override_wins():
    doc = _new_doc()
    val, src = detect_thickness(doc, override=12.0)
    assert val == 12.0 and src == "param"


def test_detect_thickness_from_text_t30():
    doc = _new_doc()
    msp = doc.modelspace()
    msp.add_text("t30 自动气割下料", dxfattribs={"layer": "yhsolid"})
    val, src = detect_thickness(doc)
    assert val == 30.0
    assert "text_token" in src


def test_detect_thickness_from_text_delta20():
    doc = _new_doc()
    msp = doc.modelspace()
    msp.add_text("δ20 Q235-A", dxfattribs={"layer": "yhsolid"})
    val, src = detect_thickness(doc)
    assert val == 20.0


def test_detect_thickness_from_text_厚25():
    doc = _new_doc()
    msp = doc.modelspace()
    msp.add_text("厚 25 mm", dxfattribs={"layer": "yhsolid"})
    val, src = detect_thickness(doc)
    assert val == 25.0


def test_detect_thickness_from_material_attrib():
    """PCCAD 标题栏 ATTRIB '材料名称' = '30钢板Q235-A' → 30 mm"""
    doc = _new_doc()
    blk = doc.blocks.new("PC_TITLE_BLOCK")
    blk.add_attdef("材料名称", insert=(0, 0))
    msp = doc.modelspace()
    ref = msp.add_blockref("PC_TITLE_BLOCK", (0, 0))
    ref.add_auto_attribs({"材料名称": "30钢板Q235-A"})
    val, src = detect_thickness(doc)
    assert val == 30.0
    assert "ATTRIB" in src
    assert "材料名称" in src


def test_detect_thickness_unknown():
    doc = _new_doc()
    val, src = detect_thickness(doc)
    assert val is None
    assert src == "unknown"


# ── extract_plate_geometry: end-to-end on in-memory DXF ─────────────


def test_extract_plate_geometry_rect_with_thickness(tmp_path):
    doc = _new_doc()
    msp = doc.modelspace()
    _rect_polyline(msp, 0, 0, 100, 50)
    msp.add_text("t10", dxfattribs={"layer": "yhsolid",
                                     "insert": (10, 10)})
    p = _save(doc, tmp_path)
    outer, holes, ext = extract_plate_geometry(p)
    assert outer.area == pytest.approx(5000.0, rel=1e-3)
    assert holes == []
    assert ext.thickness_mm == 10.0


def test_extract_plate_geometry_with_hole(tmp_path):
    doc = _new_doc()
    msp = doc.modelspace()
    _rect_polyline(msp, 0, 0, 100, 100)
    # 一个内圆孔，r=10
    msp.add_circle(center=(50, 50), radius=10,
                   dxfattribs={"layer": "yhsolid"})
    msp.add_text("t8", dxfattribs={"layer": "yhsolid"})
    p = _save(doc, tmp_path)
    outer, holes, _ext = extract_plate_geometry(p)
    # outer 已重建为"纯外环"，面积 = 100×100，不含孔
    assert outer.area == pytest.approx(10000.0, rel=1e-3)
    assert len(holes) == 1
    assert holes[0].area == pytest.approx(math.pi * 100, rel=0.02)


def test_extract_raises_when_no_closed_outline(tmp_path):
    doc = _new_doc()
    # 几条不闭合的直线，不构成环
    msp = doc.modelspace()
    msp.add_line((0, 0), (10, 0), dxfattribs={"layer": "yhsolid"})
    msp.add_line((20, 5), (30, 5), dxfattribs={"layer": "yhsolid"})
    p = _save(doc, tmp_path)
    with pytest.raises(NotAPlateError):
        extract_plate_geometry(p)


# ── plate_to_step：端到端写 STEP / STL ─────────────────────────────


def test_plate_to_step_writes_files(tmp_path):
    doc = _new_doc()
    msp = doc.modelspace()
    _rect_polyline(msp, 0, 0, 200, 100)
    msp.add_text("t6", dxfattribs={"layer": "yhsolid"})
    dxf = _save(doc, tmp_path, "plate.dxf")
    step = tmp_path / "plate.step"
    stl = tmp_path / "plate.stl"
    r = plate_to_step(dxf, step, also_stl=stl)
    assert isinstance(r, PlateConvertResult)
    assert step.is_file() and step.stat().st_size > 0
    assert stl.is_file() and stl.stat().st_size > 0
    # 200 × 100 × 6 mm = 120000 mm³
    assert r.volume_mm3 == pytest.approx(120000.0, rel=0.02)
    assert r.mass_g_steel == pytest.approx(120000.0 * 7.85e-3, rel=0.02)


def test_plate_to_step_thickness_override(tmp_path):
    doc = _new_doc()
    msp = doc.modelspace()
    _rect_polyline(msp, 0, 0, 50, 50)
    # 不写任何板厚标注
    dxf = _save(doc, tmp_path, "plate.dxf")
    step = tmp_path / "plate.step"
    r = plate_to_step(dxf, step, thickness_mm=15.0)
    assert r.extract.thickness_source == "param"
    assert r.extract.thickness_mm == 15.0


def test_plate_to_step_missing_thickness_raises(tmp_path):
    doc = _new_doc()
    msp = doc.modelspace()
    _rect_polyline(msp, 0, 0, 50, 50)
    dxf = _save(doc, tmp_path, "plate.dxf")
    step = tmp_path / "plate.step"
    with pytest.raises(PlateToCadError, match="板厚"):
        plate_to_step(dxf, step)


# ── 集成测试：真实 DWG fixtures ─────────────────────────────────────


_FIXTURE_DIR = os.environ.get("WFM_PLATE_FIXTURES")


@pytest.mark.integration
@pytest.mark.skipif(
    not _FIXTURE_DIR or not Path(_FIXTURE_DIR).is_dir(),
    reason="set WFM_PLATE_FIXTURES to a folder with sample .dwg files",
)
def test_integration_all_fixtures(tmp_path):
    """跑遍 WFM_PLATE_FIXTURES 里所有 .dwg/.dxf，断言：
    每一张都能生成非空 STEP + STL，外轮廓面积 > 100 mm² 且板厚被识别。
    """
    files = sorted(Path(_FIXTURE_DIR).glob("*.dwg")) + sorted(
        Path(_FIXTURE_DIR).glob("*.dxf"),
    )
    assert files, "fixture dir is empty"
    for src in files:
        step = tmp_path / f"{src.stem}.step"
        stl = tmp_path / f"{src.stem}.stl"
        try:
            r = plate_to_step(src, step, also_stl=stl)
        except (NotAPlateError, PlateToCadError) as exc:
            pytest.fail(f"{src.name}: {exc}")
        assert step.is_file() and step.stat().st_size > 0, src.name
        assert r.extract.thickness_mm and r.extract.thickness_mm > 0
        assert r.extract.outer_area_mm2 > 100
