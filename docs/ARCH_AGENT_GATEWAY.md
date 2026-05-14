# Uni-Studio 统一 Agent 网关 — 架构规格

> ⚠️ **状态：已废弃（DEPRECATED, 2026-05-14）**
>
> 本文档描述的 `AgentGateway + EngineRegistry + EngineAdapter` 三层抽象**不再作为对话主链路**。
> 全部 `/v1/chat*` 流量已切到 **SDK 原生** runner，直接基于 `third_party/openai/openai-python`。
> **新方案**：[`ARCH_AGENT_SDK_NATIVE.md`](ARCH_AGENT_SDK_NATIVE.md)
>
> 本文继续保留是为了：
> 1. 历史背景（理解仓库里仍存在的 `wfm_agents/engines/`、`wfm_agents/gateway/` 代码）
> 2. 若将来引入第二个非 OpenAI 系 provider（Anthropic、Gemini）需要重新抽象时，作为对比参考
>
> 新功能请勿基于本文增设计；以下内容仅描述**旧实现**。

---

> **历史状态**：正式规格（产品/实现单一事实来源）
> **历史更新日期**：2026-05-07（品牌更名为 Uni-Studio；加 PPTX/Proposal 工具 FQN 与 HTTP 路由）
> **替代**：原 `docs/TMP_AGENT_GATEWAY_DESIGN.md`（已删除，避免双源）

本文定义 IDE 与 Python 后端之间的 **HTTP 契约**、**工具与 MCP 聚合层**、**多引擎适配** 以及 **安全与观测**。实现须与此文档对齐；若有偏差，应先修订本文档再改代码。

---

## 1. 目标与非目标

### 1.1 目标

- IDE 只依赖 **一套稳定 HTTP API**；底层编排可在 **CrewAI / Microsoft Agent Framework (MAF) / AgenticX / Anthropic Messages（`engine=anthropic`）** 之间切换（`engine` / `engine_id`）。
- 所有工具调用（内置能力 + MCP）经 **同一 Tool Gateway**：命名空间、策略、审计、超时、工作区约束一致。
- **第一版必须同时提供**：同步对话接口与 **流式对话接口**（见 §4），以满足 IDE 实时 UI 与可观测性需求。
- 支持后续 A/B 与评测：同一请求 fixture，切换引擎对比延迟、工具成功率、任务完成度。

### 1.2 非目标（第一版刻意不做）

- 不统一三家编排 DSL（图 / Crew Process / Meta-Agent 等）；只统一「用户一轮请求 → 若干 LLM+工具步 → 最终文本」，或预注册的 **`recipe_id`** 在各引擎内各自实现。
- 不把 MCP 传输细节（stdio/SSE）暴露给 IDE；连接与重连关在网关内。
- 不把 **`args` 明文**返回给客户端（仅服务端日志与审计可用脱敏字段）。
- 跨轮会话记忆不由网关持久化（见 §6.1）；幂等 `turn_id` 去重不做（见 §6.3）。

---

## 2. 总体架构

```
HTTP  /v1/chat | /v1/chat/stream
        │
        ▼
   AgentGateway.run_turn | stream_turn
        │
        ├── SessionContext + ToolPolicy
        ├── ToolGateway → ToolRegistry（Builtin + MCP 聚合）
        │       └── ToolExecutor（policy / 超时 / 审计 / 错误码）
        └── EngineAdapter
                └── 仅通过 ToolHandle.invoke 触达外部世界
```

**硬规范**：引擎 **不得** 直接访问磁盘、子进程或 MCP 连接；一律 `ToolGateway.execute(fqn, args, ctx)` / `ToolHandle.invoke`，与工作区 `resolve_within` 安全模型对齐。

---

## 3. 分层职责

### 3.1 边缘层（FastAPI）

- 校验请求体、解析 `workspace_root`（`resolve_workspace_root` 规范化）。
- **流式**：`POST /v1/chat/stream` 返回 **`text/event-stream`（SSE）**，客户端断连时取消本轮执行（见 §4.3）。
- **同步**：`POST /v1/chat` 可选保留，用于调试或极简客户端；语义与流式最终状态一致。
- 扩展字段（与临时设计一致）：`engine`、`session_id`、`recipe_id`、`model_override` 等。

### 3.2 AgentGateway

对外语义：

- **同步**：`run_turn(req: TurnRequest) -> TurnResult`
- **流式**：`stream_turn(req: TurnRequest) -> AsyncIterator[StreamEvent]`（内部仍复用同一套上下文与 ToolHandle）

内部顺序（概念）：

1. 构建 `SessionContext`（session、workspace、message、engine、model 覆盖、`trace_id`）。
2. `ToolGateway.build_handle(ctx)` → **`ToolHandle`**（本轮工具 **snapshot** 冻结，见 §5.4）。
3. `EngineRegistry.get(engine)` → `EngineAdapter`；若 extra 未安装 → **`ENGINE_NOT_INSTALLED`**（见 §12）。
4. `adapter.run_turn` / `adapter.stream_turn`（流式由适配层把 LLM token 与工具事件泵出）。
5. 合并 `ToolLedger`、归一错误、写审计。

**执行模型**：若引擎或 CrewAI 等为同步阻塞实现，须在 **`asyncio.to_thread` / 线程池** 中运行 `run_turn` 的核心，避免阻塞 ASGI 事件循环（§12）。

### 3.3 ToolGateway

| 组件 | 职责 |
|------|------|
| **ToolSpec** | `fqn`、`title`、`json_schema`、`risk_tier`（read/write/exec）、`origin`（builtin / mcp:server_id） |
| **ToolPolicy** | 可用 fqn 白名单、每轮最大工具次数、单工具/集群超时 |
| **ToolRegistry** | 合并 `BuiltinToolProvider` + `MCPClusterProvider`，加前缀、去冲突 |
| **ToolExecutor** | `execute(fqn, args, ctx)`：policy → builtin 或 MCP → 统一 `ToolResult` / 错误码 |

**FQN 约定**

- 内置：`uni.*`（例如 `uni.workspace_read`、`uni.workspace_write`、`uni.pptx_read`、`uni.pptx_write`、`uni.pptx_slide_edit`、`uni.pptx_render_slide`、`uni.pptx_to_pptist`、`uni.pptist_to_pptx`、`uni.proposal_outline`、`uni.proposal_write_section`、`uni.proposal_review`、`uni.proposal_format`）。
  > 注：原有 `wfm.*` FQN（`wfm.workspace_read`、`wfm.workspace_write`）在品牌更名后迁移为 `uni.*`，过渡期可同时注册两套 FQN指向同一实现。
- MCP：`mcp.{server_id}.{original_tool_name}`，`server_id` 限 `[a-z0-9_-]`。

### 3.4 BuiltinToolProvider

- 与工作区路由共用 **`fs_ops`**（或等价模块），路径一律 **`resolve_within(workspace_root)`**。
- HTTP 路由与网关内置工具 **共用** 核心解析逻辑，避免双实现漂移。

### 3.5 MCPClusterProvider

- 配置：`config/mcp_servers.yaml`（或项目约定路径）。
- 每 server 一条 `MCPConnection`（stdio 子进程或远端 SSE）。
- **`MCPCluster`** 聚合 `list_tools`，映射为 `mcp.{id}.{name}`；列表缓存带 **TTL**。
- **Secrets**：环境变量占位 `${env:NAME}` / `${secret:name}`，禁止明文密钥；解析失败启动报错。
- **热更新**：文件变更不强制监听；提供 **`POST /v1/admin/mcp/reload`**（内网或鉴权）重新加载配置并重连。
- **v1 部署**：单进程单 `MCPCluster`；多实例横向扩展不在 v1 范围。

### 3.6 EngineAdapter

```python
class EngineAdapter(Protocol):
    engine_id: str

    def run_turn(self, ctx: SessionContext, tools: ToolHandle) -> TurnResult: ...

    def stream_turn(self, ctx: SessionContext, tools: ToolHandle) -> AsyncIterator[StreamEvent]: ...
```

- **`ToolHandle`**：`list_tool_specs()`、`invoke(fqn, args) -> ToolResult`（内部仅走 `ToolExecutor`）。
- 各引擎将 `ToolSpec` **投影**为框架原生 Tool（见 §7）；执行时一律回调 `invoke`。

---

## 4. HTTP API — 同步与流式（v1 必备）

### 4.1 `POST /v1/chat`

- **请求**：`TurnRequest`（§8）。
- **响应**：`TurnResult`（§8）。
- **用途**：调试、脚本、无需逐字渲染的客户端；与流式终点状态一致。

### 4.2 `POST /v1/chat/stream`（第一版必须实现）

- **请求**：与 `TurnRequest` 相同（或可扩展 `Accept`/协商字段，默认 JSON body 不变）。
- **响应**：`Content-Type: text/event-stream`（SSE）。
- **每条 SSE `data`**：单行 JSON，对应 **`StreamEvent`**（§8），便于 IDE 与日志解析。

### 4.3 流式事件类型（冻结）

以下类型名与字段为第一版契约，后续新增类型须版本协商（`/v2` 或 `capabilities`）。

| `type` | 说明 | 必填字段示例 |
|--------|------|----------------|
| `text_delta` | LLM 增量文本 | `delta: string` |
| `tool_start` | 工具调用开始 | `call_id`, `fqn` |
| `tool_end` | 工具调用结束 | `call_id`, `ok`, `latency_ms`, `error_code?` |
| `done` | 本轮结束 | `trace_id`, `usage?`, `finish_reason?` |
| `error` | 不可恢复或业务错误 | `code`, `message`, `trace_id?` |

说明：

- **`tool_start` / `tool_end`** 与 `ToolCallRecord` 对应，便于 UI 展示与评测对齐。
- **流式 MCP 工具**：v1 工具结果以 **最终结果** 为准；中间 progress 事件可丢弃，须在 release note 标明限制。
- **取消**：检测到客户端断开连接时，向 `SessionContext.cancel_event` 发出信号；工具与引擎在可中断点退出。

### 4.5 PPTX HTTP 路由（Phase 6，详见 `docs/ARCH_PPT_EDITOR.md`）

| 路由 | 方法 | 功能 |
|------|------|------|
| `/v1/pptx/read` | POST | 读 PPTX 结构 → JSON |
| `/v1/pptx/write` | POST | 创建/更新 PPTX |
| `/v1/pptx/convert-to-pptist` | POST | PPTX → PPTist JSON（精细编辑器打开时调用） |
| `/v1/pptx/convert-from-pptist` | POST | PPTist JSON → PPTX（精细编辑器保存时调用） |

所有 PPTX 路由带 `workspace_root` 参数，安全模型与 §5.1 一致。

### 4.6 Proposal HTTP 路由（Phase 7，详见 `docs/ARCH_DOC_GENERATION.md`）

| 路由 | 方法 | 功能 |
|------|------|------|
| `/v1/proposal/generate` | POST | 启动标书生成（recipe_id: `uni.proposal_generate`） |
| `/v1/proposal/refine` | POST | 精细调整指定章节 |
| `/v1/proposal/status` | POST | 查询生成进度 |

所有 Proposal 路由带 `workspace_root` 参数，安全模型与 §5.1 一致。

若实现需简化代理层，允许 **`Content-Type: application/x-ndjson`** 作为同等契约的备选，**事件 JSON 与 SSE `data` 载荷相同**。产品侧以 **SSE 为默认**；文档与 OpenAPI 以 SSE 为准。

---

## 5. 安全与策略

### 5.1 工作区

- 所有文件类工具必须绑定 `workspace_root`，执行前 **`resolve_within`**（与现有不变量一致）。

### 5.2 策略优先级链

由低到高：

1. **默认策略**（§11 常量与服务端配置）
2. **工作区级配置**（若后续引入 workspace 配置文件）
3. **内部覆盖**（`tool_policy_override`，仅内网或 `X-WFM-Internal` 等机制，**不对外部客户端开放**）

二次确认（UI）：网关预留 **`require_confirmation`** 类钩子；v1 可不接 IDE，但策略结构需预留扩展位。

### 5.3 MCP 分级

- **`read_only` / `trusted`**：可按产品默认开启。
- **`user`**：默认关闭或需显式开启；与 IDE 确认流对接留钩子。

### 5.4 限额与快照

- 每轮 **`max_tool_calls`**、单工具超时、MCP 集群总超时（§11）。
- **本轮工具 snapshot 冻结**：`list_tools` 在 turn 开始时固定；MCP 热更新 **下一轮** 生效，避免 schema 漂移导致执行期崩溃。

### 5.5 副作用与路径

- 默认禁止 MCP 写工作区外路径；若必须导出，限定到 **`{workspace_root}/.wfm/exports/`**（或产品另行规定的导出目录）。

### 5.6 出站网络

- v1 **不强制** MCP 出站代理或沙箱；文档声明 **MCP 进程的网络访问由部署环境约束**。

---

## 6. 会话、幂等与取消

### 6.1 `session_id`

- v1：**仅用于日志关联与限流**，**不提供**网关侧跨轮记忆持久化。
- 多轮上下文由调用方在 **`message`** 或后续约定的 **`messages[]`** 中传入（若 OpenAPI 演进，以单独修订为准）。

### 6.2 取消

- v1：**客户端断连即取消**（对流式必选）；不显式提供 `POST /cancel`（可列入后续版本）。

### 6.3 幂等

- v1：**不做** `turn_id` 去重；调用方保证不重复提交。

---

## 7. MCP 与三引擎同步方式

**原则**：**一套 MCPCluster + 一套 ToolRegistry**，三家框架 **不直连 MCP**。

1. **ToolRegistry** 聚合内置与 MCP 工具，生成统一 **`ToolSpec` 列表**（带 `fqn`）。
2. **EngineAdapter** 为各自框架构建 **原生 Tool 对象**，其 `execute/run` **仅调用** `ToolHandle.invoke(fqn, args)`。
3. **刷新**：`list_tools` 缓存 TTL + MCP 变更时失效；**进行中 turn** 不替换 snapshot，**新 turn** 使用新列表。
4. **命名冲突**：v1 **不做**别名；通过策略 **`disabled_fqns`** 显式禁用冲突项。

---

## 8. 数据模型（建议 Pydantic v2）

### 8.1 `TurnRequest`

| 字段 | 类型 | 说明 |
|------|------|------|
| `workspace_root` | `str` | 必填 |
| `message` | `str` | 必填 |
| `engine` | `str` | `crewai` \| `maf` \| `agenticx` |
| `session_id` | `str \| None` | 日志/限流 |
| `recipe_id` | `str \| None` | 引擎内预置流水线，透传 |
| `model_override` | `str \| None` | |
| `tool_policy_override` | `dict \| None` | **仅内部** |
| `client_meta` | `dict \| None` | |

### 8.2 `TurnResult`

| 字段 | 类型 |
|------|------|
| `content` | `str` |
| `workspace_root` | `str` |
| `received_at` | `str` |
| `trace_id` | `str` |
| `engine` | `str` |
| `usage` | `UsageStats \| None` |
| `tool_ledger` | `list[ToolCallRecord]` |
| `finish_reason` | `str \| None` |

### 8.3 `ToolCallRecord`

| 字段 | 类型 |
|------|------|
| `fqn` | `str` |
| `args_redacted` | `dict` |
| `ok` | `bool` |
| `latency_ms` | `int` |
| `error_code` | `str \| None` |
| `started_at` | `str` |
| `ended_at` | `str` |

### 8.4 客户端可见子集

- **返回给 IDE 的 `tool_ledger` 摘要**：建议包含 `fqn`、`ok`、`latency_ms`、`error_code`、`call_id`（与流式事件对齐）；**不包含**敏感参数明文。
- **服务端日志**：可含 `args_redacted`。

### 8.5 `ToolResult`

| 字段 | 类型 |
|------|------|
| `ok` | `bool` |
| `data` | `Any` |
| `error` | `str \| None` |

### 8.6 `UsageStats`（归一）

| 字段 | 类型 | 说明 |
|------|------|------|
| `input_tokens` | `int \| None` | |
| `output_tokens` | `int \| None` | |
| `total_tokens` | `int \| None` | |
| `cost_usd` | `float \| None` | |
| `provider` | `str \| None` | |
| `model` | `str \| None` | |

无法取得时填 **`null`**，禁止虚构。

### 8.7 `StreamEvent`

 discriminated union：`type` 为 §4.3 所列之一，载荷字段与之一致。

---

## 9. 大返回体（artifact）

- 若 MCP/内置工具返回 **大于 `artifact_inline_threshold_bytes`**（默认 **32768**），写入 **`{workspace_root}/.wfm/artifacts/{trace_id}/...`**，返给模型的内容改为 **摘要 + `artifact_ref`**（具体字段由实现约定，须可序列化）。

---

## 10. 观测与评测

- 每轮生成 **`trace_id`**（UUID）；工具与 LLM 调用建议扩展 **`span_id` / `parent_span_id`** 结构化日志。
- **错误码（示例）**：`POLICY_DENY`、`TOOL_NOT_FOUND`、`TOOL_TIMEOUT`、`MCP_CONNECT_ERROR`、`MCP_TIMEOUT`、`ENGINE_ERROR`、`ENGINE_NOT_INSTALLED`、`VALIDATION_ERROR`。
- **Eval harness（v1）**：fixtures 轮流切换 `engine`；对比 **延迟、工具调用序列、UsageStats**；完成度允许人工评分导出 CSV；**不做** LLM-as-judge 自动化（后续版本可选）。

---

## 11. 默认参数（可配置，以下为建议初值）

| 参数 | 默认值 |
|------|--------|
| `max_tool_calls_per_turn` | `12` |
| `single_tool_timeout_ms` | `20000` |
| `mcp_cluster_timeout_ms` | `60000` |
| `mcp_list_tools_ttl_ms` | `30000` |
| `artifact_inline_threshold_bytes` | `32768` |

---

## 12. 可选依赖与错误语义

- `maf` / `agenticx` / **`anthropic`** 使用 **optional-dependencies**；未安装且请求对应引擎时返回 **`ENGINE_NOT_INSTALLED`**，消息体可含安装提示（如 `pip install wfm-agents[maf]`、`pip install wfm-agents[anthropic]`）。

---

## 13. 建议目录布局（`wfm_agents/`）

```
wfm_agents/
  gateway/
    models.py
    agent_gateway.py
    session.py
    stream_events.py      # StreamEvent 与 SSE 序列化
  tools/
    policy.py
    registry.py
    executor.py
    builtin_provider.py
    mcp/
      cluster.py
      connection.py
      config.py
  engines/
    base.py
    crewai_engine.py
    maf_engine.py
    agenticx_engine.py
    anthropic_engine.py
  fs_ops.py
```

---

## 14. 与现有代码映射

| 现有 | 迁移目标 |
|------|-----------|
| `routes/chat.py` 直接跑 CrewAI | `AgentGateway` + `CrewAIEngine`（同步 + 流式） |
| `routes/workspace_ops.py` | 核心下沉 `fs_ops`，HTTP 与 `wfm.workspace_*` 共用 |
| CrewAI runtime 封装 | `crewai_engine.py` 内部 |

---

## 15. 引擎能力矩阵（产品预期）

切换引擎时能力不必一致；以下用于预期管理（实现后应更新勾选）。

| 能力 | CrewAI | MAF | AgenticX | Anthropic (`anthropic-sdk-python`) |
|------|--------|-----|----------|-----------------------------------|
| 编排 DSL | Crew/Process 等 | Graph 等 | 依框架 | 网关内 Messages + tool 循环（非 Crew/Graph） |
| 同步 `/v1/chat` | 目标支持 | 目标支持 | 目标支持 | 目标支持 |
| 流式 `/v1/chat/stream` | **v1 必须** | **v1 必须** | **v1 必须** | **v1 必须**（首版：整段文本 delta，与 DevUI 引擎同级） |
| `recipe_id` | 引擎内定义 | 引擎内定义 | 引擎内定义 | 引擎内定义（注入用户消息前缀） |
| 跨轮记忆 | 调用方传入 | 调用方传入 | 调用方传入 | 调用方传入 |

---

## 16. 风险与已知限制

| 项目 | 说明 |
|------|------|
| 单进程 MCP | v1 仅单进程；多副本需后续 sidecar 或共享注册 |
| 流式 MCP progress | v1 仅最终结果 |
| 别名与工具合并 | v2 再议 |
| 出站沙箱 | v2 再议 |

---

## 17. 与 `docs/PLAN.md` 的关系

- **路线图与里程碑**以 `docs/PLAN.md` 为准。
- **Agent 网关、HTTP 契约、工具/MCP、多引擎**以 **本文档** 为准；规划章节引用本文，不重复粘贴大段契约以免漂移。
