# DEV_DOCX_REVIEW — Word 文档解析与审阅 · 研发推进手册

> **用途**：把 [`ARCH_DOCX_REVIEW.md`](ARCH_DOCX_REVIEW.md) 里的设计拆成可独立 merge 的 4 个阶段，给 AI / 工程师按步执行。
> **规格来源**：[`ARCH_DOCX_REVIEW.md`](ARCH_DOCX_REVIEW.md)（数据模型 / 工具签名 / 路由逻辑 / 错误码）。
> **基本原则**：若本文与 ARCH 冲突，以 ARCH 为准；发现 ARCH 缺漏先补 ARCH，再改代码。
> **关联**：[`ARCH_AGENT_SDK_NATIVE.md`](ARCH_AGENT_SDK_NATIVE.md)（[已废弃] 旧对话后端规格）、[`wfm-agents/README.md`](../wfm-agents/README.md)（当前 Claude Code CLI + MCP 架构文档）。
> **架构基线**：后端已迁移至 **Claude Code CLI + MCP 工具服务器**（`agent_v2/claude_runner.py` + `wfm_mcp_server.py`），使用 `@mcp.tool()` 注册工具。旧的 `Agent[WfmAgentContext]` + `@function_tool` 模式已废弃。

---

## 0. 开工前对齐

**总目标**：在 WFM Studio 聊天面板中支持 .docx 文件附加与智能审阅（首期场景：金额核对）。

**当前架构**：

```
agent_v2/
├── claude_runner.py   # Claude Code CLI 子进程调用 + NDJSON → SSE 映射
├── wfm_mcp_server.py  # MCP 工具服务器（workspace + CAD + DOCX 工具）
└── sse.py             # SSE 事件编码
├── tools.py       # @function_tool: workspace_read, workspace_write, cad_*
├── runner.py      # run_chat() / run_chat_stream() → Runner.run_sync / Runner.run_streamed
├── sse.py         # SSE event constants + encode_sse()
└── router.py      # PoC /v1/chat/v2（未注册）
```

**边界**：
- 后端新增 `docx/` 模块 + `docx_review_agent` + `docx_read` `@function_tool`
- 前端 `wfmChatViewPane.ts` 增加附件按钮
- **不改动**现有 CAD 审图链路
- `agent_v2/runner.py` 仅增加 `docx_extras` 参数和分发分支，不动 runner 核心
- v0.1 仅支持 `.docx`，不支持 `.doc` / PDF / 图片提取

**节奏**：每阶段独立可 merge，停下来等 review 再下一阶段。

---

## 1. 阶段一：后端 docx 解析器 + @function_tool

### 1.1 做什么

- 添加 `python-docx>=1.1` 到 `pyproject.toml`
- 实现 `wfm_agents/docx/parser.py`：解析 .docx 为结构化 dict（段落 + 表格）
- 在 `wfm_agents/agent_v2/tools.py` 中新增 `docx_read` `@function_tool` 函数

### 1.2 新增文件

```
wfm-agents/wfm_agents/docx/
├── __init__.py          # export parse_docx, extract_amounts_from_table
└── parser.py            # python-docx 解析（段落、表格、合并单元格、金额辅助提取）
```

### 1.3 改动文件

- `pyproject.toml`：dependencies 增加 `python-docx>=1.1`
- `wfm_agents/agent_v2/tools.py`：新增 `docx_read` 函数 + `docx_tools` 导出列表

### 1.4 parser.py 核心接口

```python
def parse_docx(
    path: Path,
    *,
    max_paragraphs: int = 500,
    max_tables: int = 50,
) -> dict:
    """
    返回：
    {
        "metadata": {"title": str, "author": str, "created": str},
        "paragraphs": [{"index": int, "style": str, "text": str}],
        "tables": [{"index": int, "caption": str | None,
                     "headers": [str], "rows": [[str]],
                     "row_count": int, "col_count": int}],
        "stats": {"paragraphs_total": int, "tables_total": int,
                  "paragraphs_kept": int, "tables_kept": int}
    }
    """

def extract_amounts_from_table(table: dict) -> list[dict]:
    """
    从单个表格提取疑似金额字段。
    返回 [{"row": int, "col": int, "raw": str, "value": float, "header": str}]
    """
```

### 1.5 docx_read @function_tool 实现模式

参照 `workspace_read`（`agent_v2/tools.py:59`）的模式：

```python
@function_tool
def docx_read(
    ctx: RunContextWrapper,
    path: str,
    extract_tables_only: bool = False,
) -> str:
    """读取并解析工作区内的 .docx 文件，提取段落和表格的完整内容。

    Args:
        path: 工作区相对路径，如 'docs/投标文件.docx'。
        extract_tables_only: 仅提取表格（跳过段落），适用于金额核对场景。
    """
    from ..docx import parse_docx

    root = ctx.context.workspace_root
    try:
        target = resolve_within(root, path)
    except WorkspaceViolation as exc:
        return f"Error: {exc}"

    if not target.is_file():
        return f"Error: 文件不存在: {path}"
    if target.suffix.lower() != ".docx":
        return f"Error: 仅支持 .docx 文件: {path}"

    try:
        content = parse_docx(target, extract_tables_only=extract_tables_only)
    except Exception as exc:
        return f"Error: 文档解析失败: {exc}"

    return _format_docx_content(content)
```

在 `tools.py` 末尾新增导出列表（供 agents.py 使用）：

```python
docx_tools = [workspace_read, workspace_write, docx_read]
```

### 1.6 验证清单

- [ ] `uv sync` 安装 python-docx 成功
- [ ] 准备一份测试用 .docx（含 2 个表格、若干段落），用 `parse_docx()` 能正确输出结构化 dict
- [ ] 合并单元格被正确展开为重复值
- [ ] `extract_amounts_from_table()` 能识别 `"5,000.00"`、`"￥1,200"`、`"3.14"` 等格式
- [ ] `docx_read` 函数在 `agent_v2/tools.py` 中定义正确，`@function_tool` 装饰器生效
- [ ] 超出 max_tables 时截断，stats 字段反映截断情况
- [ ] 路径越界时返回 `"Error: ..."` 字符串（不抛异常）

### 1.7 测试文件

```
wfm-agents/tests/test_docx_parser.py       # parser 单测（mock python-docx）
wfm-agents/tests/test_docx_tool.py         # @function_tool 调用测试
```

---

## 2. 阶段二：docx_review_agent + 路由集成

### 2.1 做什么

- 在 `agent_v2/agents.py` 中新增 `docx_review_agent`
- 在 `agent_v2/runner.py` 的 `run_chat()` 中增加 `docx_extras` 分支
- 扩展 `ChatRequest`：新增 `docx_path` 字段
- 扩展 `routes/chat.py`：新增 `_extract_docx_review_extras()` + 传递给 `run_chat()`

### 2.2 改动文件

- `wfm_agents/agent_v2/agents.py`：
  - 新增 `_SYSTEM_ZH_DOCX_REVIEW` prompt 常量
  - 新增 `docx_review_agent` Agent 定义
- `wfm_agents/agent_v2/runner.py`：
  - `run_chat()` 签名增加 `docx_extras: dict[str, Any] | None = None`
  - 新增 `docx_extras is not None` 分支（选择 `docx_review_agent`）
  - 新增 `_build_docx_prompt()` 辅助函数
- `wfm_agents/routes/chat.py`：
  - `ChatRequest` 新增 `docx_path: str | None` 字段
  - 新增 `_extract_docx_review_extras()` 函数
  - `chat()` 函数调用 `run_chat()` 时传入 `docx_extras`

### 2.3 docx_review_agent 定义

```python
# agent_v2/agents.py

_SYSTEM_ZH_DOCX_REVIEW = (
    "你是一个专业的标书/投标文件审阅助手。用户会提供一份 Word 文档的结构化内容。\n\n"
    "你的任务是：\n"
    "1. 找出文档中所有包含金额的表格\n"
    "2. 逐行核对：数量 × 单价 = 合价（允许 ±0.01 的舍入误差）\n"
    "3. 核对每个表格的小计是否等于各行合价之和\n"
    "4. 核对总计是否等于各表小计之和\n"
    "5. 如有文字段落中提及的总金额，与表格总计交叉比对\n\n"
    "输出格式：\n"
    "- 每个表格单独列出核对结果\n"
    "- 正确的项标记 ✅\n"
    "- 有差异的项标记 ⚠️ 或 ❌，并注明差异金额\n"
    "- 末尾汇总：核对表格数、发现问题数、涉及差异总金额"
)

docx_review_agent: Agent[WfmAgentContext] = Agent(
    name="wfm.docx_review",
    instructions=_SYSTEM_ZH_DOCX_REVIEW,
    tools=[docx_read],
    tool_use_behavior="run_llm_again",
)
```

### 2.4 runner.py 分发逻辑

在 `run_chat()` 中增加分支（优先级 CAD > DOCX > PlainChat）：

```python
def run_chat(
    *,
    message: str,
    workspace_root: str,
    session_id: str | None = None,
    cad_extras: dict[str, Any] | None = None,
    docx_extras: dict[str, Any] | None = None,   # 新增
) -> ChatResult:
    run_config, max_turns = _build_run_config()
    ctx = WfmAgentContext(workspace_root=workspace_root)

    if cad_extras is not None:
        agent = cad_review_agent
        prompt = _build_cad_prompt(cad_extras, message)
    elif docx_extras is not None:               # 新增
        agent = docx_review_agent
        prompt = _build_docx_prompt(docx_extras, message)
    else:
        agent = plain_chat_agent
        prompt = message

    result = Runner.run_sync(
        starting_agent=agent,
        input=prompt,
        context=ctx,
        run_config=run_config,
        max_turns=max_turns,
    )
    # ... 后续处理与现有逻辑相同
```

### 2.5 路由分支优先级

```
CAD 审图 (dxf_text / .dxf token) > DOCX 审阅 (docx_path) > PlainChat
```

路由层（`routes/chat.py`）仅负责解析 `docx_path` → `docx_extras`，分发逻辑在 `runner.py` 中。

### 2.6 验证清单

- [ ] `ChatRequest(docx_path="docs/test.docx", message="核对金额", workspace_root="...")` 触发 docx_review_agent
- [ ] `ChatRequest(message="你好", workspace_root="...")` 仍走 plain_chat_agent
- [ ] `ChatRequest(dxf_text="...", docx_path="...", message="...", workspace_root="...")` → CAD 优先（回归）
- [ ] `docx_path` 指向不存在的文件 → 返回 404
- [ ] `docx_path` 指向非 .docx 文件 → 返回 400
- [ ] `docx_path` 路径越界 → 返回 400
- [ ] LLM 返回的核对报告包含 ✅/⚠️/❌ 标记，且金额计算正确

### 2.7 测试文件

```
wfm-agents/tests/test_docx_review.py    # Agent 分发 + 路由集成测试
```

---

## 3. 阶段三：前端附件按钮

### 3.1 做什么

- 在聊天输入框左侧添加附件按钮
- 点击后弹出 VS Code 文件选择器（过滤 .docx）
- 选中后显示附件标签，支持移除
- 发送时将 workspace 相对路径传入 `docx_path`

### 3.2 改动文件

| 文件 | 改动 |
|------|------|
| `wfmChatViewPane.ts` | 新增附件按钮 DOM、文件选择器调用、附件状态管理（`_attachedDocxPath` 字段）、发送逻辑修改 |
| `wfmAgentClientService.ts` | `sendMessage()` 签名增加 `docxPath?: string`，请求体加入 `docx_path` |
| `common/wfmAgentClient.ts` | `IWfmAgentClientService` 接口增加 `docxPath` 参数 |
| `media/wfmChat.css` | 附件标签样式（背景色、图标、移除按钮） |

### 3.3 前端交互规格

```
无附件时：
┌──────────────────────────────────────┐
│ [📎]  [输入消息...]              [➤] │
└──────────────────────────────────────┘

有附件时：
┌──────────────────────────────────────┐
│ 📎 投标文件_v3.docx              [×] │
├──────────────────────────────────────┤
│ [📎]  [输入消息...]              [➤] │
└──────────────────────────────────────┘
```

- 📎 按钮：点击 → `IFileDialogService.showOpenDialog({ filters: [{ name: 'Word', extensions: ['docx'] }] })`
- 附件标签：显示文件名（不含路径），`[×]` 点击移除
- 发送时：附件随消息一起发送，发送后自动清除附件状态

### 3.4 路径处理

- 文件选择器返回的 URI 需转为 workspace 相对路径
- 使用 `IWorkspaceContextService.getWorkspaceFolder()` 获取 workspace root
- 去掉前缀得到相对路径：`/Users/apple/project/docs/test.docx` → `docs/test.docx`

### 3.5 验证清单

- [ ] 附件按钮可见、图标正确
- [ ] 点击弹出文件选择器，默认过滤 .docx
- [ ] 选择文件后，附件标签显示文件名
- [ ] 点击 [×] 可移除附件
- [ ] 带附件发送消息后，请求体包含 `docx_path` 字段
- [ ] 不带附件发送消息，请求体无 `docx_path` 字段（回归）
- [ ] LLM 回复在聊天气泡中正确渲染 Markdown 格式的核对报告

---

## 4. 阶段四：集成测试 + Prompt 调优 + 收尾

### 4.1 做什么

- 准备真实投标文档样例（脱敏），端到端测试
- 调优 `docx_review_agent` 的 instructions（金额识别准确率、报告格式一致性）
- 补全错误处理边界（空文档、超大文档、加密文档）
- 文档更新（PLAN.md 注册 Phase、TASK_SCENARIOS.md 增加场景）

### 4.2 端到端测试用例

| 用例 | 输入 | 预期 |
|------|------|------|
| 正常金额核对 | 含 3 个表格的投标文件 + "核对金额" | 正确识别所有金额，标记计算错误 |
| 空文档 | 空白 .docx + "核对金额" | LLM 回复"文档内容为空" |
| 无表格文档 | 纯文本 .docx + "核对金额" | LLM 回复"未发现表格" |
| 大文档 | 40 页 .docx | 解析成功，截断统计正确 |
| 加密/损坏 | 损坏的 .docx | 返回 422 |
| 普通聊天 | 不带附件 + "你好" | plain_chat_agent 正常回复（回归） |
| CAD 审图 | 带 dxf_text + "审图" | cad_review_agent 正常（回归） |

### 4.3 Prompt 调优要点

- 数值精度：允许 ±0.01 的浮点舍入误差
- 千分位兼容：`"1,000.00"` 和 `"1000.00"` 等价
- 货币符号：`￥`、`¥`、`RMB`、`元` 统一处理
- 表格标题推断：无 `<caption>` 时，取表格前一个段落作为标题
- 大数值简写：`"3.45万元"` 需展开为 `"34,500.00"` 再核对

### 4.4 验证清单

- [ ] 真实投标文档端到端核对，结果准确
- [ ] 所有回归测试通过（CAD 审图、普通聊天、chat/stream）
- [ ] `tests/test_docx_parser.py` 全部通过
- [ ] `tests/test_docx_review.py` 全部通过
- [ ] `PLAN.md` 已更新
- [ ] `TASK_SCENARIOS.md` 已增加 Word 审阅场景

### 4.5 文档更新

- `docs/PLAN.md`：Phase 列表增加 "Word 文档审阅" 阶段
- `docs/TASK_SCENARIOS.md`：增加 "用户附加 .docx 投标文件 → 核对金额" 场景

---

## 5. 不在本期范围（重要边界）

- 结构化 `DocxReviewReport` Pydantic schema（前端富渲染）
- 多场景 Agent（合规检查、条款摘要、文档对比）
- 图片 / 嵌入对象提取
- .doc 旧格式支持
- PDF 文件支持
- 文档修改 / 回写

---

## 6. 开发约束

- 遵守项目 fork policy：前端改动限制在 `src/vs/workbench/contrib/wfm/` 内
- **使用 OpenAI Agents SDK 模式**：Agent + `@function_tool`，不使用旧的 Recipe / ToolProvider
- `agent_v2/runner.py` 仅增加 `docx_extras` 参数和分发分支，不动 runner 核心
- 工具函数参照 `workspace_read` 模式：`@function_tool` 装饰，返回 `str`，错误以 `"Error: ..."` 前缀
- 不引入除 `python-docx` 外的新依赖
- 所有新代码使用 `from __future__ import annotations`、严格类型注解
- 日志走标准库 `logging.getLogger(__name__)`
- 文件路径一律通过 `resolve_within()` 校验

---

## 7. 阶段对应测试

| 阶段 | 新增测试 | 覆盖点 |
|------|---------|--------|
| 1 | `test_docx_parser.py` | 段落/表格提取、合并单元格、金额识别、截断 |
| 1 | `test_docx_tool.py` | `@function_tool` 调用、路径安全、错误返回 |
| 2 | `test_docx_review.py` | Agent 分发、runner 分支、路由错误码 |
| 4 | 手动端到端测试 | 真实投标文档金额核对 |

每阶段验证清单全部勾选后才进下一阶段。

---

## 8. 进度跟踪

| 阶段 | 状态 | 备注 |
|------|------|------|
| 1. 后端 docx 解析器 + @function_tool | ⬜ 未开始 | |
| 2. docx_review_agent + 路由集成 | ⬜ 未开始 | |
| 3. 前端附件按钮 | ⬜ 未开始 | |
| 4. 集成测试 + Prompt 调优 | ⬜ 未开始 | |
