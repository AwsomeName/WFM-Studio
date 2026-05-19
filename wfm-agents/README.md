# wfm-agents

WFM Studio 的 Agent 后端服务（FastAPI + OpenAI Agents SDK）。

## 架构

自 **2026-05** 起，对话后端基于 **OpenAI Agents SDK**（`wfm_agents/agent_v2/`），不再使用自研 runner。迁移原因见 [`docs/WHY_AGENTS_SDK.md`](../docs/WHY_AGENTS_SDK.md)。

```
wfm_agents/
├── agent/
│   ├── __init__.py     # deprecated，仅保留模块声明
│   └── config.py       # 环境变量加载（agent_v2 仍使用）
├── agent_v2/           # ★ 当前运行时
│   ├── agents.py       # Agent 定义：router_agent (编排器) + text_to_cad / cad_review / docx_review
│   ├── context.py      # WfmAgentContext(workspace_root)
│   ├── tools.py        # @function_tool 包装的 workspace + CAD + DOCX 工具
│   ├── sse.py          # SSE 事件编码（含 agent_handoff 事件）
│   └── runner.py       # run_chat() / run_chat_stream() — 路由层唯一入口
├── cad/                # DXF 解析 / 审图 schema
├── gateway/            # [DEPRECATED] 旧 AgentGateway，保留兜底
├── engines/            # [DEPRECATED] 旧 EngineAdapter
├── routes/             # HTTP 薄路由
└── server.py           # FastAPI 入口
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `WFM_OPENAI_API_KEY` 或 `OPENAI_API_KEY` | API Key（必填） | — |
| `WFM_OPENAI_BASE_URL` | 上游 base URL；为空则用 OpenAI 官方 | （空） |
| `WFM_AGENT_MODEL` | 模型 ID（如 `glm-5.1` / `qwen-plus` / `gpt-4o-mini`） | `gpt-4o-mini` |
| `WFM_AGENT_TEMP` | 温度 | `0.3` |
| `WFM_AGENT_MAX_TOOL_ROUNDS` | 工具循环上限 | `16` |
| `WFM_AGENT_API` | `responses` 或 `chat`（上游能力探测） | `chat` |

`engine` / `mode` 请求字段已废弃（接受但忽略，打 warning）。`WFM_DEFAULT_ENGINE` / `WFM_CHAT_MODE` 等旧环境变量不再生效。

启动时自动加载 `wfm-agents/.env`（缺包静默跳过，shell env 优先于 .env）。范例见 [`.env.example`](.env.example)。

## 运行

```bash
cp .env.example .env  # 首次：填入 WFM_OPENAI_API_KEY 等
uv sync --extra dev
uv run uvicorn wfm_agents.server:app --reload --host 127.0.0.1 --port 8765
```

仓库根亦可用：`./scripts/dev.sh`（默认含 DevUI）或 **`./scripts/dev-minimal.sh`（最小闭环）**；先停再起：`./scripts/wfm-up.sh`。日志在 `.wfm-dev/logs/`。

## 接口

所有涉及文件 I/O 的接口都必须携带 `workspace_root`；服务端会强制校验相对路径在 `workspace_root` 内。

| Method | Path | 说明 |
|--------|------|------|
| GET  | `/v1/health` | 健康检查 |
| POST | `/v1/chat` | 对话（agent_v2 runner；`engine`/`mode` 字段已废弃） |
| POST | `/v1/chat/stream` | SSE 流式 |
| POST | `/v1/cad/review` | CAD 审图（同步） |
| POST | `/v1/cad/review/stream` | CAD 审图（SSE 流式） |
| POST | `/v1/workspace/write` | 工作区内写文件 |
| POST | `/v1/workspace/read` | 工作区内读文件 |
| POST | `/v1/admin/mcp/reload` | 重载 MCP 工具列表 |

## 验收

- 单元测试：`cd wfm-agents && uv run pytest -x -q`（75 passed）
- 架构文档：`docs/ARCH_AGENT_SDK_NATIVE.md`
- 迁移说明：`docs/WHY_AGENTS_SDK.md`

## 目录约定

包名 `wfm_agents` 与目录一致，从任意工作目录可 `import wfm_agents.*`，与 `uv run uvicorn wfm_agents.server:app` 子进程可发现包一致。
