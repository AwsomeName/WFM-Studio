# CAD 审图 Agent 工具化架构设计

> **版本**：v1.0（2026-05-17）；**状态更新**（2026-05-22）：工具已实现为 MCP 工具（`@mcp.tool()`），注册在 `wfm_mcp_server.py` 中，而非原设计的 `@function_tool` + `cad/tools.py`。整体架构（3 层工具、DWG fallback、route 层简化）保持不变。
> **关联**：
> - [ARCH_CAD_REVIEW.md](ARCH_CAD_REVIEW.md) — v0.2 CAD 浏览 + 审图当前管线（本文为其重构方案）
> - [CAD_AI_FEASIBILITY.md](CAD_AI_FEASIBILITY.md) — 效果可行性与能力边界
> - [CAD_AI_SELECTION_REVIEW.md](CAD_AI_SELECTION_REVIEW.md) — 选区审图方案
> - [ARCH_AGENT_SDK_NATIVE.md](ARCH_AGENT_SDK_NATIVE.md) — [已废弃] 旧 OpenAI Agents SDK 规格
> - [`wfm-agents/README.md`](../wfm-agents/README.md) — 当前 Claude Code CLI + MCP 架构文档
>
> **目标**：将 CAD 审图从"route 层硬编码解析 + agent 复读摘要"重构为"agent + 工具"范式，agent 自主决定调哪些工具、怎么分析。

---

## 1. 问题分析

### 1.1 当前架构的矛盾

v0.2 的审图链路：

```
前端 LibreDWG WASM 把 .dwg 转成 DXF 文本
  → IPC 传 dxfText
  → route 层 ezdxf 解析出完整摘要
  → 摘要塞进 prompt
  → cad_review_agent 翻译成审图报告
```

问题：

- **agent 是复读机**：摘要已经拼好了，agent 只是换个格式输出，没有真正的分析能力
- **前端绑定**：审图能力依赖前端 WASM 做 DWG→DXF 转换。所有不经过 CAD Viewer 的入口（右键、对话打字）对 .dwg 都走不通
- **不可扩展**：新增检查项需要改 route 层 + prompt + parser，耦合严重
- **大小文件无区分**：无论图纸大小，一次性塞完整摘要到 prompt，大图 token 成本高

### 1.2 设计原则

1. **后端是 CAD 文件解析的唯一责任方**。前端只负责告诉后端"审哪个文件"
2. **agent 自主编排**。agent 拥有工具，自己决定调哪些、怎么组合、调几次
3. **按需取数据**。小文件一次拿完，大文件按图层/类别分步查
4. **工具可复用**。标准 `@mcp.tool()`，可被任何 agent 调用，已作为 MCP 服务器暴露

---

## 2. 整体架构

### 2.1 数据流

```
┌──────────────────── 入口 ─────────────────────────┐
│  ① 右键 .dwg/.dxf "AI 审图"  → cad_source_uri    │
│  ② 右键 .dwg/.dxf "发送到 WFM" → cad_source_uri  │
│  ③ 对话打字 "审一下 xx.dwg"  → message 提取路径   │
│  ④ Viewer 工具栏 "AI 审图"  → dxf_text (→ 临时文件)│
└───────────────────────┬───────────────────────────┘
                        │
                        ▼
┌──────── Route 层（只做标准化）─────────────────────┐
│                                                    │
│  1. 标准化文件引用：                                │
│     cad_source_uri → resolve → filesystem path     │
│     message 里 .dxf/.dwg → resolve → filesystem path│
│     dxf_text → 写临时 .dxf → temp path             │
│                                                    │
│  2. 选择 agent：                                   │
│     有 CAD 文件引用 → cad_review_agent              │
│     无 → plain_chat_agent                          │
│                                                    │
│  3. 构造 prompt：                                  │
│     "审图，文件: {path}，要求: {message}"            │
│     （不解析文件、不拼摘要，全交给 agent 调工具）     │
│                                                    │
└───────────────────────┬───────────────────────────┘
                        │
                        ▼
┌──────── Claude Code CLI + MCP 工具 ──────────────┐
│                                                    │
│  system prompt (claude_runner.py): "你是审图工程师"│
│                                                    │
│  MCP 工具集（8 个 @mcp.tool()）：                  │
│    cad_file_read            总览                   │
│    cad_extract_texts        文字详情               │
│    cad_extract_dims         标注详情               │
│    cad_extract_blocks       块定义                 │
│    cad_layer_inspect        单图层深挖             │
│    cad_check_naming         命名规范               │
│    cad_check_titleblock     标题块                 │
│    cad_check_dim_accuracy   标注精度               │
│                                                    │
│  Claude 自主决定调哪些工具、调几次、怎么组合       │
│                                                    │
└────────────────────────────────────────────────────┘
```

### 2.2 与当前实现的对比

| 维度 | 当前（v0.2） | 新设计 |
|------|-------------|--------|
| 谁决定看什么 | route 层硬编码全量摘要 | agent 根据总览自主决定 |
| prompt 里有什么 | 塞满整个 DXF 摘要 | 只有文件路径 + 用户要求 |
| 小文件 vs 大文件 | 同样塞全部摘要 | agent 按需取，大文件分步查 |
| .dwg 审图 | 依赖前端 WASM 转换 | 后端直接读 .dwg |
| 扩展新检查项 | 改 route 层 + parser + prompt | 加一个 `@mcp.tool()` |
| 工具可复用性 | 不可复用 | 已作为 MCP 服务器暴露，可被任何调用方使用 |

---

## 3. 工具定义

### 3.1 Tier 1 — 总览（agent 第一个调的）

#### `cad_file_read`

```python
@mcp.tool()
def cad_file_read(path: str) -> str:
    """读取 CAD 文件并返回结构化总览摘要。

    支持 .dxf 和 .dwg 格式。返回文件元数据、图层列表（含实体计数）、
    文字/标注/块的数量统计、标题块字段、图纸单位等。

    Args:
        path: 工作区相对路径或绝对路径，如 'drawings/总布置图.dwg'
    """
```

返回示例：

```json
{
  "file": {
    "name": "总布置图.dwg",
    "format": "dwg",
    "version": "R2018",
    "units": "mm"
  },
  "layers": [
    { "name": "A-DIM", "entity_count": 342, "types": {"DIMENSION": 280, "LINE": 62} },
    { "name": "A-TEXT", "entity_count": 156, "types": {"MTEXT": 120, "TEXT": 36} }
  ],
  "stats": {
    "total_entities": 2847,
    "texts": 156,
    "dimensions": 280,
    "blocks": 23
  },
  "title_block": {
    "图名": "总布置图",
    "图号": "GS-001",
    "日期": null,
    "审核": null
  },
  "text_styles": ["Standard", "swissl"],
  "dim_styles": ["Standard", "ISO-25"]
}
```

### 3.2 Tier 2 — 按需深挖（agent 看完总览后决定调哪个）

#### `cad_extract_texts`

```python
@mcp.tool()
def cad_extract_texts(
    path: str,
    layer: str | None = None,
) -> str:
    """提取 CAD 文件中的文字内容（TEXT + MTEXT）。

    Args:
        path: 工作区相对路径或绝对路径。
        layer: 可选，只提取指定图层的文字。
    """
```

#### `cad_extract_dims`

```python
@mcp.tool()
def cad_extract_dims(
    path: str,
    layer: str | None = None,
) -> str:
    """提取标注信息（DIMENSION），含测量值、文字覆盖、关联实体。

    Args:
        path: 工作区相对路径或绝对路径。
        layer: 可选，只提取指定图层的标注。
    """
```

#### `cad_extract_blocks`

```python
@mcp.tool()
def cad_extract_blocks(path: str) -> str:
    """提取块定义（BLOCK），含名称、实体组成、嵌套关系。

    Args:
        path: 工作区相对路径或绝对路径。
    """
```

#### `cad_layer_inspect`

```python
@mcp.tool()
def cad_layer_inspect(
    path: str,
    layer: str,
) -> str:
    """深入检查单个图层：实体类型分布、坐标范围、文字内容、标注值。

    Args:
        path: 工作区相对路径或绝对路径。
        layer: 图层名称。
    """
```

### 3.3 Tier 3 — 专项检查

#### `cad_check_naming`

```python
@mcp.tool()
def cad_check_naming(
    path: str,
    rule_set: str = "default",
) -> str:
    """检查图层/块命名是否符合规范。

    Args:
        path: 工作区相对路径或绝对路径。
        rule_set: 命名规则集（default / iso / company_xxx）。
    """
```

#### `cad_check_titleblock`

```python
@mcp.tool()
def cad_check_titleblock(path: str) -> str:
    """检查标题块字段完整性和格式（日期格式、图号规范等）。

    Args:
        path: 工作区相对路径或绝对路径。
    """
```

#### `cad_check_dim_accuracy`

```python
@mcp.tool()
def cad_check_dim_accuracy(
    path: str,
    tolerance: float = 0.01,
) -> str:
    """检查标注精度：用 ezdxf 计算几何长度，与 DIMENSION 文字覆盖对比，
    找出不一致的标注。

    Args:
        path: 工作区相对路径或绝对路径。
        tolerance: 允许的误差范围，默认 0.01。
    """
```

---

## 4. DWG 文件后端处理

### 4.1 Fallback 策略

后端 `cad/dwg.py` 负责 .dwg → .dxf 转换，采用两级 fallback：

```python
def resolve_cad_file(path: Path) -> Path:
    """确保 path 是一个可被 ezdxf 读取的文件（.dwg 自动转换）。"""
    if path.suffix.lower() == ".dxf":
        return path
    if path.suffix.lower() == ".dwg":
        # 第一优先：ezdxf recover 模式（零外部依赖，支持到 R2018）
        try:
            return dwg_to_dxf_via_ezdxf(path)
        except Exception:
            pass
        # 第二优先：LibreDWG CLI（需系统安装，支持较新版本）
        try:
            return dwg_to_dxf_via_libredwg(path)
        except Exception:
            raise ToolError(
                "无法解析 .dwg 文件。请安装 LibreDWG: `brew install libredwg`，"
                "或用桌面 CAD 软件导出为 .dxf 后再试。"
            )
    raise ToolError(f"不支持的文件格式: {path.suffix}")
```

### 4.2 方案对比

| 方案 | 可用性 | 优势 | 风险 |
|------|--------|------|------|
| ezdxf `recover.readfile()` | 内建，零依赖 | 无需安装任何东西 | 只支持到 R2018；AutoCAD 2021+ 的 .dwg 可能读不了 |
| LibreDWG CLI (`dwg2dxf`) | 需 `brew install libredwg` | 和前端 WASM 用同一个库，行为一致；支持较新格式 | 用户环境可能没装；CI 需额外配置 |
| 两者组合（fallback） | 推荐 | 覆盖面最广 | 代码稍复杂 |

### 4.3 临时文件策略

转换产物和 viewer dxf_text 写入的临时文件统一管理：

```python
import tempfile
from pathlib import Path

def save_temp_dxf(dxf_text: str, source_label: str = "viewer") -> Path:
    """将 inline DXF 文本写入临时文件，供 agent 工具读取。"""
    tmp = tempfile.NamedTemporaryFile(
        suffix=".dxf",
        prefix=f"wfm_cad_{source_label}_",
        delete=False,
    )
    tmp.write(dxf_text.encode("utf-8"))
    tmp.close()
    return Path(tmp.name)
```

临时文件在请求处理完成后清理（`finally` 块中 `unlink`）。

---

## 5. 当前实现

### 5.1 MCP 工具注册

原设计的 `cad_review_agent`（`Agent` 类 + `@function_tool`）已被 **Claude Code CLI + MCP 工具**取代。8 个 CAD 审图工具注册在 `wfm_mcp_server.py` 中，通过 `@mcp.tool()` 装饰器定义：

```python
# wfm_mcp_server.py
@mcp.tool()
def cad_file_read(path: str) -> str:
    """读取 CAD 文件并返回结构化总览摘要。"""
    ...

@mcp.tool()
def cad_extract_texts(path: str, layer: str | None = None) -> str:
    """提取文字内容（TEXT + MTEXT）。"""
    ...
# ... 共 8 个 CAD 审图工具 + 2 个 workspace 工具 + 5 个 CAD 建模工具 + 1 个 DOCX 工具
```

workspace_root 通过 `WFM_WORKSPACE_ROOT` 环境变量注入 MCP 服务器（由 `claude_runner.py` 在 `--mcp-config` 中配置）。

### 5.2 与其他工具的关系

```
POST /v1/chat/stream
  │
  ├─ Claude Code CLI 自动判断意图
  │   ├─ CAD 审图 → 调用 cad_file_read / cad_extract_* / cad_check_* 等 MCP 工具
  │   ├─ DOCX 审阅 → 调用 docx_read MCP 工具
  │   ├─ 3D 建模 → 调用 cad_generate_step / cad_render 等 MCP 工具
  │   └─ 文件读写 → 调用 workspace_read / workspace_write MCP 工具
  └─ 所有工具共享 WFM_WORKSPACE_ROOT
```

---

## 6. Route 层改造

### 6.1 chat.py 简化

改造前（v0.2）：

```python
# route 层做所有事情：
cad_extras = _extract_cad_review_extras(req, root)  # 解析文件 + 生成摘要
# ... 拼 prompt，塞摘要
prompt = _build_cad_prompt(cad_extras, message)       # 摘要 + 用户问题
```

改造后：

```python
# route 层只做标准化：
cad_file_path = _resolve_cad_file_ref(req, root)       # → 文件路径或 None

if cad_file_path:
    agent = cad_review_agent
    prompt = (
        f"请审图，文件路径: {cad_file_path}\n"
        f"用户要求: {req.message}"
    )
elif docx_extras:
    agent = docx_review_agent
    prompt = _build_docx_prompt(docx_extras, req.message)
else:
    agent = plain_chat_agent
    prompt = req.message
```

### 6.2 `_resolve_cad_file_ref` 逻辑

```python
def _resolve_cad_file_ref(req: ChatRequest, root: Path) -> str | None:
    """从请求中提取 CAD 文件路径，统一返回工作区相对路径。"""

    # 路径 1：dxf_text（来自 viewer）→ 写临时文件
    if req.dxf_text and req.dxf_text.strip():
        tmp = save_temp_dxf(req.dxf_text)
        return str(tmp)

    # 路径 2：cad_source_uri（来自右键菜单）
    if req.cad_source_uri:
        path = _uri_to_path(req.cad_source_uri, root)
        if path:
            return str(path)

    # 路径 3：消息文本里提到 .dxf/.dwg 文件
    candidates = _extract_cad_candidates(req.message)
    for candidate in candidates:
        path = _resolve_cad_in_workspace(str(root), candidate)
        if path:
            return str(path)

    return None
```

### 6.3 ChatRequest schema 变更

```python
class ChatRequest(BaseModel):
    workspace_root: str = Field(...)
    message: str = Field(...)
    # 已有字段，语义扩展
    dxf_text: str | None = Field(None, description="前端 viewer 附带的 DXF 文本")
    dxf_source_uri: str | None = Field(None, description="CAD 文件 URI（支持 .dwg 和 .dxf）")
    # → 重命名为 cad_source_uri 更准确，保留 dxf_source_uri 做向后兼容
    cad_source_uri: str | None = Field(None, description="CAD 文件 URI（.dwg / .dxf）")
    # 其余字段不变
```

---

## 7. 后端文件结构

```
wfm_agents/
├── cad/
│   ├── __init__.py        更新 export
│   ├── parser.py          拆分：从一个大函数拆成粒度化的子函数
│   │                        summarize_dxf_overview()    → cad_file_read 调
│   │                        summarize_dxf_texts()       → cad_extract_texts 调
│   │                        summarize_dxf_dims()        → cad_extract_dims 调
│   │                        summarize_dxf_blocks()      → cad_extract_blocks 调
│   │                        summarize_dxf_layer()       → cad_layer_inspect 调
│   │                        summarize_dxf / summarize_dxf_text  保留兼容
│   ├── dwg.py             新增：DWG→DXF 转换（ezdxf recover + LibreDWG CLI fallback）
│   ├── tools.py           新增：8 个 @function_tool 定义
│   ├── checks.py          新增：命名规范、标题块、标注精度等检查逻辑
│   ├── recipes.py         保留兼容，route 层不再调用（后续可删）
│   └── review/
│       ├── __init__.py
│       └── schema.py      保留不变（CadReviewReport 等）
├── agent_v2/
│   ├── claude_runner.py    Claude Code CLI 子进程调用 + NDJSON → SSE 映射
│   ├── wfm_mcp_server.py   MCP 工具服务器（workspace + CAD + DOCX 工具）
│   └── sse.py              SSE 事件编码
└── routes/
    └── chat.py             简化为路径解析 + prompt 构建
```

---

## 8. 实现计划

### Phase 1 — 核心工具化（本期，3-4 天）

| 任务 | 文件 | 估时 |
|------|------|------|
| DWG→DXF fallback 转换 | `cad/dwg.py` 新增 | 0.5 天 |
| parser.py 拆分为粒度化子函数 | `cad/parser.py` 改 | 0.5 天 |
| 8 个 MCP 工具定义 | `agent_v2/wfm_mcp_server.py` | 1-2 天 |
| claude_runner.py + NDJSON→SSE | `agent_v2/claude_runner.py` | 0.5 天 |
| chat.py 路径解析 + prompt 构建 | `routes/chat.py` 改 | 0.5 天 |
| 前端 | 不改（已在传 cad_source_uri） | 0 |

### Phase 2 — 几何工具 + 扩展

| 任务 | 说明 |
|------|------|
| 几何检测工具（shapely） | 孤立孔检测、标注压线、实体间距/干涉 |
| Router + Skills 分层 | 当工具超过 10 个时引入 |
| cad_skill_diff | 版本对比（按几何指纹做实体 diff） |
| cad_skill_selection_review | 选区审图 + 截图多模态 |
| MCP 暴露 | 把 CAD 工具集发布为 MCP server |

### Phase 3 — 高级能力

| 任务 | 说明 |
|------|------|
| 规范 RAG | GB/T、ISO、船级社规范库检索 |
| 企业知识库 | 公司标准、项目历史、PLM 对接 |
| 批量审图 | 文件夹一键审完出报表 |
| Issue 持久化 + viewer 反标 | 审图意见写回 viewer 高亮 |

---

## 9. 运行示例

用户右键 `总布置图.dwg` → "AI 审图"，发来："请审一下当前 CAD 图，用通用方法逐项检查。"

```
cad_review_agent 收到:
  "请审图，文件路径: drawings/总布置图.dwg
   用户要求: 用通用方法逐项检查"

  → 调用 cad_file_read("drawings/总布置图.dwg")
      工具内部: .dwg → ezdxf recover 转 .dxf → ezdxf 解析
  ← 返回: 5 个图层, 2847 个实体, 标题块日期为空, A-NOTE 层 156 个文字...

  → 思考: 标题块缺字段，要深入检查；标注多，需验证精度
  → 调用 cad_check_titleblock("drawings/总布置图.dwg")
  ← 返回: 日期为空、审核人未填写、图号格式不规范

  → 调用 cad_extract_texts("drawings/总布置图.dwg")
  ← 返回: 156 条文字，其中 3 条疑似乱码（layer: A-NOTE）

  → 调用 cad_check_naming("drawings/总布置图.dwg")
  ← 返回: 图层 "0" 内有非标准实体，块名含中文空格

  → 调用 cad_check_dim_accuracy("drawings/总布置图.dwg")
  ← 返回: 280 个标注中 12 个文字覆盖与测量值不一致

  → 汇总输出: 结构化审图报告 JSON
    {
      "summary": "图纸存在 3 类问题：标题块不完整、文字乱码、标注精度不一致",
      "issues": [
        {"severity": "warning", "category": "title_block", "title": "标题块日期为空", ...},
        {"severity": "error", "category": "text", "title": "A-NOTE 图层存在乱码文字", ...},
        {"severity": "warning", "category": "dimension", "title": "12 处标注值与几何不一致", ...},
        ...
      ],
      "risks": [...],
      "info_gaps": ["无法验证几何干涉（需 Phase 2 几何工具）"]
    }
```

---

## 10. 与现有文档的关系

| 文档 | 与本文的关系 |
|------|-------------|
| [ARCH_CAD_REVIEW.md](ARCH_CAD_REVIEW.md) | 当前 v0.2 管线，本文为其中 §3（后端）和 §8（审图链路）的重构方案 |
| [CAD_AI_FEASIBILITY.md](CAD_AI_FEASIBILITY.md) | §6 工具底座清单 → 本文的工具设计来源 |
| [CAD_AI_SELECTION_REVIEW.md](CAD_AI_SELECTION_REVIEW.md) | Phase 2 扩展方向（选区审图 + 截图多模态） |
| [ARCH_AGENT_SDK_NATIVE.md](ARCH_AGENT_SDK_NATIVE.md) | [已废弃] 旧 OpenAI Agents SDK 规格 |
| [`wfm-agents/README.md`](../wfm-agents/README.md) | 当前 Claude Code CLI + MCP 架构文档 |
| [TASK_SCENARIOS.md](TASK_SCENARIOS.md) | 用户故事 4 的技术实现方案更新为本文 |
