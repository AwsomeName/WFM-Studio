# "智研链"辅助设计智能体 — 可行性评估报告（修订版）

> 基于 WFM Studio 当前架构 + VSCode 插件能力 + Claude Code MCP/Skills/Hooks 扩展能力，逐个评估《智研链-辅助设计产品规划-V3》中 20 个工业设计助手的可实现性。

---

## 评估基准：扩展后的能力全景

### 已有能力

| 能力 | 来源 | 说明 |
|------|------|------|
| AI Chat + Tool Calling | WFM Agent | OpenAI Agents SDK，Router → 专家 Agent Handoff |
| Text-to-CAD | WFM Agent | build123d 代码生成 → STEP 3D 模型，渲染 PNG |
| CAD 图纸审查 (8 工具) | WFM Agent | DXF/DWG 解析，图层/文本/尺寸/标注块提取，结构化报告 |
| DOCX 文档审查 | WFM Agent | Word 文档解析，金额交叉核对 |
| DWG/DXF 浏览器 | WFM IDE | WASM 内嵌 Viewer，MTEXT 渲染 |
| DOCX 浏览器 | WFM IDE | 内嵌 Word 预览 |
| 文件读写 (沙箱) | WFM Agent | workspace_read / workspace_write |
| SSE 流式输出 | WFM Agent | Chat Panel 实时渲染 |

### VSCode 插件新增能力

| 能力 | API | 应用 |
|------|-----|------|
| **3D 模型渲染/交互** | Webview + Three.js / OpenCascade.js | STEP/STL 浏览、旋转、剖面、干涉高亮 |
| **自定义编辑器** | CustomEditorProvider | STEP/DXF/PCB 等任意格式的可视化编辑 |
| **虚拟文件系统** | FileSystemProvider | 挂载 PLM/ERP 后端为虚拟目录 |
| **树形视图** | TreeDataProvider | BOM 树、PLM 文档树、物料分类树 |
| **双向消息通信** | Webview postMessage | 标注/批注交互、点击实体触发 AI 分析 |
| **MCP 服务器注册** | McpServerDefinitionProvider | 从插件注册 PLM/CAD MCP 工具给 Claude Code |
| **自定义 Diff** | TextEditor / Webview | 两个 DXF/STEP 版本的可视化对比 |

### Claude Code 扩展新增能力

| 能力 | 机制 | 应用 |
|------|------|------|
| **自定义 Skills (斜杠命令)** | `.claude/skills/*.md` | `/bom-extract`、`/dfm-check`、`/standard-query` |
| **MCP 工具服务器** | stdio / HTTP MCP | 封装 build123d、pythonOCC、ezdxf、RAG 为结构化工具 |
| **Hooks (生命周期钩子)** | PreToolUse / PostToolUse / FileChanged | 文件保存自动触发 CAD 校验、自动索引新文件 |
| **Bash 任意 Python** | Claude Code Bash 工具 | 调用 pythonOCC、scipy、trimesh 等任意库 |
| **Web 搜索/抓取** | WebSearch / WebFetch | 竞品调研、标准查询、供应商数据抓取 |
| **子 Agent 并行** | Agent 工具 | 批量处理多个 CAD 文件、并行审图 |
| **定时任务** | CronCreate | 定时跑批量校验、数据同步 |
| **RAG 知识库** | MCP Server + 向量数据库 | 设计标准、历史项目、物料规格的语义检索 |

### 关键补充：pythonOCC (OpenCascade Python 绑定)

这是能力跃升的关键。通过 MCP Server 封装 pythonOCC，可以解锁：
- **STEP 文件导入/解析** — 读取 SolidWorks/Creo 输出的 STEP 模型
- **布尔运算/干涉检测** — 两个实体是否重叠
- **壁厚分析** — 射线法测量最小壁厚
- **拔模角检测** — 面法向量与开模方向夹角
- **倒扣/底切检测** — 面片投影分析
- **3D 模型 diff** — 两个 STEP 版本几何差异
- **2D 投影生成** — 从 3D 模型自动出 2D 视图

### 关键补充：KiCAD MCP Server + KiCad Studio（EDA 能力）

通过 KiCAD MCP Server 和 KiCad Studio VSCode 扩展，解锁 PCB/电气设计能力：
- **KiCAD MCP Server** — 完整 PCB 设计自动化：原理图编辑、元件放置、走线、DRC/ERC、自定义符号/封装、JLCPCB 元器件查询、Freerouting 自动布线
- **KiCad Studio（VSCode 扩展）** — 原理图/PCB 查看、DRC/ERC 执行、BOM/网表检查、生产文件导出（Gerber/IPC-2581/ODB++/DXF/BOM/3D GLB）
- **Freerouting** — 开源自动布线器，支持 Specctra DSN 格式交互
- **mcp4eda** — EDA 工作流 MCP 服务器集合，扩展 EDA 工具链

---

## 评估结论汇总

| # | 智能体名称 | 可行性 | 核心结论 |
|---|-----------|--------|----------|
| 1 | 研发任务拆解助手 | 🟢 可行 | LLM + RAG 解析 PRD，生成 WBS |
| 2 | 软件架构拆解助手 | 🟢 可行 | 纯文档/代码生成，直接支持 |
| 3 | 结构设计优化助手 | 🟡 部分可行 | pythonOCC 可做基础拓扑，但不如专业求解器 |
| 4 | 结构布局与干涉检查助手 | 🟢 可行 | pythonOCC 布尔运算 + OpenCascade.js 可视化 |
| 5 | PCB/PCBA 智能设计助手 | 🟢 可行 | KiCAD MCP Server + KiCad Studio + Freerouting 全链路打通 |
| 6 | 电气智能设计助手 | 🟡 部分可行 | KiCad 原理图编辑 + MCP 可做基础电气设计 |
| 7 | 智能物料选型助手 | 🟡 部分可行 | RAG 物料库 + CAD 参数提取，缺实时供应链 |
| 8 | 2D 工程图助手 | 🟢 可行 | build123d + pythonOCC 出图，RAG 辅助标注 |
| 9 | BOM 智能生成与校验助手 | 🟡 部分可行 | CAD 文本提取 + RAG 匹配 ERP 编码 |
| 10 | 配方智能优化助手 | 🟡 部分可行 | scipy 求解器 + RAG 配方库 |
| 11 | 设计标准智能查询助手 | 🟢 可行 | RAG MCP Server，直接可做 |
| 12 | 设计变更影响分析助手 | 🟡 部分可行 | ezdxf/pythonOCC 做 DXF/STEP diff |
| 13 | DFM 验证助手 | 🟡 部分可行 | pythonOCC 壁厚/拔模角检测 + RAG 规则 |
| 14 | DFMEA 设计风险研判助手 | 🟢 可行 | LLM 生成 + RAG 历史失效库 |
| 15 | 仿真预处理助手 | 🔴 不可行 | 需要 CAE 求解器 + 网格引擎 |
| 16 | 测试脚本生成助手 | 🟢 可行 | 纯文本生成，直接支持 |
| 17 | 研发知识推荐助手 | 🟢 可行 | RAG + CAD 特征向量检索 |
| 18 | PRD 助手 | 🟢 可行 | 纯文档生成，直接支持 |
| 19 | 市场调研助手 | 🟢 可行 | WebSearch + WebFetch + LLM 分析 |
| 20 | 产品评估助手 | 🟡 部分可行 | LLM 评分 + RAG，缺专利库 API |

**统计：🟢 可行 10 个 | 🟡 部分可行 9 个 | 🔴 不可行 1 个**

**对比初版评估：🟢 从 3 → 10（翻 3.3 倍）| 🔴 从 11 → 1（减少 91%）**

---

## 逐项详细评估

### 1. 研发任务拆解助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行** |
| **能做的** | ① `docx_read` 读取 PRD → LLM 解析生成结构化 WBS 任务清单；② RAG 检索历史项目任务拆分数据，辅助任务拆分更合理；③ 输出 JSON/Markdown/Excel 格式，可手动导入 PLM。 |
| **实现路径** | 新增 `task_decompose_agent` → 读取 PRD → RAG 查询类似项目 → 生成 WBS + 工期估算 + 依赖关系图（Mermaid）。通过 MCP 暴露为 `/task-decompose` Skill。 |
| **做不了的** | 自动对接 PLM 派发（Phase 2，需 PLM API）。 |
| **工作量** | 2-3 周 |

---

### 2. 软件架构拆解助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行** |
| **能做的** | ① `docx_read` 读 PRD；② `workspace_write` 输出模块图（Mermaid/PlantUML）、接口定义（C++/TS Header）、代码框架；③ IDE 直接展示和编辑生成结果。 |
| **实现路径** | 新增 `software_arch_agent`，Skill `/arch-generate`。 |
| **做不了的** | 自动创建 IDE 工程（需用户手动）。 |
| **工作量** | 1-2 周 |

---

### 3. 结构设计优化助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟡 **部分可行** |
| **能做的** | ① pythonOCC 可做基础的拓扑优化（SIMP 方法），通过 MCP Server 封装为工具；② build123d 可生成参数化轻量化结构（蜂窝、加强筋、减重孔）；③ OpenCascade.js 在 Webview 中可视化对比优化前后模型；④ trimesh 可做基础的质量/体积计算辅助多目标权衡。 |
| **做不了的** | ① 不如 Altair OptiStruct / ANSYS 的专业求解器精度；② 无法做多物理场耦合优化（热-结构耦合等）；③ 大规模模型（10 万+ 单元）求解速度慢。 |
| **实现路径** | **Phase 1**：封装 pythonOCC 拓扑优化为 MCP 工具 `cad_topology_optimize`，输入载荷/约束 → 输出优化后的 STEP。**Phase 2**：集成开源求解器（如 FEniCS、CalculiX）提升精度。 |
| **工作量** | Phase 1：4-6 周；Phase 2：2-3 个月 |

---

### 4. 结构布局与干涉检查助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行**（关键能力已具备） |
| **能做的** | ① **pythonOCC 可导入 STEP 文件并做布尔运算** — 两个实体 BRepAlgoAPI_Common（交集非空 = 干涉）；② **OpenCascade.js 在 Webview 中渲染 3D 模型** — 高亮干涉区域、剖面查看；③ **trimesh 可做包围盒级别的快速碰撞检测** — 作为粗筛；④ MCP 封装为 `cad_interference_check` 工具 → Claude Code 直接调用。 |
| **实现路径** | ① 新建 MCP Server（`cad_analysis_server.py`），封装 pythonOCC 干涉检测、间隙检测；② VSCode 插件中用 OpenCascade.js 渲染结果，红色高亮干涉区域；③ 新增 Skill `/interference-check`。 |
| **做不了的** | 无法自动识别"多专业接口关系"（这需要 PLM 数据），但纯几何干涉检测完全可以做。 |
| **工作量** | 3-4 周 |

---

### 5. PCB/PCBA 智能设计助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行**（KiCAD 生态全链路打通） |
| **能做的** | ① **KiCAD MCP Server** — 完整的 PCB 设计自动化：原理图编辑（添加/删除/修改元件、网络连接）、PCB 元件放置、走线、DRC/ERC 检查、自定义符号/封装生成；② **KiCad Studio（VSCode 扩展）** — 在 IDE 内直接查看原理图/PCB、运行 DRC/ERC、检查 BOM/网表、导出生产文件（Gerber、IPC-2581、ODB++、DXF、BOM、3D GLB/BREP/PLY）；③ **Freerouting 集成** — KiCAD MCP Server 内置 Freerouting 自动布线器，支持 Specctra DSN 格式交互；④ **JLCPCB 集成** — 直接从 KiCAD 查询立创商城元器件库存、价格、数据手册；⑤ **Claude Code 可直接调用 MCP 工具** — `place_component`、`route_traces`、`run_drc`、`export_gerber` 等。 |
| **实现路径** | ① 部署 KiCAD MCP Server（Python，stdio 协议）→ Claude Code 注册为 MCP 工具；② 安装 KiCad Studio VSCode 扩展 → 在 WFM IDE 内查看 PCB；③ Skill `/pcb-design` → 自然语言描述需求 → Claude 调用 MCP 工具生成原理图 + PCB；④ 新增 `pcb_agent` 处理 PCB 相关请求。 |
| **实测验证** | 社区已验证 Claude Code + pcb-rnd + Freerouting 完成 Arduino Shield PCB 全流程设计（TinyComputers.io），证明 LLM 驱动 PCB 设计切实可行。 |
| **做不了的** | ① Altium/Cadence 私有格式直接操作（需导入 KiCad 格式）；② 高速信号完整性仿真（需专业 SI 工具）。 |
| **工作量** | 3-4 周（部署 KiCAD MCP + KiCad Studio 扩展 + Skill/Prompt 工程） |

---

### 6. 电气智能设计助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟡 **部分可行**（KiCad 原理图能力 + Python 电气计算） |
| **能做的** | ① **KiCad Eeschema（通过 KiCAD MCP Server）** — 可创建和编辑电气原理图：放置电气符号（电阻/电容/IC/连接器）、建立网络连接、ERC 规则检查；② **KiCad 自带数千个电气符号库** — 覆盖常用元器件的 IEC/ANSI 标准符号；③ **Python 电气计算 MCP 工具** — 短路电流计算（IEC 60909）、电缆选型（载流量/压降）、保护配合校验；④ **RAG 查询电气设计规范**（GB 50054、IEC 60364 等）；⑤ **KiCad Studio 在 VSCode 内查看原理图** — 不需要额外 EDA 软件。 |
| **做不了的** | ① 不支持 EPLAN/AutoCAD Electrical 专有格式（但 KiCad 可导入/导出网表）；② 大型工业电气系统设计（配电系统图、控制柜布局）不如 EPLAN 专业；③ 没有 PLC 编程集成。 |
| **实现路径** | **Phase 1**：KiCAD MCP Server 原理图编辑 + Python 电气计算 MCP 工具 → 基础电路设计 + 电气校验。**Phase 2**：RAG 索引电气符号库 + 企业电气模板 → 自动生成标准电路拓扑。 |
| **工作量** | Phase 1：4-6 周；Phase 2：3-4 周 |

---

### 7. 智能物料选型助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟡 **部分可行** |
| **能做的** | ① **RAG 索引企业物料数据库**（供应商提供的 Excel/CSV 导入向量数据库）→ 自然语言查询匹配物料；② **CAD 工具提取设计参数**（`cad_extract_dims`、`cad_extract_texts` 从图纸提取规格参数）→ 自动生成物料查询条件；③ LLM 多维度推荐排序（价格、交期、库存权重可配置）；④ MCP Server 暴露 `search_material`、`compare_materials` 工具。 |
| **做不了的** | ① 无法实时获取供应商库存/价格（需供应链系统 API）；② 无法在 SolidWorks/Creo 中实时监控设计参数（需 CAD 插件）；③ 无法自动匹配 ERP 编码（需 ERP 数据库对接）。 |
| **实现路径** | **Phase 1**：MCP Server + RAG，用户输入参数 → 搜索物料库 → 输出推荐列表。**Phase 2**：对接供应商 API 获取实时数据。**Phase 3**：VSCode 插件检测图纸参数自动触发选型。 |
| **工作量** | Phase 1：3-4 周；Phase 2-3：需外部系统配合 |

---

### 8. 2D 工程图助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行** |
| **能做的** | ① **build123d 已支持 DXF 导出**（`cad_export_dxf` 工具）；② **pythonOCC 可从 STEP 模型自动生成多视图 2D 投影**（HLR 算法：隐藏线消除）；③ **ezdxf 可在 DXF 中添加尺寸标注、公差标注、粗糙度符号**；④ RAG 索引企业标注规范，辅助 LLM 推荐"该标什么、怎么标"；⑤ VSCode Webview 渲染 DXF 预览。 |
| **实现路径** | ① MCP 封装 pythonOCC 的 HLRBRep_Algo 投影为 `cad_project_2d` 工具；② MCP 封装 ezdxf 标注能力为 `cad_annotate_dxf` 工具；③ 新增 `drawing_agent` → 输入 STEP 文件 → 输出带标注的 DXF；④ Skill `/generate-drawing`。 |
| **做不了的** | 从 SolidWorks/Creo 原生格式直接出图（需 STEP 中转）。 |
| **工作量** | 4-6 周（含 pythonOCC 投影工具 + ezdxf 标注工具 + prompt 工程） |

---

### 9. BOM 智能生成与校验助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟡 **部分可行** |
| **能做的** | ① **现有 8 个 CAD 审查工具已能从 DXF/DWG 提取**：标题栏信息（`cad_check_titleblock`）、文本/物料描述（`cad_extract_texts`）、标注块（`cad_extract_blocks`）、尺寸（`cad_extract_dims`）；② **RAG 索引 ERP 物料编码表** → LLM 匹配提取到的物料描述与 ERP 编码；③ 输出结构化 BOM 表（JSON/Excel）。 |
| **做不了的** | ① 无法从 3D 装配体自动提取零件层级关系（需 STEP 装配体解析，pythonOCC 可部分支持）；② 无法自动同步到 PLM/ERP 系统。 |
| **实现路径** | **Phase 1**：组合现有 CAD 审查工具 + RAG 物料编码库 → 从 2D 图纸标题栏提取 BOM。**Phase 2**：pythonOCC 解析 STEP 装配体 → 提取零件层级。 |
| **工作量** | Phase 1：3-4 周；Phase 2：4-6 周 |

---

### 10. 配方智能优化助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟡 **部分可行** |
| **能做的** | ① **scipy.optimize / PuLP 求解器**通过 Bash 工具直接调用 — 线性规划、多目标优化；② **RAG 索引历史配方数据库** → LLM 推荐初始配比范围；③ LLM 解释优化结果，生成配方报告。 |
| **做不了的** | ① 无物性预测模型（需要 domain-specific ML 模型）；② 无法直接对接实验室 IoT 数据。 |
| **实现路径** | MCP Server 封装 `formula_optimize` 工具（输入约束 → scipy 求解 → 输出最优配比）+ RAG 配方数据库。 |
| **工作量** | 3-4 周（需要 domain 专家提供配方数据和约束模型） |

---

### 11. 设计标准智能查询助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行** |
| **能做的** | ① **RAG MCP Server** 直接封装向量数据库 → 自然语言检索标准文档；② Claude Code Bash 可调用外部标准库 API；③ Skill `/standard-query` 一键查询；④ MCP 暴露 `search_standards`、`get_standard_detail` 工具。 |
| **实现路径** | ① 搭建 RAG 管线（ChromaDB/LanceDB + embedding）；② 将企业标准、国标、行标文档切片索引；③ 封装为 MCP Server；④ 新增 Skill。 |
| **做不了的** | 悬浮窗 UI（受限于 VSCode 形态，但可用 Side Panel 替代）。 |
| **工作量** | 2-3 周（RAG 基础设施）+ 持续的文档维护 |

---

### 12. 设计变更影响分析助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟡 **部分可行** |
| **能做的** | ① **ezdxf 可对比两个 DXF 文件的差异** — 实体增删、图层变化、尺寸变化、文本修改；② **pythonOCC 可对比两个 STEP 文件的几何差异** — 面/边/顶点变化；③ 现有 `cad_check_naming` + `cad_check_titleblock` 可检测版本号变化；④ VSCode 自定义 Diff Viewer 可视化展示差异。 |
| **做不了的** | ① 无法追踪"零件 → 图纸 → 工艺 → 工装"的完整影响链（需 PLM 数据）；② 无法自动生成 ECN 并推送审批。 |
| **实现路径** | **Phase 1**：MCP 封装 DXF diff 工具 + STEP diff 工具 → 输出变更差异报告。**Phase 2**：对接 PLM API 获取关联文档列表。 |
| **工作量** | Phase 1：3-4 周 |

---

### 13. DFM 验证助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟡 **部分可行** |
| **能做的** | ① **pythonOCC 可做 3D 几何分析**：壁厚检测（BRepExtrema_DistShapeShape）、拔模角检测（面法向量 vs 开模方向）、倒扣检测（投影分析）；② **RAG 索引企业 DFM 规范** → LLM 判断是否违规、推荐修正方案；③ trimesh 可做网格级的壁厚分析和可视化。 |
| **做不了的** | ① 精度不如专业 DFM 软件（如 Moldflow）；② 注塑模流分析（需专业求解器）；③ 复杂曲面（自由曲面/NURBS）的分析精度有限。 |
| **实现路径** | MCP Server 封装 pythonOCC DFM 分析为 `cad_dfm_check` 工具（输入 STEP + 工艺类型 → 输出问题清单 + 位置坐标）+ RAG DFM 规则库。OpenCascade.js 在 Webview 中高亮问题区域。 |
| **工作量** | 4-6 周 |

---

### 14. DFMEA 设计风险研判助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行** |
| **能做的** | ① LLM 生成失效模式枚举（结构化输出 S/O/D 评分 + RPN）；② RAG 检索企业历史失效库 → 数据驱动提升评分准确度；③ 输出标准 DFMEA 表格（Markdown/Excel）；④ 可读取 PRD/CAD 文件提取功能和结构信息作为输入。 |
| **实现路径** | 新增 `dfmea_agent` → 读取 PRD/CAD → RAG 检索历史失效 → 生成 DFMEA 表。Skill `/dfmea-generate`。 |
| **做不了的** | 在线多人协同编辑（需 PLM/Web 平台）。 |
| **工作量** | 2-3 周 |

---

### 15. 仿真预处理助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🔴 **不可行** |
| **核心原因** | 仿真预处理的核心是：① **网格划分引擎** — Gmsh/TetGen 可做（有 Python 库），但需要专业配置；② **几何清理** — pythonOCC 可做基础的去特征/补面；③ **CAE 求解器集成** — 需要对接 ANSYS/OpenFOAM/CalculiX，这是最大瓶颈。几何清理 + 网格划分可以做，但无法提供"一键出仿真模型"的完整体验。 |
| **能做的（有限）** | ① pythonOCC 做 STEP 几何简化（去倒角/圆角/小孔）；② Gmsh 生成基础网格；③ LLM 推荐边界条件设置参数。但无法直接喂给 CAE 求解器。 |
| **替代建议** | 做"仿真参数建议助手" + STEP 几何简化工具，作为 CAE 工程师的辅助工具。 |
| **实现难度** | 完整版需 CAE 求解器集成，工作量 4-6 个月。 |

---

### 16. 测试脚本生成助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行** |
| **能做的** | ① LLM 根据 PRD 生成测试用例 + 测试步骤 + 预期结果；② `docx_read` 读取 PRD → 提取功能需求；③ `workspace_write` 输出 Python/Shell 测试脚本 + Markdown 测试报告模板；④ VSCode Testing API 可集成测试执行结果展示。 |
| **实现路径** | 新增 `test_script_agent`，Skill `/generate-test`。 |
| **工作量** | 1-2 周 |

---

### 17. 研发知识推荐助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行** |
| **能做的** | ① RAG 索引历史设计文档 → 语义检索相似方案；② CAD 审查工具提取图纸结构化特征（图层、实体类型、尺寸范围）→ 向量化 → "以图找图"；③ LLM 总结推荐理由、关联设计经验。 |
| **实现路径** | RAG MCP Server（向量数据库 + 文档索引管线）+ CAD 特征提取 MCP 工具 → Skill `/find-similar`。 |
| **工作量** | 3-4 周（RAG 基础设施）+ 2-3 周（图纸特征向量化） |

---

### 18. PRD 助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行** |
| **能做的** | ① `docx_read` 读会议纪要 → LLM 生成 PRD；② 完整性检查（对比 PRD 模板字段）；③ `workspace_write` 输出 PRD 文档；④ 交互式完善。 |
| **实现路径** | 新增 `prd_agent`，Skill `/generate-prd`。 |
| **工作量** | 1-2 周 |

---

### 19. 市场调研助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟢 **可行**（Claude Code 大幅提升） |
| **能做的** | ① **Claude Code 的 WebSearch + WebFetch** 可搜索和抓取行业数据、竞品信息；② LLM 生成竞品分析报告、市场趋势洞察；③ `workspace_write` 输出结构化报告。 |
| **实现路径** | Skill `/market-research` → WebSearch 搜索 → WebFetch 抓取 → LLM 分析 → 输出报告。 |
| **做不了的** | ① 无专用数据爬虫（但 WebFetch 基本够用）；② 无可视化看板 UI。 |
| **工作量** | 1-2 周 |

---

### 20. 产品评估助手

| 维度 | 评估 |
|------|------|
| **可行性** | 🟡 **部分可行** |
| **能做的** | ① LLM 多维度加权评分（用户自定义维度和权重）；② RAG 检索历史产品评估数据辅助打分；③ WebSearch 搜索公开专利信息辅助侵权风险判断。 |
| **做不了的** | ① 无法查询完整专利数据库（需专利 API 如佰腾/智慧芽）；② 无法从历史物料库做精确 BOM 估算（需 ERP 数据）。 |
| **实现路径** | Skill `/product-evaluate` + RAG 历史评估库。Phase 2 对接专利 API。 |
| **工作量** | 2 周（Phase 1） |

---

## 总结

### 可行性分布

```
🟢 可行（10个）：任务拆解、软件架构、干涉检查、PCB/PCBA、2D工程图、
                 标准查询、DFMEA、测试脚本、知识推荐、PRD、市场调研
🟡 部分可行（9个）：结构优化、电气设计、物料选型、BOM、配方、
                   变更分析、DFM、产品评估
🔴 不可行（1个）：仿真预处理
```

### 关键技术杠杆

| 杠杆 | 解锁能力 | 受益助手 |
|------|---------|---------|
| **RAG 知识库 MCP** | 标准查询、历史数据检索、知识推荐 | 9+ 个助手 |
| **pythonOCC MCP Server** | STEP 导入、干涉检测、壁厚分析、2D 投影、模型 diff | 5+ 个助手 |
| **KiCAD MCP Server** | PCB 原理图/PCB 设计自动化、DRC/ERC、元器件选型、生产文件导出 | 2 个助手（PCB + 电气） |
| **Claude Code WebSearch/WebFetch** | 外部数据获取、竞品调研 | 3+ 个助手 |
| **VSCode Webview + OpenCascade.js** | 3D 可视化、交互式标注 | 4+ 个助手 |
| **Claude Code Hooks** | 文件保存自动校验、自动索引 | 全局提效 |

### 推荐实施路线

**第一批（4-6 周）— 纯 LLM + 文档，零外部依赖：**
1. PRD 助手
2. 软件架构拆解助手
3. 测试脚本生成助手
4. 市场调研助手

**第二批（6-10 周）— 补齐 RAG 基础设施：**
5. 设计标准智能查询助手
6. DFMEA 设计风险研判助手
7. 研发知识推荐助手
8. 研发任务拆解助手

**第三批（10-16 周）— pythonOCC MCP + CAD 增强：**
9. 结构布局与干涉检查助手
10. 2D 工程图助手
11. BOM 智能生成与校验助手（2D 版）
12. 设计变更影响分析助手（DXF diff）
13. DFM 验证助手

**第四批（16-24 周）— PCB/电气 + 需要外部数据：**
14. PCB/PCBA 智能设计助手（KiCAD MCP Server + KiCad Studio）
15. 电气智能设计助手（KiCAD 原理图 + Python 电气计算）
16. 智能物料选型助手（需供应商数据库）
17. 配方智能优化助手（需 domain 专家配合）
18. 结构设计优化助手（需 pythonOCC 拓扑优化深入开发）
19. 产品评估助手（需专利 API）

**长期 — 需要 CAE 深度集成：**
20. 仿真预处理（需 CAE 求解器）

> **结论**：利用 VSCode 插件的 Webview/WebGL 能力 + Claude Code 的 MCP/Skills/Hooks 机制 + pythonOCC 的 3D 几何分析能力 + KiCAD MCP Server 的 EDA 自动化能力，**可实现 95% 的助手（10 个完全可行 + 9 个部分可行）**。真正不可行的只有 1 个需要深度 CAE 求解器集成的仿真预处理助手。核心投入在 **RAG 基础设施**、**pythonOCC MCP Server** 和 **KiCAD MCP Server** 三条主线上。
