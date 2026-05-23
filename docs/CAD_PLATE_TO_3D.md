# CAD_PLATE_TO_3D — 钢板下料图 2D → 3D

> **版本**：v0.1（2026-05-23）
> **关联**：[ARCH_CAD_REVIEW.md](ARCH_CAD_REVIEW.md)（CAD 浏览/审图）
> **代码**：`wfm-agents/wfm_agents/cad/plate_to_3d.py`、MCP 工具 `cad_plate_to_step` / `cad_plate_inspect`（`wfm_mcp_server.py`）
> **测试**：`wfm-agents/tests/test_cad_plate_to_3d.py`（24 单元 + 1 可选 integration）

---

## 1. 目标与适用场景

把**单视图钢板下料图**（船舶、风电、矿车、电机等行业最常见）自动转成 3D 实体（STEP / STL / GLB）：

```
DWG/DXF ──► 平面外轮廓 (+ 内孔) × 板厚 ──► 3D 实体 ──► STEP
```

**适用**：
- 钢板气割 / 等离子下料零件（"自动气割下料""δ20""t30"标注）
- PCCAD / 中望 / 浩辰等国内 CAD 输出的零件图（标题块为 `PC_TITLE_BLOCK`、图层 `yhsolid / 1轮廓实线层 / yhblx` 等）
- 单一视图：零件几何是"展开/正投影"轮廓 + 可选孔

**不适用**：
- 三视图（主视图 + 俯视图 + 左视图）工程图——需要 view-to-solid reconstruction，难度大一个数量级，不在 v0.1 范围
- 装配图、原理图、电气图
- Logo / 示意图（会被识别并报错，不强行 extrude）

---

## 2. 算法流程

```mermaid
flowchart TD
    A[DWG/DXF 输入] --> B[resolve_cad_file<br/>ezdxf recover → libredwg fallback]
    B --> C[collect_geometry<br/>递归展开 INSERT/BLOCK<br/>按图层/块名黑名单过滤]
    C --> D[build_polygons<br/>snap → linemerge → gap-bridge → polygonize_full]
    D --> E[select_outer_and_holes<br/>面积最大者 = 外轮廓<br/>interiors + 包含的小 polygon = 孔]
    E --> F[detect_thickness<br/>ATTRIB[厚度] → ATTRIB[材料名称] → TEXT 't30'/'δ20'/'厚 25']
    F --> G[build_step<br/>build123d: Polyline → make_face → extrude]
    G --> H[STEP / STL / GLB 输出]

    C -. fallback .-> C2[宽松模式<br/>只过滤 defpoints<br/>SPLINE 简化为端点直线<br/>gap_tol=30mm]
    C2 --> D
```

### 2.1 图层/块名过滤

**默认黑名单**（`_DEFAULT_LAYER_BLACKLIST_RE`）：

| 模式 | 用途 |
|---|---|
| `yhdim.*` / `*dim*` / `*标注*` / `7标注层` | 标注图层 |
| `yhtext.*` / `*text*` / `*文字*` / `6文字层` | 文字图层 |
| `yhcenter.*` / `*中心线*` / `3中心线层` | 中心线 |
| `yhthin.*` / `2细线层` | 工艺辅助细线 |
| `图框.*` / `*虚线*` / `4虚线层` | 图框、虚线 |
| `defpoints` | AutoCAD 内置 |

**不在黑名单（=保留）**：
- `yhsolid` / `1轮廓实线层` —— 主轮廓
- **`yhblx` —— 业内"剥离/破断"波浪线（用 21 点折线画的切边），是零件轮廓的一部分，绝不能过滤**

**块名黑名单 prefix**（`_BLOCK_BLACKLIST_PREFIXES`）：
- `PC_*`、`PCCAD*`、`tukuang*`、`CCD*` —— PCCAD 模板的图框、标题栏、剖切符号块

### 2.2 闭合轮廓拼装（核心算法）

`build_polygons` 四步：

1. **snap**：所有点坐标 round 到 0.05mm 精度（CAD 软件常见"几乎相等"的浮点端点）
2. **linemerge**：把端点共享的 LineString 串成长链。**shapely `unary_union` 不会主动连接相同端点的 LineString**，必须用 `linemerge`
3. **gap-bridge**（`_bridge_dangling_endpoints`）：把 `linemerge` 后仍悬空、距离 ≤ `bridge_gap_tol` mm 的端点用直线对接。修补 CAD 软件常见的 1~20mm 几何缺口、工艺让位口、破断标记缝隙
4. **polygonize_full**：把开链（dangles）从有效多边形中分离

### 2.3 两段式 fallback

| 阶段 | 触发 | 策略 |
|---|---|---|
| 严格模式 | 默认 | 用图层黑名单 + bridge_gap_tol=20mm |
| 宽松模式 | 严格模式拼不出外轮廓，**或**外轮廓面积 < 几何 bbox 的 25% | 所有图层都收 + **SPLINE 简化为端点直线段**（认为是破断/波浪线）+ bridge_gap_tol=30mm |

宽松模式触发时会写一条 warning，提示用户人工核对。

### 2.4 板厚识别

按优先级：

1. **`thickness_mm` 参数显式指定** —— 最高优先级
2. **标题栏 ATTRIB `厚度`/`thickness`/`板厚`** —— 数字字段，直接读
3. **标题栏 ATTRIB `材料名称`**（PCCAD 标准做法）—— 值如 `"30钢板Q235-A"` / `"25mm Q235-A"`，正则抽数字前缀
4. **TEXT/MTEXT 关键字** —— `t30` / `δ20` / `厚 25` / `厚度: 16`，1~200mm 范围内的取出现频率最高的值
5. 都没命中 → 抛 `PlateToCadError` 提示显式指定

### 2.5 3D 建模

`build_step` 用 [`build123d`](https://github.com/gumyr/build123d)（Apache-2.0，OCC 7.x 内核）：

```python
from build123d import Polyline, make_face, extrude, export_step
outer_face = make_face(Polyline(*outer_coords))
for hole_coords in holes:
    outer_face -= make_face(Polyline(*hole_coords))
solid = extrude(outer_face, amount=thickness_mm)
export_step(solid, "output.step")
```

输出格式：

| 格式 | 用途 | 工具 |
|---|---|---|
| **STEP** | 工程交付标准 BREP；CATIA / SolidWorks / Inventor 等可读 | build123d 原生 |
| STL | 3D 打印、网格预览 | build123d 原生 |
| GLB | Web 端 three.js 实时预览 | trimesh 从临时 STL 转 |

---

## 3. 实测结果（用户提供的 4 张 DWG）

```
8EB.130.76315.dwg → 892 × 135 × 30 mm   17.06 kg   (标题栏 25.6 kg；65% 还原)
8EB.130.76316.dwg → 105 × 160 × 25 mm    2.05 kg   (标题栏 2.0  kg；100% ✓)
8EB.130.77150.dwg → 305 × 162 × 30 mm    8.92 kg   (标题栏 39.2 kg；省略画法限制*)
8EB.130.77151.dwg → 305 × 162 × 30 mm    8.92 kg   (77150 的镜像/对应件)
```

*77150/77151 是**省略画法**图：用 6 条 SPLINE 波浪线代表"中间长直段省略"，算法只覆盖图上实际绘出的中间段。会在 `warnings` 里上报，提示人工补完。

---

## 4. MCP 工具

### 4.1 `cad_plate_to_step`

```jsonc
{
  "source_path": "8EB.130.76315.dwg",     // workspace-relative 或绝对路径
  "output_path": "out/76315.step",         // 可选
  "thickness_mm": null,                    // 可选；null = 自动识别
  "also_stl": true,                        // 可选，默认 false
  "also_glb": false,                       // 可选，默认 false
  "layer_whitelist": null                  // 可选；强制只用这些图层
}
```

返回 JSON：

```json
{
  "outputs": {"step": "out/76315.step", "stl": "out/76315.stl"},
  "thickness_mm": 30.0,
  "thickness_source": "title_attrib(ATTRIB[材料名称]='30钢板Q235-A')",
  "outer_bbox_mm": [892.0, 135.0],
  "outer_area_mm2": 72459.2,
  "holes": 0,
  "volume_mm3": 2173775.1,
  "mass_kg_steel": 17.062,
  "layers_used": ["yhblx", "yhsolid"],
  "layers_ignored": ["6文字层", "7标注层", "yhcenter", "yhdim", "yhtext"],
  "blocks_ignored": ["PC_TITLE_BLOCK", "PC_PAPER_BLOCK", "..."],
  "warnings": []
}
```

### 4.2 `cad_plate_inspect`（干跑诊断）

不写文件，只报告"如果我们 extrude，结果会是什么样"。用来排错：

- 板厚没识别 → 看 `thickness_source` 是不是 `unknown`，决定是用 `thickness_mm` 参数还是把 't30' 写进图纸
- 外轮廓太小 → 看 `warnings` 是否有 fallback 提示、`layers_ignored` 是否误过滤了正确层

---

## 5. 已知限制

| 问题 | 现状 | 应对 |
|---|---|---|
| **省略画法图**（SPLINE 破断代表长直段） | 只能拼出图上实际画的部分；77150 案例 8.9 kg vs 标题栏 39.2 kg | 算法会发警告；用户人工补完或要求图纸去除省略 |
| **三视图工程图** | 不支持 | 后续 phase；学界 view-to-solid 问题，复杂度高一个量级 |
| **天正建筑等中国 CAD 插件自定义实体** | LibreDWG 上游不支持 | 让用户先在天正里"另存为 T3" |
| **板厚仅在图签的 BMP/PDF 标签里** | 不支持 OCR | 用 `thickness_mm` 参数显式传 |
| **零件正反面 / 装配方向** | 默认 +Z extrude；下游可能需要翻面 | 单件够用；装配需手工指定 |

---

## 6. 依赖

| 包 | 版本 | License | 用途 |
|---|---|---|---|
| `ezdxf` | ≥ 1.3 | MIT | DXF 读写、INSERT 展开、几何离散化 |
| `shapely` | ≥ 2.0 | BSD-3 | snap / linemerge / polygonize_full |
| `build123d` | ≥ 0.10 | Apache-2.0 | 3D 建模（OCC 7.x 内核）、STEP/STL 导出 |
| `trimesh` | ≥ 4.12 | MIT | GLB 导出 |
| LibreDWG（vendored） | latest | GPL-3.0 | DWG → DXF fallback |

---

## 7. 测试

```bash
cd wfm-agents
# 单元测试（24 个，纯 in-memory DXF）
uv run pytest tests/test_cad_plate_to_3d.py

# 集成测试（用真实 DWG fixtures）
WFM_PLATE_FIXTURES=/path/to/plate-dwgs uv run pytest tests/test_cad_plate_to_3d.py -m integration
```

---

## 8. 后续 phase 候选

- [ ] **省略画法补完**：识别成对破断线，自动合并被分隔的"假独立块"为一块
- [ ] **三视图重建**：投影一致性约束 + 视图对齐 → 实体重建（半自动，需用户标注每个视图的边界）
- [ ] **OCR 板厚 fallback**：把图签区域用 PaddleOCR 识别"δ20"等手写/位图文字
- [ ] **3D 预览前端**：cad-viewer 加 STEP/GLB 加载，让用户在 IDE 里直接看到 extrude 结果
- [ ] **批量转换**：文件夹一键全部转 + 生成 BOM 表（含质量、材料、孔数等）
- [ ] **多板装配体**：识别同一文件夹的关联零件，按标题栏的"装订代号"组装
