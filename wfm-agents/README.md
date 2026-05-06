# wfm-agents

WFM Studio 的 Agent 后端服务（FastAPI、Agent 网关、工具与 MCP 聚合）。

## 依赖与 CrewAI

当前 **CrewAI 默认从 PyPI 安装**（`pyproject.toml` 的 `crewai`）。若需把上游 fork 以 **path / git subtree** 管理，见仓库根 `docs/CREWAI_UPSTREAM.md` 与 `docs/CREWAI_PATCHES.md`；勿在业务代码中写死 `wfm-agents-ref` 等本地未跟踪目录。

## 运行

包名为 **`wfm_agents`**（下划线），**uvicorn 入口**：

```bash
cd /Users/lc/Desktop/WFM/wfm-agents
uv sync --extra dev --extra anthropic
uv run uvicorn wfm_agents.server:app --reload --host 127.0.0.1 --port 8765
```

仅需在生产环境启用 `engine=anthropic` 且希望**减小镜像**时，可单独安装 `wfm-agents[anthropic]`（不把 `anthropic` 带进默认主依赖）。开发者运行 `uv sync --extra dev` 时已包含 `anthropic`，便于 `pytest`。

仓库根亦可用：`./scripts/dev.sh`（默认含 DevUI）或 **`./scripts/dev-minimal.sh`（最小闭环，见 docs/PLAN §8.3）**；先停再起：`./scripts/wfm-up.sh`。日志在 `.wfm-dev/logs/`。

## 接口

所有涉及文件 I/O 的接口都必须携带 `workspace_root`；服务端会强制校验相对路径在 `workspace_root` 内。

| Method | Path | 说明 |
|--------|------|------|
| GET  | `/v1/health` | 健康检查 |
| POST | `/v1/chat` | 对话（默认 echo；`engine` 可切 `crewai` / `anthropic` / `maf` / `agenticx` 等） |
| POST | `/v1/chat/stream` | SSE 流式 |
| POST | `/v1/workspace/write` | 工作区内写文件 |
| POST | `/v1/workspace/read` | 工作区内读文件 |
| POST | `/v1/admin/mcp/reload` | 重载 `wfm_agents/config/mcp_servers.yaml` 与 MCP 工具列表（本机或 `X-WFM-Internal: 1`） |

## 手工与自动化验收

- 快速见 `docs/PLAN.md` §8.3（Step A/D curl 与 `pytest`）
- 契约与错误码见 `docs/ARCH_AGENT_GATEWAY.md`
- 三引擎烟雾测试：`./scripts/engines-smoke.sh`（可选参数：`workspace_root`）

## 可选依赖

- `wfm-agents[anthropic]`：Claude Messages API（`engine=anthropic`）。环境变量见下节。
- `wfm-agents[agenticx]`：预留给未来官方 SDK；当前通过本地 DevUI 适配。

### Anthropic 引擎（`engine=anthropic`）

安装：`uv sync --extra dev --extra anthropic`（或 `pip install wfm-agents[anthropic]`）。

| 变量 | 说明 |
|------|------|
| `WFM_ANTHROPIC_API_KEY` | API Key（优先）；未设置则用 `ANTHROPIC_API_KEY` |
| `WFM_ANTHROPIC_MODEL` | 模型 ID，默认 `claude-sonnet-4-20250514` |
| `WFM_ANTHROPIC_MAX_TOOL_ROUNDS` | 模型↔工具往返轮数上限，默认 `16` |
| `WFM_ANTHROPIC_BASE_URL` | 可选，自定义 API 根 URL（代理/兼容端） |

工具与 MCP 仍经统一 Tool Gateway；引擎内不直连 MCP。

## 多引擎适配（AgenticX / MAF）

`engine=agenticx` 与 `engine=maf` 当前通过本地 DevUI OpenAI-compatible API 打通：

- `WFM_AGENTICX_DEVUI_URL`（默认 `http://127.0.0.1:18081`）
- `WFM_AGENTICX_ENTITY_ID`（默认 `agent_weather`）
- `WFM_MAF_DEVUI_URL`（默认 `http://127.0.0.1:18082`）
- `WFM_MAF_ENTITY_ID`（默认 `agent_weather`）

只要对应 DevUI 服务已启动，`/v1/chat` 与 `/v1/chat/stream` 都可直接切换 `engine` 调用。

## 目录约定

包名 `wfm_agents` 与目录一致，从任意工作目录可 `import wfm_agents.*`，与 `uv run uvicorn wfm_agents.server:app` 子进程可发现包一致。
