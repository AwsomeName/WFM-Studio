# Agent 中间过程展示方案设计

## 背景

当前 Agent 框架已有 SSE 流式管道，支持 `tool_call_started`、`tool_call_done`、`text_delta`、`thinking_delta` 等事件（由 `claude_runner.py` 从 Claude Code CLI 的 NDJSON 输出映射而来）。
但工具步骤只显示名称和状态（旋转→✓），不显示输入参数和输出结果，导致用户无法感知 Agent 的实际操作内容。

---

## 第一层：工具输入/输出摘要（低成本，高收益）

### 目标
让工具步骤从 `"工具名..."` → `"读取文件 xxx.dxf..."` → `"读取文件 xxx.dxf ✓ (发现 3 个问题)"`。

### 改动范围

| 层 | 文件 | 改动 |
|---|---|---|
| 后端 | `agent_v2/claude_runner.py` | 从 NDJSON 事件中提取工具 `input` 和 `content`，加入 SSE 帧 |
| 传输 | SSE JSON | `tool_call_started` 已含 `args` 字段；`tool_call_done` 已含 `summary` 字段 |
| 前端接口 | `wfmAgentClient.ts` | `onToolCallStarted` 增加 `args` 参数；`onToolCallDone` 增加 `summary` 参数 |
| 前端服务 | `wfmAgentClientService.ts` | `dispatchSseEvent` 解析并传递新字段 |
| 前端 UI | `wfmChatViewPane.ts` | `addToolStep` / `completeToolStep` 渲染参数和摘要文本 |
| 样式 | `wfmChat.css` | 新增 `.wfm-activity-detail` 样式（淡色、小字） |

### 输出摘要策略
- 截取返回值前 150 字符
- 如果是 JSON/dict，尝试提取关键字段（如 `errors` 数量、`file_path` 等）
- 纯文本直接截断加 `...`

---

## 第二层：Agent 推理摘要（中等成本）

### 目标
在工具调用之间展示 Agent 的"思考过程"，让用户理解 Agent 为什么选择某个工具。

### 方案
- 利用 OpenAI Agents SDK 的 `raw_response_event` 中的 reasoning/thinking 内容（如果模型支持）
- 或提取工具调用前的文本输出片段作为"分析"展示
- 新增 SSE 事件类型 `reasoning`
- 前端以淡色折叠样式展示，标注为"分析中..."

### 改动范围
- 后端：`runner.py` 新增 `reasoning` 事件处理
- 传输：SSE 新增 `EVENT_REASONING` 常量
- 前端接口：`IWfmStreamCallbacks` 新增 `onReasoning(text)` 回调
- 前端 UI：新增 `.wfm-activity-reasoning` 样式和渲染逻辑

---

## 第三层：长任务子进度（较高成本）

### 目标
对 CAD 生成、审图等耗时操作，在工具步骤内部展示子阶段进度。

### 方案
- 工具内部通过回调/队列发射子进度事件
- 新增 SSE 事件 `tool_progress`，携带 `id`（匹配工具调用 ID）、`stage`（阶段名）、`progress`（0-100 可选）
- 前端在工具步骤下方展示进度条或阶段文字

### 改动范围
- 后端工具层：`@function_tool` 函数内部增加进度回调机制
- 传输：SSE 新增 `EVENT_TOOL_PROGRESS` 常量
- 前端接口：`IWfmStreamCallbacks` 新增 `onToolProgress(id, stage, progress?)` 回调
- 前端 UI：在 `addToolStep` 创建的 DOM 内嵌进度指示器

---

## 实施优先级

1. **第一层** — 立即实施，改动小、收益大
2. **第二层** — 视模型 reasoning 能力决定时机
3. **第三层** — 在有明确的长耗时工具需求时实施
