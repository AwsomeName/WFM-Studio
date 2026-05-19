# DEV_AGENT_SDK_NATIVE — 对话后端迁移至 OpenAI Agents SDK · 完结记录

> **状态：已完成（COMPLETED, 2026-05-14）**
>
> 本文记录了从旧 `AgentGateway + EngineAdapter` 抽象迁移到 **OpenAI Agents SDK**（`agents` 包，`agent_v2/`）的完整过程与最终架构。所有迁移步骤均已执行、验证、合入 main。
>
> **规格来源**：[`ARCH_AGENT_SDK_NATIVE.md`](ARCH_AGENT_SDK_NATIVE.md)（契约 / 数据模型 / 事件名 / 默认参数）。
> **替代**：[`DEV_AGENT_GATEWAY.md`](DEV_AGENT_GATEWAY.md)（**已废弃**，保留为历史背景）。

---

## 0. 迁移总览

**最终目标**（已达成）：把 `/v1/chat`、`/v1/chat/stream`、`/v1/cad/review`、`/v1/cad/review/stream` 全部对话流量从 `AgentGateway + EngineAdapter` 抽象切到 `agent_v2/runner.py` 直连 **OpenAI Agents SDK**（`agents.Runner`）。状态、流式回流、工具调用、CAD 审图结构化输出全部打通。

**迁移路径**（两段式）：

1. **Phase 1–5**：按 `ARCH_AGENT_SDK_NATIVE.md` 设计，自建 `agent/runner.py` 直连 `openai-python` SDK（Responses API）。此阶段已完成。
2. **Phase 6（进一步简化）**：用 **OpenAI Agents SDK**（`third_party/agents/openai-agents-python`，即 `agents` 包）替换自建 runner。删除 `agent/` 下除 `config.py` 以外的全部代码（runner.py、client.py、events.py、fallback.py、session_store.py、recipes/、tools/）。新代码放入 `agent_v2/`。

**最终结果**：

- [x] 75 passed, 0 failed
- [x] 所有 4 条路由走 `agent_v2/`
- [x] 前端 0 改动（SSE wire format 与请求/响应包络完全兼容）
- [x] GLM-5.1 兼容（手动 JSON 解析 + code-fence 剥离）
- [x] 旧 `agent/` 代码已删除（仅保留 `config.py`）

---

## 1. Phase 1–5 迁移记录（自建 SDK-native runner）

> 以下 5 个阶段按 `ARCH_AGENT_SDK_NATIVE.md` §12 设计执行，构建了自建的 `agent/runner.py` 直连 `openai-python`。这些阶段已全部完成，后续被 Phase 6 替代。

### 1.1 Phase 1 · 骨架（普通对话跑通）

**做了什么**：

- 新建 `wfm-agents/wfm_agents/agent/` 包。
- 实现：`config.py`、`client.py`、`session_store.py`、`recipes/base.py`、`recipes/plain_chat.py`、同步 `runner.py`。
- `routes/chat.py` 非审图分支切到新 runner；审图分支保持原状。

**验证（全部通过）**：

- [x] `uv run uvicorn wfm_agents.server:app` 启动无 error。
- [x] `curl POST /v1/chat {"workspace_root":"...", "message":"你好"}` 返回正常文本回复。
- [x] viewer 点「AI 审图」仍走老逻辑、行为不变（回归）。
- [x] `tests/test_agent_runner_sync.py` 通过。
- [x] `tests/test_cad.py`、`tests/test_api.py`、`tests/test_chat_stream_m3.py` 全部通过。

### 1.2 Phase 2 · 流式回流（SSE 走通）

**做了什么**：

- 实现 `run_stream` 与 SSE 事件契约（见 ARCH §8.2）。
- `routes/chat_stream.py` 切到 runner。
- `agent/events.py`：内部事件类型 + `encode_sse(event) -> bytes`。

**验证（全部通过）**：

- [x] `curl -N POST /v1/chat/stream` 能看到 `data: {"type":"text_delta",...}` 增量。
- [x] 新增 `tests/test_agent_runner_stream.py` 通过。

### 1.3 Phase 3 · 多轮记忆 + 工具循环

**做了什么**：

- 启用 `previous_response_id`（Responses API 路径）。
- `agent/tools/adapter.py` + `agent/tools/invoke.py`：builtin/MCP 工具转 SDK tool 字典。
- runner 加 `_drive_tool_loop`（sync）+ 流式工具事件。

**验证（全部通过）**：

- [x] 同一 `session_id` 连续对话能引用上下文。
- [x] builtin 工具（读 workspace 内文件）跑通，流式有 `tool_call_started/done`。
- [x] `WFM_AGENT_MAX_TOOL_ROUNDS` 上限时优雅返回。
- [x] `tests/test_agent_runner_tools.py` 通过。

### 1.4 Phase 4 · CAD 审图迁入

**做了什么**：

- 新增 `agent/recipes/cad_review.py`（`CadReviewRecipe`，`response_schema=CadReviewReport`，`temperature=0.2`）。
- `routes/chat.py` 审图分支切到 `runner.run_sync(recipe=cad_review)`。
- 新增 `/v1/cad/review/stream`。

**验证（全部通过）**：

- [x] viewer 点「AI 审图」端到端跑通，前端看到中文 Markdown 审图意见。
- [x] `POST /v1/cad/review` 同步返回 `CadReviewReport` JSON。
- [x] `POST /v1/cad/review/stream` 增量 + `done` 里的 `report` 字段。
- [x] `tests/test_cad.py` 全部通过。

### 1.5 Phase 5 · 降级链路 + fallback + 收尾

**做了什么**：

- runner 内加 `responses → chat.completions → json_object → free text` 三级降级。
- 实现 `WFM_AGENT_FALLBACKS` 模型重试链。
- `agent/fallback.py` 实现降级逻辑。

**验证（全部通过）**：

- [x] 不支持 Responses API 的上游 → 自动降到 `chat.completions`。
- [x] 不存在模型 → fallback 链接管。
- [x] SDK 内置重试，前端无感。
- [x] `tests/test_agent_runner_fallback.py` 通过。

---

## 2. Phase 6 · 替换为 OpenAI Agents SDK（agent_v2）

> Phase 1–5 完成后，进一步简化架构：用 OpenAI Agents SDK（`agents` 包）替换自建 runner，删除全部旧 `agent/` 代码。

### 2.1 Step 1 · PoC 验证（`/v1/chat/v2`）

**做了什么**：

- 在 `agent_v2/` 下构建 PoC，与旧 `agent/` runner **并存**。
- 实现 `agent_v2/router.py`：新路由 `POST /v1/chat/v2`，使用 `agents.Runner.run` + `agents.Agent`。
- 实现 `agent_v2/agents.py`：`plain_chat_agent`（带 `workspace_read` / `workspace_write` 工具）和 `cad_review_agent`（审图专用，无工具）。
- 实现 `agent_v2/tools.py`：用 `@function_tool` 装饰器注册工具（`workspace_read`、`workspace_write`、`cad_generate_step`、`cad_inspect`、`cad_render`、`cad_export_dxf`），每个工具内部复用 `fs_ops` / `workspace` 已有逻辑。
- 实现 `agent_v2/context.py`：`WfmAgentContext(workspace_root)` 数据类，传入 `RunContextWrapper`。
- GLM-5.1 兼容性处理：手动 JSON 解析 + markdown code-fence 剥离（`_parse_cad_review`）。

**验证（3 条路径全部跑通）**：

- [x] 普通对话（plain chat）：`/v1/chat/v2` + 非审图消息 → `plain_chat_agent` → 正常回复。
- [x] 工具调用（tool use）：`plain_chat_agent` 带 `workspace_read` / `workspace_write` → 工具执行正常。
- [x] CAD 审图（cad review）：`/v1/chat/v2` + `dxf_text` → `cad_review_agent` → 结构化审图报告 JSON 解析成功。

### 2.2 Step 2 · 全量切换（Cutover）

**做了什么**：

- `routes/chat.py`：切到 `agent_v2.runner.run_chat`，删除旧 runner 引用。
- `routes/chat_stream.py`：切到 `agent_v2.runner.run_chat_stream`。
- `routes/cad_review.py`：切到 `agent_v2.runner.run_chat` / `run_chat_stream`。
- 删除旧 `agent/` 代码：
  - `agent/runner.py` ← 已删除
  - `agent/client.py` ← 已删除
  - `agent/events.py` ← 已删除
  - `agent/fallback.py` ← 已删除
  - `agent/session_store.py` ← 已删除
  - `agent/recipes/` ← 整个目录已删除
  - `agent/tools/` ← 整个目录已删除
- 保留 `agent/config.py`（`AgentConfig` + `load_config`）——agent_v2 仍通过 `from ..agent.config import load_config` 使用。
- 更新测试：
  - 删除引用旧 runner 的测试。
  - 剩余测试改为 mock `agents.Runner.run_sync`（而非旧 `openai.OpenAI`）。
  - 旧 `engine=crewai|maf|agenticx` 路径的测试标记 `skip`（记录已废弃契约，等 `engines/` 目录清理时一并删除）。
- 删除 `agent_v2/router.py`（PoC 路由 `/v1/chat/v2` 不再需要）。

**验证（全部通过）**：

- [x] `pytest`：75 passed, 0 failed。
- [x] `POST /v1/chat` → `agent_v2.runner.run_chat` → `Runner.run_sync`。
- [x] `POST /v1/chat/stream` → `agent_v2.runner.run_chat_stream` → `Runner.run_streamed`。
- [x] `POST /v1/cad/review` → `agent_v2.runner.run_chat(cad_extras=...)` → `Runner.run_sync`。
- [x] `POST /v1/cad/review/stream` → `agent_v2.runner.run_chat_stream(cad_extras=...)` → `Runner.run_streamed`。
- [x] 旧 `engine` / `mode` 字段：accepted-but-ignored，log warning。

---

## 3. 最终架构（agent_v2）

### 3.1 模块布局

```
wfm-agents/wfm_agents/
├── agent/
│   ├── __init__.py
│   └── config.py              # AgentConfig + load_config（Phase 1–5 唯一保留的文件）
├── agent_v2/
│   ├── __init__.py
│   ├── runner.py              # run_chat() / run_chat_stream() → 唯一入口
│   ├── agents.py              # plain_chat_agent / cad_review_agent 定义
│   ├── tools.py               # @function_tool 注册的 workspace + CAD 工具
│   ├── context.py             # WfmAgentContext(workspace_root)
│   └── sse.py                 # SSE 事件常量 + encode_sse()
├── routes/
│   ├── chat.py                # POST /v1/chat → agent_v2.runner.run_chat
│   ├── chat_stream.py         # POST /v1/chat/stream → agent_v2.runner.run_chat_stream
│   └── cad_review.py          # POST /v1/cad/review + /stream → agent_v2.runner
```

### 3.2 调用链

```
路由层 (routes/*.py)
  │  参数校验 + CAD 检测 + SSE 包装
  ▼
agent_v2/runner.py
  │  构建 RunConfig / 选择 Agent / 调用 Runner
  ▼
agents.Runner (OpenAI Agents SDK)
  │  run_sync / run_streamed
  ▼
OpenAI-compatible API (GLM-5.1 / gpt-4.1-mini / ...)
```

路由层**只做**参数校验和 SSE 包装，永远不直接触碰 SDK。`agent_v2/runner.py` 是唯一持有 `Runner` 的地方。

### 3.3 Agent 定义（`agent_v2/agents.py`）

| Agent | 名称 | 工具 | 用途 |
|---|---|---|---|
| `router_agent` | `wfm.router` | `workspace_read`, `workspace_write`, `cad_convert_format` | 编排器，自动分发到专用 Agent |
| `text_to_cad_agent` | `text_to_cad` | `workspace_read`, `workspace_write`, `cad_generate_step`, `cad_inspect`, `cad_render`, `cad_export_dxf` | 3D CAD 建模 |
| `cad_review_agent` | `cad_review` | 8 个 CAD 审图工具（`cad/tools.py`） | CAD 图纸审查 |
| `docx_review_agent` | `docx_review` | `docx_read` | Word 文档审阅 |

四个 Agent 共享 `WfmAgentContext` 上下文（携带 `workspace_root`）。Router 通过 SDK `handoffs` 列表注册三个专用 Agent，自动根据用户意图分发。`tool_use_behavior="run_llm_again"`：工具执行后自动把结果回传模型继续生成。

### 3.4 工具注册（`agent_v2/tools.py`）

使用 OpenAI Agents SDK 的 `@function_tool` 装饰器注册，每个工具通过 `RunContextWrapper` 获取 `workspace_root`：

| 工具 | 功能 |
|---|---|
| `workspace_read` | 读取工作区内文本文件（复用 `fs_ops.read_text`） |
| `workspace_write` | 写入工作区内文本文件（复用 `fs_ops.write_text`） |
| `cad_generate_step` | 从 Python 源码生成 STEP/STP 文件 |
| `cad_inspect` | 检查 STEP 几何信息 |
| `cad_render` | 渲染 STEP/GLB 为 PNG/SVG |
| `cad_export_dxf` | 从 Python 源码导出 DXF |

所有路径操作通过 `resolve_within` 安全校验，越界抛 `WorkspaceViolation`。

### 3.5 SSE 事件契约（`agent_v2/sse.py`）

Wire format 与旧版兼容，新增 `agent_handoff` 事件供前端展示 Agent 切换状态：

| 事件 type | payload 关键字段 | 时机 |
|---|---|---|
| `session` | `session_id` | 流开始 |
| `text_delta` | `delta` | 模型输出文本 |
| `tool_call_started` | `name`, `id` | 工具调用起 |
| `tool_call_done` | `id` | 工具调用结束 |
| `agent_handoff` | `agent` | Agent 切换（Router → 专用 Agent） |
| `error` | `error` | 任意错误 |
| `done` | `session_id`, `trace_id`, `text` | 流结束 |

### 3.6 GLM-5.1 兼容性

GLM-5.1 返回的 JSON 会被 markdown code fence（\`\`\`json...\`\`\`）包裹。`runner.py` 中的 `_parse_cad_review` 处理：

1. 正则匹配 \`\`\`json...\`\`\` 并提取内容。
2. 无 code fence 时直接 `json.loads`。
3. JSON 解析成功后 `CadReviewReport.model_validate` 做 schema 校验。
4. 校验成功 → `render_markdown(report)` 返回 Markdown + 原始 dict。
5. 校验失败 → 返回原始文本 + raw dict。

### 3.7 配置（`agent/config.py`，沿 Phase 1 设计）

环境变量统一前缀 `WFM_`，`load_config()` 返回 `AgentConfig` dataclass：

```
WFM_OPENAI_API_KEY            必填
WFM_OPENAI_BASE_URL           可选（DashScope / DeepSeek / GLM 走兼容层）
WFM_AGENT_MODEL               主模型，默认 gpt-4.1-mini
WFM_AGENT_FALLBACKS           逗号分隔，依次重试
WFM_AGENT_API                 responses | chat
WFM_AGENT_TIMEOUT             默认 120
WFM_AGENT_RETRIES             默认 2
WFM_AGENT_TEMP                默认 0.3
WFM_AGENT_MAX_TOOL_ROUNDS     默认 8
WFM_AGENT_SESSION_TTL_SEC     默认 3600
WFM_AGENT_ALLOW_IMAGE         默认 false
```

---

## 4. 验证总结

### 4.1 自动化测试

- [x] `pytest`：**75 passed, 0 failed**
- [x] 旧 `engine=crewai|maf|agenticx` 测试标记 `skip`（等 `engines/` 清理时一并删除）
- [x] 所有活跃测试 mock `agents.Runner.run_sync` / `run_streamed`
- [x] CAD 摘要 + 审图路由测试通过
- [x] workspace I/O 测试通过
- [x] 配置缺失 → 清晰 400 错误

### 4.2 端到端验证

- [x] `POST /v1/chat` 普通对话正常
- [x] `POST /v1/chat/stream` SSE 增量输出正常
- [x] `POST /v1/cad/review` 审图结构化输出正常
- [x] `POST /v1/cad/review/stream` 审图 SSE 正常
- [x] 工具调用（`workspace_read` / `workspace_write`）正常
- [x] 旧 `engine` / `mode` 字段 accepted-but-ignored，warning 日志正常
- [x] IDE SSE 流式消费正常（`chatStream()` → 实时展示工具调用、Agent 切换、文本增量）
- [x] IDE 降级到同步 `chat()` 正常（流式连接异常时自动回退）

### 4.3 GLM-5.1 兼容性

- [x] Code-fence 包裹的 JSON 能正确解析
- [x] 非 code-fence JSON 能直接解析
- [x] Schema 校验失败时优雅降级（返回原始文本）

---

## 5. 与其它文档的关系

| 文档 | 状态 | 说明 |
|---|---|---|
| `ARCH_AGENT_SDK_NATIVE.md` | **规格（部分过期）** | §3–§8 描述的自建 runner 架构已被 `agents` SDK 替代；§5 配置、§9 HTTP 包络、§10 错误/降级仍为现行契约。待更新。 |
| `DEV_AGENT_GATEWAY.md` | **已废弃** | 旧 `AgentGateway + EngineAdapter` 抽象的研发推进手册。顶部已加 DEPRECATED 横幅。 |
| `ARCH_AGENT_GATEWAY.md` | **已废弃** | 旧架构规格。顶部已加 DEPRECATED 横幅。 |
| `ARCH_CAD_REVIEW.md` | **现行** | CAD 审图规格。审图分支调用方已改为 `agent_v2/` 的 `cad_review_agent`。 |
| `CAD_AI_SELECTION_REVIEW.md` | **现行** | 选区审图 L1。 |

---

## 6. 已删除的代码

以下旧 `agent/` 模块在 Phase 6 中被删除（仅 `config.py` 保留）：

| 已删除文件 | 原用途 |
|---|---|
| `agent/runner.py` | 自建 SDK-native runner（`run_sync` / `run_stream`） |
| `agent/client.py` | `make_sync_client` / `make_async_client` 工厂 |
| `agent/events.py` | 内部事件 → SSE payload 编码 |
| `agent/fallback.py` | 三级降级 + 模型 fallback |
| `agent/session_store.py` | 进程内 dict + TTL 会话存储 |
| `agent/recipes/` | Recipe 协议 + `PlainChatRecipe` + `CadReviewRecipe` |
| `agent/tools/` | `adapter.py`（ToolSpec → SDK tool）+ `invoke.py`（工具执行） |
| `agent_v2/router.py` | PoC 路由 `/v1/chat/v2`（cutover 后删除） |

---

## 7. 开发约束（现行）

- 遵守 `.cursor/rules/wfm-ide-fork-policy.mdc`：改动限定在 `contrib/wfm/` 下。IDE 端 SSE 流式消费代码位于 `wfm-ide/src/vs/workbench/contrib/wfm/`。
- `agent_v2/` 代码使用 `from __future__ import annotations`、严格类型注解。
- 日志走标准库 `logging.getLogger(__name__)`。
- `agents` 包来源：`third_party/agents/openai-agents-python/`（git subtree）。
- 不引入额外 PyPI 依赖（`agents` 包已通过 subtree vendored）。

---

## 8. 测试对应表

| 测试文件 | 覆盖点 | 状态 |
|---|---|---|
| `tests/test_api.py` | HTTP 路由端到端（health、chat、workspace I/O） | **活跃**（75/75 pass） |
| `tests/test_cad.py` | DXF 解析 + 审图路由 + inline dxf_text | **活跃** |
| `tests/test_chat_stream_m3.py` | SSE 流式 + 工具事件 + 断连取消 | **活跃**（gateway 内部测试） |
| `tests/test_gateway_models_m0.py` | Pydantic 模型校验 | **活跃** |
| `tests/test_tool_m1.py` | 工具注册/执行/policy | **活跃** |
| `tests/test_workspace.py` | Workspace 路径安全 | **活跃** |
| `tests/test_gateway_m2.py` | AgentGateway 内部 | **活跃** |
| `tests/test_mcp_m4.py` | MCP 集成 | **活跃** |
| `tests/test_openai_engine.py` | OpenAI engine 内部 | **活跃** |
| `tests/test_cad_tool_provider.py` | CAD 工具 provider | **活跃** |

旧的 `test_agent_runner_sync.py`、`test_agent_runner_stream.py`、`test_agent_runner_tools.py`、`test_cad_review_recipe.py`、`test_agent_runner_fallback.py`（引用旧 `agent/` runner）已在 cutover 时删除。覆盖等价功能的新测试使用 `agents.Runner.run_sync` mock。

---

## 9. 已知限制 & 后续事项

- **Session 无持久化**：当前 `session_id` 由前端传入，后端不做跨轮状态管理（OpenAI Agents SDK 的 `Runner.run_sync` 每次独立调用）。多轮记忆依赖 `previous_response_id` 或未来在 `WfmAgentContext` 中维护 history。
- **降级链路**：Phase 5 的 `responses → chat.completions → json_object → free text` 三级降级逻辑未随 `agent_v2` 迁移。如需降级，在 `OpenAIProvider` 构造参数或 `RunConfig` 层面处理。
- **`engines/` 与 `gateway/` 目录未删**：旧抽象代码保留（不被对话路径调用），等全量稳定后单独清理。
- **`agent_v2/router.py`**：PoC 路由 `/v1/chat/v2` 已删除。如需独立的调试/对比端点，可重新添加。
- **`agents` 包版本**：当前使用 subtree vendored 的 `third_party/agents/openai-agents-python/`，锁定在特定 commit。如需升级，更新 subtree 即可。
