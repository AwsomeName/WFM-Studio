# Uni-Studio Agent 网关 — 研发推进手册

> ⚠️ **状态：已废弃（DEPRECATED, 2026-05-14）**
>
> 本文是旧 `AgentGateway + EngineAdapter` 抽象的研发推进手册，**对话主链路已切到 SDK 原生 runner**。
> 新方案与迁移步骤见 **[`ARCH_AGENT_SDK_NATIVE.md`](ARCH_AGENT_SDK_NATIVE.md)（§12 迁移步骤）**。
>
> 本文保留为历史背景；新的研发任务请直接照 `ARCH_AGENT_SDK_NATIVE.md` 推进。

---

> **历史用途**：给 AI / 工程师按步推进实现的操作手册。
> **历史规格来源**：`docs/ARCH_AGENT_GATEWAY.md`（**亦已废弃**）。
> **路线图**：`docs/PLAN.md`（里程碑在项目整体路线中的位置）。
> **基本原则**（仅适用本文档内部一致性）：若本文与旧 ARCH 冲突，以旧 ARCH 为准；新方案以 `ARCH_AGENT_SDK_NATIVE.md` 为准。

---

## 0. 阅读清单（开工前必读）

1. `docs/ARCH_AGENT_GATEWAY.md` — 契约、数据模型、错误码、默认参数。
2. `docs/PLAN.md` §4.4 / §8 — 现阶段里程碑。
3. 现状代码（作为迁移起点）：
   - `wfm-agents/wfm_agents/server.py`
   - `wfm-agents/wfm_agents/routes/chat.py`
   - `wfm-agents/wfm_agents/routes/workspace_ops.py`
   - `wfm-agents/wfm_agents/workspace.py`
   - `wfm-agents/wfm_agents/crewai_runtime.py`
4. 现状前端：`wfm-ide/src/vs/workbench/contrib/wfm/`

---

## 1. 总体研发策略

- **不推倒重写**：现有 `chat.py` / `crewai_runtime.py` / `workspace_ops.py` 全部保留并逐步迁移到新分层（见 §2）。
- **小步快跑**：每个里程碑都要能单独跑通、可单独回滚。
- **契约先行**：Pydantic 模型与错误码先落盘，再填内部实现。
- **流式为一等公民**：v1 必须同时交付 `/v1/chat`（同步）与 `/v1/chat/stream`（SSE），不是附加项。
- **硬规范不可破**：引擎绝不直接访问磁盘 / 子进程 / MCP，一律走 `ToolHandle.invoke`。

---

## 2. 目标目录布局（迁移终态）

```
wfm-agents/wfm_agents/
├── __init__.py
├── server.py                         # FastAPI 入口（保持）
├── fs_ops.py                         # 新：工作区 I/O 核心（路由 + 内置工具共用）
├── workspace.py                      # 保留：resolve_workspace_root / resolve_within
├── routes/
│   ├── health.py                     # 保留
│   ├── chat.py                       # 改：薄化为 AgentGateway 适配
│   ├── chat_stream.py                # 新：SSE /v1/chat/stream
│   ├── workspace_ops.py              # 改：调用 fs_ops
│   └── admin.py                      # 新：POST /v1/admin/mcp/reload（后置）
├── gateway/
│   ├── __init__.py
│   ├── models.py                     # TurnRequest / TurnResult / StreamEvent / ...
│   ├── session.py                    # SessionContext（含 cancel_event）
│   ├── agent_gateway.py              # run_turn / stream_turn 编排
│   └── stream_events.py              # SSE 序列化辅助
├── tools/
│   ├── __init__.py
│   ├── spec.py                       # ToolSpec / ToolResult / ToolCallRecord
│   ├── policy.py                     # ToolPolicy + 默认值
│   ├── registry.py                   # ToolRegistry（含 snapshot 机制）
│   ├── executor.py                   # ToolExecutor（policy / 超时 / 审计 / 错误码）
│   ├── handle.py                     # ToolHandle（给引擎用的薄接口）
│   ├── builtin_provider.py           # wfm.workspace_read / wfm.workspace_write 等
│   └── mcp/
│       ├── __init__.py
│       ├── config.py                 # mcp_servers.yaml 加载 + ${env:X} 解析
│       ├── connection.py             # stdio / SSE 连接
│       └── cluster.py                # MCPCluster：聚合 list_tools / call_tool
├── engines/
│   ├── __init__.py
│   ├── base.py                       # EngineAdapter Protocol
│   ├── crewai_engine.py              # 从 crewai_runtime 迁入，并包装投影
│   ├── maf_engine.py                 # 501 / 未安装时 ENGINE_NOT_INSTALLED
│   └── agenticx_engine.py            # 同上
└── observability/
    ├── __init__.py
    ├── trace.py                      # trace_id / span_id
    └── errors.py                     # 统一错误码枚举
```

**兼容策略**：`crewai_runtime.py` 保留到 M2 完成后再删除或 alias 到 `engines/crewai_engine.py`。

---

## 3. 里程碑总览

| 里程碑 | 名称 | 交付物 | 是否阻塞下一步 |
|---|---|---|---|
| M0 | 契约与骨架 | `gateway/models.py`、`tools/spec.py`、错误码、目录骨架 | 是 |
| M1 | `fs_ops` + 内置工具 | `fs_ops.py`、`BuiltinToolProvider`、`ToolRegistry/Executor`、`ToolHandle` | 是 |
| M2 | `AgentGateway` + `CrewAIEngine`（同步） | `/v1/chat` 走新链路，行为等价旧版 | 是 |
| M3 | **流式 SSE**（v1 必须） | `/v1/chat/stream`、事件类型冻结 | 是 |
| M4 | MCP 聚合 | `MCPCluster` + YAML + `mcp.*` 投影 + reload | 否（可与 M5 并行） |
| M5 | MAF / AgenticX 适配 | 引擎 stub（未装返 `ENGINE_NOT_INSTALLED`），装后能过冒烟 | 否 |
| M6 | **Eval harness**（🔄 in-progress，`feat/backend-eval` 分支） | fixtures + 四引擎对比（CrewAI/Anthropic/MAF/AgenticX） + CSV 报表 | 否 |
| M7 | PPTX ToolProvider | `uni.pptx_read`/`uni.pptx_write`/`uni.pptx_slide_edit`/`uni.pptx_render_slide`/`uni.pptx_to_pptist`/`uni.pptist_to_pptx` + HTTP 路由 | 否（`feat/ppt-editor` 分支） |
| M8 | Proposal ToolProvider | `uni.proposal_outline`/`uni.proposal_write_section`/`uni.proposal_review`/`uni.proposal_format` + HTTP 路由 | 否（`feat/doc-generation` 分支） |

每个里程碑完成后：`pytest` 全绿、README 更新、`PLAN.md` 的 Step 勾选更新。

---

## 4. 里程碑实施细则

### M0 — 契约与骨架

**目标**：把 ARCH §8 的数据模型与 §10 的错误码用代码固化，新目录空架子建好。

**动作**：

1. 新建目录 `gateway/` `tools/` `engines/` `observability/` 与对应 `__init__.py`。
2. `gateway/models.py` 定义：
   - `TurnRequest` / `TurnResult` / `UsageStats` / `ToolCallRecord`（客户端可见子集）
   - `StreamEvent` discriminated union（`type` 字面量 + 具体负载类）
3. `tools/spec.py` 定义：
   - `ToolSpec`（`fqn`、`title`、`json_schema`、`risk_tier`、`origin`）
   - `ToolResult`（`ok`、`data`、`error`）
4. `observability/errors.py` 定义错误码字符串常量枚举（ARCH §10）。
5. `observability/trace.py` 提供 `new_trace_id()` / `new_span_id()`。

**约束**：

- Pydantic v2；所有模型加 `model_config = ConfigDict(extra="forbid")`。
- `StreamEvent` 的 `type` 值严格为 ARCH §4.3 所列 5 种。
- 暂不改动现有路由。

**验收**：

- `pytest` 一条最小用例：`TurnRequest.model_validate(...)` 成功；`StreamEvent` 解析 5 种 `type` 各跑一次。
- `python -c "from wfm_agents.gateway.models import TurnRequest, StreamEvent"` 不报错。

---

### M1 — `fs_ops` + 内置工具 + ToolGateway 基座

**目标**：让"工作区文件 I/O"在 HTTP 路由与内置工具两处共用同一份实现；给 `AgentGateway` 提供可运行的 `ToolHandle`。

**动作**：

1. 新建 `wfm_agents/fs_ops.py`：
   - `read_text(workspace_root, relative_path) -> str`
   - `write_text(workspace_root, relative_path, content, overwrite=True) -> WriteResult`
   - `list_dir(workspace_root, relative_path=".") -> list[DirEntry]`（可延后到 M1.5）
   - 所有函数内部 `resolve_within`；任何越界抛 `WorkspaceViolation`。
2. 重构 `routes/workspace_ops.py` 改为调用 `fs_ops`；HTTP 行为不变。
3. 新建 `tools/builtin_provider.py`：
   - 注册 `wfm.workspace_read`、`wfm.workspace_write`（未来再加 `wfm.list_dir`）。
   - 工具 `execute(args, ctx)` 内部仍走 `fs_ops`。
4. 新建 `tools/registry.py`：
   - `ToolRegistry.build(ctx, providers)` → 生成 **工具 snapshot**（list[ToolSpec] + dispatch map）。
   - 暴露 `snapshot()`、`find(fqn)`。
5. 新建 `tools/policy.py`：
   - 默认值按 ARCH §11；字段：`max_tool_calls_per_turn`、`single_tool_timeout_ms`、`disabled_fqns`、`mcp_tier_allowlist`。
6. 新建 `tools/executor.py`：
   - `execute(fqn, args, ctx)`：policy 检查 → 查注册表 → 超时包装（`asyncio.wait_for`）→ 捕获异常映射到错误码 → 返回 `ToolResult` + 生成 `ToolCallRecord`。
   - 记录耗时、args 脱敏（默认对 `password`/`api_key`/`secret` 等 key 置 `"***"`）。
7. 新建 `tools/handle.py`：
   - `ToolHandle`：`list_tool_specs()`、`invoke(fqn, args) -> ToolResult`（同步对外、内部 `asyncio.run_until` 或用同步包装）。
   - 要求可在同步引擎（CrewAI）与异步流程中共用。

**约束**：

- 本里程碑 **不引入** MCP，仅 Builtin。
- `ToolExecutor` 是 **唯一** 审计写入点。
- 每轮工具 snapshot 只在 `AgentGateway` 开头构建一次（见 M2）。

**验收**：

- 单元测试：
  - `fs_ops.write_text` 对越界路径抛 `WorkspaceViolation`。
  - `BuiltinToolProvider` 返回至少 2 个 `ToolSpec`。
  - `ToolExecutor` 针对 `disabled_fqns` 拦截 → 返回 `POLICY_DENY`。
  - 超时用 fake tool（`time.sleep(30)`）触发 → `TOOL_TIMEOUT`。
- `routes/workspace_ops.py` 通过原有 `tests/test_api.py` 不变（绿灯）。

---

### M2 — `AgentGateway` + `CrewAIEngine`（同步链路迁移）

**目标**：`POST /v1/chat` 改为 `AgentGateway.run_turn`；CrewAI 的 LLM 编排收敛到 `CrewAIEngine`；行为与现有 `chat.py` 等价。

**动作**：

1. 新建 `gateway/session.py`：
   - `SessionContext(workspace_root, session_id, trace_id, engine, model_override, cancel_event, client_meta)`。
2. 新建 `gateway/agent_gateway.py`：
   - `class AgentGateway`：持有 `providers`（builtin，MCP 后补）、`engine_registry`、`default_policy`。
   - `async def run_turn(req) -> TurnResult`：
     1. `resolve_workspace_root`
     2. 构建 `SessionContext` + `trace_id`
     3. `ToolRegistry.build(ctx, providers)` → **snapshot**
     4. `ToolHandle` 绑定 snapshot + executor
     5. `engine = engine_registry.get(req.engine)`；未装 → `ENGINE_NOT_INSTALLED`
     6. `result = await asyncio.to_thread(engine.run_turn, ctx, tool_handle)` （CrewAI 同步）
     7. 汇总 `tool_ledger`（从 executor 取）、`trace_id`、`usage`
3. 新建 `engines/base.py`：`EngineAdapter` Protocol（含 `run_turn` 与 `stream_turn`，见 M3 再补流式实现）。
4. 新建 `engines/crewai_engine.py`：
   - 把 `crewai_runtime.py` 的逻辑迁入；外部接口改为 `run_turn(ctx, tools) -> TurnResult`。
   - **暂不** 给 Crew 暴露工具（工具投影放 M2.5 或 M4 之后）；第一步只保证"文本进、文本出"。
5. 改造 `routes/chat.py`：
   - 保留旧的 `ChatRequest/ChatReply` 字段，但内部：
     - 构造 `TurnRequest(engine="crewai", ...)`；
     - 调用 `agent_gateway.run_turn`；
     - 将 `TurnResult.content` 填回 `ChatReply.content`，保留 `received_at` 字段兼容。
   - `mode=echo` 保留作为调试通道（engine 仍为 crewai，但 `CrewAIEngine` 支持识别 `echo` recipe_id 回退到本地 echo；或单独 `EchoEngine`——选后者更干净）。
6. 新建 `engines/echo_engine.py`（可选但推荐）：给联调用，无需 LLM。

**约束**：

- 保留旧 `crewai_runtime.py` 一版兼容导入（`from .crewai_runtime import run_crewai_chat`）直到 M3 完成。
- HTTP 字段名不得删减，只允许新增（`trace_id` 等）。

**验收**：

- 原 `tests/test_api.py` 全绿（echo 路径）。
- 新增测试：
  - `TurnRequest(engine="crewai")` + mock `CrewAIEngine` → 正确返回 `trace_id` 与 `engine=crewai`。
  - `engine="maf"` → `ENGINE_NOT_INSTALLED`。
- 手动联调：WFM Studio 右侧 AI 面板仍可收到回复。

---

### M3 — 流式 `/v1/chat/stream`（v1 必须）

**目标**：SSE 与同步接口并列交付；事件类型冻结。

**动作**：

1. `gateway/stream_events.py`：
   - `encode_sse(event: StreamEvent) -> bytes`：`f"data: {json}\n\n".encode("utf-8")`。
   - 提供 `make_text_delta / make_tool_start / make_tool_end / make_done / make_error` 工厂。
2. `engines/base.py`：补 `async def stream_turn(ctx, tools) -> AsyncIterator[StreamEvent]`。
3. `engines/crewai_engine.py`：
   - v1 **简化策略**：CrewAI 同步阻塞 → 用后台线程跑 `run_turn`，主协程每 N ms 读取 `partial buffer`（若框架不暴露 token，则退化为"一次性 `text_delta`+ `done`"）。
   - 至少保证事件顺序正确：`tool_start`/`tool_end` 必须由 `ToolExecutor` 发出（通过 `ctx.event_sink` 注入）。
4. `tools/executor.py`：
   - 增加可选 `event_sink: asyncio.Queue[StreamEvent] | None`；执行工具时异步 emit `tool_start` 与 `tool_end`（带 `call_id`、`fqn`、`ok`、`latency_ms`、`error_code`）。
5. 新路由 `routes/chat_stream.py`：
   ```
   POST /v1/chat/stream
   ↳ StreamingResponse(media_type="text/event-stream")
   ```
   - 实现细节：
     - 开一个 `asyncio.Queue` 作为 `event_sink`；
     - 启动 `engine.stream_turn`（或 wrap `run_turn`）为后台 task；
     - 主协程 `async for event in queue: yield encode_sse(event)`；
     - 监听 `request.is_disconnected()` → `ctx.cancel_event.set()` → 等待 task 退出。
6. `gateway/agent_gateway.py`：
   - 新增 `async def stream_turn(req) -> AsyncIterator[StreamEvent]`；与 `run_turn` 共享前置构造。
7. `routes/chat.py`：
   - 作为 `/v1/chat` 保留；内部可复用 `stream_turn`，把事件折叠成最终 `TurnResult`（或保持独立实现）。v1 建议 **独立实现**，避免同步路径被流式 bug 牵连。

**约束**：

- **事件 JSON 与 ARCH §4.3 完全一致**；字段名不得临时改。
- 任一工具调用必须成对产生 `tool_start` 与 `tool_end`；异常也要 emit `tool_end(ok=False, error_code=...)`。
- 客户端断连必须触发取消路径，禁止出现"连接断了引擎还在烧 LLM"。

**验收**：

- 集成测试（`pytest` + `httpx.AsyncClient`）：
  - 流式返回 5 种事件至少覆盖 3 种（`text_delta`、`done`，用 mock 引擎加一次 `tool_start/tool_end`）。
  - 断连场景：客户端在中途关闭 → `ctx.cancel_event.is_set()` 为 True。
  - 错误场景：引擎抛异常 → 最后一条事件为 `error`，`code == "ENGINE_ERROR"`。
- 手动：curl 跑：
  ```
  curl -N -X POST http://127.0.0.1:8765/v1/chat/stream \
    -H 'Content-Type: application/json' \
    -d '{"workspace_root":"/tmp/demo","message":"你好","engine":"crewai"}'
  ```

---

### M4 — MCP 聚合

**目标**：`mcp.*` 工具通过统一 `ToolGateway` 暴露给所有引擎；配置热更用 admin API。

**动作**：

1. 依赖：`pyproject.toml` 增加 MCP 客户端库（选定版本后锁定）；暂放 `dependencies`，不走 optional（MCP 是核心能力）。
2. `tools/mcp/config.py`：
   - 解析 `config/mcp_servers.yaml`（路径默认 `wfm-agents/config/mcp_servers.yaml`，可 `WFM_MCP_CONFIG` 覆盖）。
   - 替换 `${env:NAME}` / `${secret:NAME}`；未命中 → 启动报错。
3. `tools/mcp/connection.py`：
   - `stdio` 与 `sse` 两种连接；`start()` / `stop()` / `list_tools()` / `call_tool()`。
   - 懒连接；首次使用时再 spawn。
4. `tools/mcp/cluster.py`：
   - 聚合多个 server；`list_tools` 带 TTL（默认 `mcp_list_tools_ttl_ms=30000`）。
   - 映射为 `mcp.{server_id}.{tool}`；`server_id` 校验 `^[a-z0-9_-]+$`。
5. `tools/registry.py`：
   - `providers = [BuiltinToolProvider, MCPClusterProvider]`；注册表按 `fqn` 合并；重名（理论不存在）→ 启动失败。
6. `tools/executor.py`：
   - 调用 `mcp.*` 时走 `cluster.call_tool`；错误映射：
     - 连接失败 → `MCP_CONNECT_ERROR`
     - 超时 → `MCP_TIMEOUT`
7. `routes/admin.py`：
   - `POST /v1/admin/mcp/reload`：重新加载 YAML、关闭旧连接、重建集群；仅本机网络或通过 `X-WFM-Internal` 鉴权。
8. 大返回体处理：`executor.py` 在拿到工具结果后检查 `artifact_inline_threshold_bytes`（默认 `32768`）；超限写入 `{workspace_root}/.wfm/artifacts/{trace_id}/{n}.json`，`data` 换为 `{"summary": "...", "artifact_ref": "..."}`。

**约束**：

- 进行中 turn 绝不重新 list_tools（snapshot 冻结原则）。
- Secrets 不得进日志；`args_redacted` 对 MCP 调用同样生效。

**验收**：

- 单 server PoC：起一个本地 stdio MCP（template server 或自写 echo server），通过 `/v1/chat/stream` 让 CrewAI 调用一个 `mcp.*` 工具，前端看到 `tool_start`/`tool_end` 事件。
- reload：修改 YAML，调用 `/v1/admin/mcp/reload`，下一轮可用新工具。
- `disabled_fqns` 包含某 MCP 工具 → 调用返回 `POLICY_DENY`。

---

### M5 — MAF / AgenticX 适配

**目标**：打通"多引擎可选"；未装时不崩，装上后能冒烟。

**动作**：

1. `pyproject.toml`：
   ```
   [project.optional-dependencies]
   maf = ["microsoft-agent-framework>=<version>"]
   agenticx = ["agenticx>=<version>"]
   ```
2. `engines/maf_engine.py` / `engines/agenticx_engine.py`：
   - 顶部 `try: import ...; _AVAILABLE=True except ImportError: _AVAILABLE=False`
   - `run_turn` / `stream_turn` 内若 `not _AVAILABLE` → 抛 `EngineNotInstalled` → gateway 转 `ENGINE_NOT_INSTALLED`。
   - 工具投影（见 ARCH §7）：将 `ToolSpec.json_schema` 动态生成 Pydantic 模型，再包成该框架原生 Tool；`execute` 内回调 `tool_handle.invoke(fqn, args)`。
3. 冒烟用例（optional pytest，只在 extra 安装时跑）：
   - 使用 `wfm.workspace_read` + mock LLM → 回读工作区 README → 返回首行。

**约束**：

- 引擎侧 **不得自行** 加载 MCP / 访问文件；工具投影是唯一入口。
- 工具名必须保持 `fqn` 原样，以便日志对齐。

**验收**：

- 未安装 extras：`engine=maf` → 400/502 + `ENGINE_NOT_INSTALLED`，消息包含安装命令。
- 安装 extras：冒烟 passes；流式事件完整。

---

### M6 — Eval harness（🔄 in-progress，`feat/backend-eval` 分支）

**目标**：同一 fixture 切换 `engine`，对比已拉取代码的四引擎，导出对比数据。

**动作**：

1. 新目录 `wfm-agents/tests/eval/`：
   - `fixtures/*.json`：每份含 `workspace_seed`（预置文件）、`message`、`expected_tool_sequence`。
   - `eval_harness.py`：发送相同 TurnRequest 到 4 引擎（crewai/anthropic/maf/agenticx），记录时间/工具成功率/输出。
   - `eval_scenarios.py`：5 个场景 fixture（基础对话 / 文件读取 / PPT 大纲 / 标书完整生成 / 错误恢复）。
   - `eval_report.py`：生成对比矩阵（JSON + markdown）。
   - 输出 `eval/results/{timestamp}.csv`，列：`engine, fixture, ok, tool_sequence_match, latency_ms, input_tokens, output_tokens, cost_usd, error_code`。
2. **不做** LLM-as-judge 自动化（见 ARCH §10）。
3. **深度改造探索**：
   - 研究 CrewAI 内部 tool 调用机制，探索能否走 ToolHandle
   - 研究 MAF/AgenticX SDK，探索能否绕过 DevUI proxy 直用 SDK + ToolHandle
   - Anthropic 引擎流式增强：`client.messages.stream()` 实现 token-by-token TextDelta

**验收**：

- `uv run python -m eval.run --fixtures eval/fixtures --out eval/results` 生成 CSV 文件。
- CSV 行数 ≥ fixtures 数 × 可用引擎数。
- 产出 `docs/EVAL_REPORT.md`：选定主引擎 + 备选引擎。

---

### M7 — PPTX ToolProvider（`feat/ppt-editor` 分支）

**目标**：提供 PPTX 读写 + PPTist 双向转换工具，供 PPT 编辑器调用。

**动作**：

1. 新建 `tools/pptx_provider.py`：
   - 注册 6 个工具：`uni.pptx_read`/`uni.pptx_write`/`uni.pptx_slide_edit`/`uni.pptx_render_slide`/`uni.pptx_to_pptist`/`uni.pptist_to_pptx`
   - 工具实现用 `python-pptx`，所有路径通过 `resolve_within` 安全校验
2. `pyproject.toml` 加 `python-pptx>=1.0.2` 依赖
3. 注册 `PptxToolProvider` 入 `AgentGateway` providers 列表
4. 新建 `routes/pptx_ops.py`：4 条 HTTP 路由
5. 注册入 `server.py`

**约束**：
- 工具一律通过 `ToolHandle.invoke` 被引擎调用（硬规范）
- HTTP 路由是 ToolProvider 的薄包装

**验收**：
- pytest 覆盖：PPTX 读写、PPTist 转换、越界路径拒绝
- 详细规格见 `docs/ARCH_PPT_EDITOR.md`

---

### M8 — Proposal ToolProvider（`feat/doc-generation` 分支）

**目标**：提供标书/方案生成工具，供 AI 工作流调用。

**动作**：

1. 新建 `tools/proposal_provider.py`：
   - 注册 4 个工具：`uni.proposal_outline`/`uni.proposal_write_section`/`uni.proposal_review`/`uni.proposal_format`
   - 工具背后调用 LLM，但通过 ToolHandle 统一接口
2. 注册 `ProposalToolProvider` 入 `AgentGateway` providers 列表
3. 新建 `routes/proposal_ops.py`：3 条 HTTP 路由
4. 注册入 `server.py`

**约束**：
- 工具一律通过 `ToolHandle.invoke` 被引擎调用（硬规范）
- recipe_id `uni.proposal_generate` 的具体实现取决于 M6 eval 结果（硬依赖）
- 详细规格见 `docs/ARCH_DOC_GENERATION.md`

**验收**：
- pytest 覆盖：outline 生成、section 撰写、review 评分、format 输出
- 产出 `docs/EVAL_REPORT.md`：选定主引擎 + 备选引擎。

---

## 5. 横切关注点（所有里程碑都要遵守）

### 5.1 错误码统一

- 全部错误经 `observability/errors.py` 字符串常量；HTTP 层把 `error_code` 放进 `detail`。
- 表格与 ARCH §10 保持一致；增加新码必须先改 ARCH。

### 5.2 日志

- 结构化 JSON 一行一条：`{ts, level, trace_id, span_id, event, fqn?, engine?, latency_ms?, ok?, error_code?}`。
- `args_redacted` 只进日志，不进响应。

### 5.3 并发模型

- FastAPI 路由 `async`；同步框架（CrewAI）包进 `asyncio.to_thread`。
- `asyncio.Queue` 作为流式事件 sink；不要用全局队列。

### 5.4 超时与限额

- 所有默认值来自 ARCH §11；禁止硬编码到业务逻辑中，必须通过 `ToolPolicy`。
- 单工具超时 `asyncio.wait_for`；MCP 集群级超时在 `cluster.call_tool` 中实现。

### 5.5 测试基线

- 每个里程碑结束：
  - `uv run pytest` 全绿
  - `uv run ruff check wfm_agents` 或已配置的 linter 全绿
  - 手动联调脚本（见各节 `curl`/pytest 片段）

### 5.6 文档同步

- 完成一个里程碑：
  - 更新 `docs/PLAN.md` §8 的对应勾选
  - 若出现与 ARCH 的偏差：**先改 ARCH**，再改本文档，再改代码

---

## 6. 非目标与陷阱提醒

**v1 明确不做**：

- 跨轮记忆持久化（`session_id` 仅日志/限流）
- `turn_id` 幂等去重
- 显式 `POST /v1/cancel`（断连即取消已足够）
- MCP 工具别名 / 优先级合并（只做 `disabled_fqns`）
- MCP 流式 progress 事件（只取最终结果）
- LLM-as-judge 自动评测
- 多进程 / sidecar 部署
- 出站网络沙箱

**易犯错误**：

1. **在引擎内部直接 `open(path)` 或跑 `subprocess`**：违反硬规范，必须通过 `ToolHandle.invoke("wfm.workspace_read", ...)`。
2. **turn 中途重新 `list_tools`**：导致 schema 漂移崩溃；工具 snapshot 必须冻结。
3. **流式里 `tool_start` 没配对的 `tool_end`**：前端 UI 会卡死在"调用中"。
4. **断连不取消**：造成 LLM 费用泄漏。
5. **`args` 明文进日志**：违反脱敏规则。
6. **用同步 `requests` 调外部服务**：阻塞事件循环；必须 `httpx.AsyncClient` 或线程池。
7. **CORS 继续 `allow_origins=["*"]` 上线**：v1 调试期 OK，正式打包前必须收紧。

---

## 7. 单次 PR 的最小单元建议

为方便审阅与回滚，建议按以下粒度切 PR：

| PR | 内容 | 近似规模 |
|---|---|---|
| PR-1 | M0 全部 | 300-500 行，几乎无逻辑 |
| PR-2 | M1 fs_ops + workspace_ops 迁移 | 400-600 行 |
| PR-3 | M1 ToolRegistry/Executor/Handle + Builtin | 500-800 行 |
| PR-4 | M2 AgentGateway + CrewAIEngine 迁移 | 500-800 行 |
| PR-5 | M3 SSE 流式（独立 PR，便于回滚） | 600-900 行 |
| PR-6 | M4 MCP（按需再拆 config / cluster / executor 集成 / admin reload） | 多 PR |
| PR-7 | M5 引擎 stub + 投影 | 每引擎 1 PR |
| PR-8 | M6 eval harness | 1 PR |

每个 PR 的描述里 **必须** 列出：

- 对应 ARCH 章节
- 验收脚本/命令
- 是否修改 ARCH（若是，附带 ARCH diff）

---

## 8. 完成定义（DoD）

所有里程碑完成后，满足以下条件方可宣称"v1 Agent 网关上线"：

- [ ] `POST /v1/chat` 与 `POST /v1/chat/stream` 均可在真实 CrewAI 引擎下跑通
- [ ] 至少 1 个 MCP server（本地）通过 `mcp.*` 工具被调用，且事件流完整
- [ ] MAF / AgenticX 至少有 1 家可跑通相同 fixture
- [ ] 所有工具调用带 `trace_id`；所有异常归一到已列错误码
- [ ] `docs/ARCH_AGENT_GATEWAY.md` 与实际实现一致；`PLAN.md` 勾选全部更新
- [ ] Eval harness 一次完整运行并留存 CSV
- [ ] `args` 明文不出现在任何日志与响应中
- [ ] 客户端断连能真正取消引擎执行（流式链路）
