# CAD 编辑能力可行性评估

> 评估日期：2026-05-20
> 评估范围：基于当前 WFM Studio 架构（mlightcad + wfm-agents），分析三种 CAD 编辑场景的可行性
> 目标格式：**以 DXF 为主要格式**（不再优先考虑 DWG 编辑）

## 一、底层库 API 能力盘点

`@mlightcad/cad-simple-viewer` + `@mlightcad/data-model` 已提供完整的实体 CRUD API：

| 能力 | API | 状态 |
|---|---|---|
| 实体选择 | `AcEdSelectionSet` (add/delete/clear/has) + 事件监听 | 已实现 |
| 场景删除实体 | `AcTrScene.removeEntity(objectId)` | 可用 |
| 场景添加实体 | `AcTrScene.addEntity(entity)` | 可用 |
| 数据库+场景同步删除 | `AcEdBaseView.removeEntity(entity)` | 可用 |
| 数据库+场景同步添加 | `AcEdBaseView.addEntity(entity)` | 可用 |
| 数据库+场景同步修改 | `AcEdBaseView.updateEntity(entity)` | 可用 |
| 实体类型 | Line, Arc, Circle, Polyline, Text, MText, Hatch, Spline 等 30+ | 可用 |
| DXF 导出 | `AcDbDatabase.dxfOut()` → 完整 DXF 文本 | 可用 |
| 交互式输入 | `AcEditor.getPoint()`, `getAngle()`, `getDistance()`, `getEntity()` | 可用 |
| 命令系统 | `AcEdCommandStack` + `sendStringToExecute()` | 可用 |
| 空间查询 | `pick()`, `search(box)`, `selectByBox()` | 可用 |

结论：底层库能力完全够用，瓶颈不在 API 层面。

## 二、三种编辑场景分析

### 场景 1：选中实体 → 删除

**可行性：高**

当前 viewer.js 右键已被禁用（`contextmenu` 被 `preventDefault()`），右键拖动绑为平移。实现删除有两种方案：

- **方案 A（推荐）**：用键盘 Delete 键删除。实现最简单，不影响现有平移交互。选中实体后按 Delete，调用 `view.removeEntity(selectedEntities)` + `database.dxfOut()` 标脏文件。
- **方案 B**：引入右键上下文菜单。需区分"右键单击"（弹出菜单）和"右键拖动"（平移），通过判断 `mousedown` → `mouseup` 的位移距离来区分。

实现步骤（以方案 A 为例）：

1. `CadViewerEditorInput` 去掉 `Readonly` capability
2. `database.read()` 改为 `readOnly: false`
3. viewer.js 监听 `selectionSet.events.selectionAdded`，跟踪当前选中实体
4. 监听键盘 Delete 事件 → 调用 `view.removeEntity()` 删除
5. 调用 `database.dxfOut()` 生成新 DXF → postMessage 到 main → `IFileService.writeFile()` 保存
6. 添加 undo/redo（最复杂的一步，mlightcad 没有内置 undo 栈）

工作量估算：2-3 天（不含 undo/redo）；加 undo 栈再加 2-3 天。

### 场景 2：其他形式的编辑（移动、修改属性、添加实体）

**可行性：高**

mlightcad 的 Editor API 提供交互式输入机制：

- `editor.getPoint()` — 让用户点击取点
- `editor.getDistance()` — 取距离
- `editor.getAngle()` — 取角度
- `editor.getEntity()` — 选择实体
- `editor.getSelection()` — 框选

可实现的编辑操作：

- **移动**：选中 → `getPoint()` 取基点 → `getPoint()` 取目标点 → `entity.translate(offset)` → `view.updateEntity()`
- **画线**：`getPoint()` 取起点 → `getPoint()` 取终点 → `new AcDbLine(start, end)` → `view.addEntity()`
- **改属性**：选中 → 弹出属性面板 → 修改 layer/color/lineweight → `view.updateEntity()`

主要限制：

- 复杂编辑操作（trim/extend/fillet/chamfer/offset）需要自己实现几何计算，mlightcad 不提供
- Grip 编辑（拖拽控制点）不内置，需自己实现
- 没有 SNAP 的可视化反馈（捕捉标记），但有 `osmode` 系统变量控制捕捉行为

工作量估算：基础编辑（删除/移动/画线/改颜色）约 1 周；完整编辑器级别需要 3-4 周+。

### 场景 3：AI 在指定区域内绘制/设计

**可行性：中高**

架构路径清晰，AI 生成质量是主要不确定性。

实现路径：

```
用户框选区域 → viewer.js 取 bbox 坐标
     ↓ postMessage
main 端 (cadViewerEditor.ts) → wfm-agents /v1/chat
     ↓
AI Agent 分析上下文 + 需求 → 调用 ezdxf/build123d 生成 DXF 实体
     ↓ 返回 DXF 片段或实体描述
main 端 → postMessage 到 webview
     ↓
viewer.js: database 解析新实体 → view.addEntity() → 渲染
```

已有基础设施：

- `third_party/text-to-cad` 支持 build123d 生成 DXF
- `wfm-agents` 已有 `cad_generate_step`、`cad_export_dxf` 工具
- viewer.js 的 `loadDocument()` 已有完整的 DXF 加载流程

关键技术点：

1. **区域上下文提取**：用 `view.search(bbox)` 获取区域内实体，序列化给 AI 作为上下文
2. **增量实体插入**：不需要重载整个文件，用 `database.tables.blockTable.modelSpace.append(entity)` 增量添加
3. **坐标对齐**：AI 生成的实体坐标需与原图坐标系对齐，需在 prompt 里精确描述区域的世界坐标

主要不确定性：

- AI 生成的几何精度能否满足工程要求（所有 AI+CAD 产品的共同挑战）
- 复杂设计可能需要多轮迭代：AI 提案 → 用户审阅 → AI 修改

工作量估算：基础原型 1-2 周；生产可用需持续迭代。

## 三、总体结论

| 维度 | 评估 |
|---|---|
| 底层 API 就绪度 | 非常好。mlightcad 提供了完整的实体 CRUD、交互输入、DXF 序列化 |
| 架构就绪度 | 好。webview + postMessage 的 IPC 通道、agent 通信链路都已打通 |
| 最大缺口 | Undo/Redo（mlightcad 不内置）、复杂几何操作（trim/fillet 等） |
| 推荐优先级 | 先做"选中+Delete 删除"，最小可行，验证整条编辑→保存链路 |

## 四、场景 2 补充：AI 批量修改实体属性（颜色等）

> 讨论日期：2026-05-20

### 典型需求

在船舶 EID 图纸中，让 AI 把所有灯泡统一标红，或把某一类标记批量修改颜色。

### 可行性：高

这条链路比"AI 绘制新实体"要简单得多，因为**不涉及几何生成，只是修改已有实体的属性**。

### 实现路径

```
用户提出需求（"把灯泡标红"）
     ↓
AI 分析 DXF 结构：
  - 扫描图层名（如 LIGHT、LAMP）
  - 扫描块参照名（如 *D-LAMP、LIGHT_BULB）
  - 扫描文本内容（含"灯泡"、"LAMP"的 MTEXT）
  → 输出目标实体 handle 列表 + 新颜色
     ↓
前端按 handle 定位实体 → 修改 color 属性 → view.updateEntity()
     ↓
database.dxfOut() → 写回磁盘
```

### 为什么可行

1. **AI 识别能力已具备**：现有 agent 工具 `cad_extract_blocks`、`cad_extract_texts`、`cad_layer_inspect` 已能提取图层/块/文本信息
2. **实体定位有抓手**：DXF 每个实体都有唯一 handle（十六进制 ID），可作为修改指令的精确索引
3. **属性修改 API 简单**：`entity.color = new AcCmColor(0xFF0000)` → `view.updateEntity(entity)`，一条调用搞定
4. **DXF 文本天然适合 AI**：AI 直接读 DXF 的 ENTITIES 段，用文本匹配就能识别图层、块名、文本内容

### 实体的识别维度

| 维度 | 示例 | 可靠性 |
|---|---|---|
| 图层名 | 图层 "LIGHT" 上的所有实体 | 高（图层是 CAD 最基本的分类） |
| 块参照名 | INSERT 块名含 "LAMP" 的所有实例 | 高（船舶图纸中同类元件通常是同一块） |
| 文本内容 | MTEXT/TEXT 包含 "灯泡"、"LAMP" | 中（文本可能是标注，也可能是说明） |
| 实体类型 | 所有 CIRCLE、ARC | 低（太泛化） |
| AI 语义理解 | AI 根据上下文判断哪些实体代表灯泡 | 中（依赖模型能力和图纸规范性） |

### 与场景 1 的关系

这个场景可以复用场景 1 建立的整条"属性修改 → 保存"链路，区别只是修改的触发者从用户手动操作变成了 AI 指令。建议在场景 1 完成后直接推进。

## 五、DXF 格式优先策略

以 DXF 为主要格式带来的简化：

- **读写路径最短**：DXF 是文本格式，`database.dxfOut()` 直接输出可写回磁盘，无需 WASM 转换
- **AI 友好**：DXF 文本可直接传给 LLM 解析/生成，无需额外序列化
- **调试方便**：文本格式可用 diff 工具比较修改前后差异
- **建议**：编辑模式下仅支持 .dxf 文件；.dwg 文件保持只读查看，用户需先另存为 .dxf 才能编辑
