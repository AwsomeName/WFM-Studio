# WFM Studio 真实任务场景（用户故事与 API 映射）

> **用途**：把「任务对话」产品目标落到可验收的故事，并对齐 [wfm-agents `POST /v1/chat`](wfm-agents/wfm_agents/routes/chat.py) 与前端缺口。

---

## 后端请求体（当前）

| 字段 | 必填 | 说明 |
|------|------|------|
| `workspace_root` | 是 | 当前工作区根路径（IDE 已自动注入） |
| `message` | 是 | 用户任务描述 |
| `mode` | 否 | `echo` \| `single` \| `multi`；默认取自环境变量 `WFM_CHAT_MODE`，未设时为 `echo` |
| `engine` | 否 | `crewai`（默认）\| `maf` \| `agenticx` \| `anthropic` |

响应除正文外还包含 `trace_id`（便于日志与评测），IDE 当前同步客户端未展示该字段。

---

## 用户故事 1：打开仓库并确认「任务对话」连通

**作为**开发者，**我要**在打开文件夹后发送一句简单指令，**以便**确认 WFM Studio 与本地 Agent 后端闭环可用。

| 环节 | 行为 |
|------|------|
| 前置 | 后端 `GET /v1/health` 成功；IDE 侧栏显示「WFM Studio 后端已连接」 |
| 操作 | 在「任务对话」输入任意非空消息并发送 |
| 期望 | 收到助手回复；若 `mode` 为默认 `echo`，应答为 echo 类结果（见后端 `recipe_id` / `wfm.echo`） |

**API**：`POST /v1/chat`，仅需 `workspace_root` + `message`（与当前 [WfmAgentClientService](wfm-ide/src/vs/workbench/contrib/wfm/browser/wfmAgentClientService.ts) 一致）。

**前端**：无需新增字段；可后续在辅助栏展示 `trace_id` 便于排错。

---

## 用户故事 2：在 CrewAI 单任务模式下完成「改一个文件」类任务

**作为**开发者，**我要**用自然语言描述对当前仓库的小改动并让 Agent 执行，**以便**减少手写重复编辑。

| 环节 | 行为 |
|------|------|
| 前置 | 后端已配置 CrewAI（如 `WFM_CREWAI_MODEL` 等）；`mode` 为 `single` |
| 操作 | 发送明确任务（例如「在 README 末尾加一行今日日期」） |
| 期望 | 返回可读的执行摘要或变更说明；工具若启用，应在工作区内产生真实变更（依工具策略） |

**API**：`POST /v1/chat`，body 需 **`mode: "single"`**（或运维将 `WFM_CHAT_MODE=single` 作为默认）。可选 **`engine`**（默认 `crewai`）。

**前端缺口**：

- 请求体增加可选 **`mode`**（及可选 **`engine`**）——可先做下拉或设置项，默认仍不传则依赖后端环境变量。
- UI：区分「只读 Echo」与「Crew 执行」的视觉提示（避免用户以为会改仓库时仍为 echo）。

---

## 用户故事 3：固定编排引擎与可观测性（对比 MAF / Agenticx / Anthropic）

**作为**平台维护者，**我要**在同一工作区下切换引擎并保留追问上下文以外的关键元数据，**以便**评估不同后端表现。

| 环节 | 行为 |
|------|------|
| 前置 | 目标引擎已安装且配置合法（如 `anthropic` 需 extras / API Key） |
| 操作 | 指定 `engine` 发送相同 `message` |
| 期望 | 不同引擎返回均可解析；失败时返回明确 HTTP 错误信息 |

**API**：`POST /v1/chat`，body 增加 **`engine`**（`maf` \| `agenticx` \| `anthropic` \| `crewai`）。

**前端缺口**：

- 请求体增加可选 **`engine`**。
- 展示响应中的 **`trace_id`**（及后续若扩展的 `tool_ledger`）——同步接口当前 [ChatReply](wfm-agents/wfm_agents/routes/chat.py) 已含 `trace_id`，前端可只读展示一行「本轮 trace」。

---

## 建议实现顺序

1. 故事 1：保持现状，用文案与状态栏强化「已连接 / 未响应」。
2. 故事 2：扩展 `IWfmAgentClientService.chat` 与设置或下拉，传入 `mode`（优先），再视需要 `engine`。
3. 故事 3：在故事 2 的基础上增加 `engine` 与 `trace_id` 展示；流式与工具进度可对接 `chat_stream` 另开迭代。
