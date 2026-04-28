# wfm-agents

WFM Studio 的 Agent 后端服务（FastAPI、Agent 网关、工具与 MCP 聚合）。

## 依赖与 CrewAI

当前 **CrewAI 默认从 PyPI 安装**（`pyproject.toml` 的 `crewai`）。若需把上游 fork 以 **path / git subtree** 管理，见仓库根 `docs/CREWAI_UPSTREAM.md` 与 `docs/CREWAI_PATCHES.md`；勿在业务代码中写死 `wfm-agents-ref` 等本地未跟踪目录。

## 运行

包名为 **`wfm_agents`**（下划线），**uvicorn 入口**：

```bash
cd /Users/lc/Desktop/WFM/wfm-agents
uv sync --extra dev
uv run uvicorn wfm_agents.server:app --reload --host 127.0.0.1 --port 8765
```

仓库根亦可用：`./scripts/dev.sh`（默认后台起上述 uvicorn + IDE watch，日志在 `.wfm-dev/logs/`）。

## 接口

所有涉及文件 I/O 的接口都必须携带 `workspace_root`；服务端会强制校验相对路径在 `workspace_root` 内。

| Method | Path | 说明 |
|--------|------|------|
| GET  | `/v1/health` | 健康检查 |
| POST | `/v1/chat` | 对话（默认 echo；`engine` 可切 `crewai` / `agenticx` 等） |
| POST | `/v1/chat/stream` | SSE 流式 |
| POST | `/v1/workspace/write` | 工作区内写文件 |
| POST | `/v1/workspace/read` | 工作区内读文件 |
| POST | `/v1/admin/mcp/reload` | 重载 `wfm_agents/config/mcp_servers.yaml` 与 MCP 工具列表（本机或 `X-WFM-Internal: 1`） |

## 手工与自动化验收

- 快速见 `docs/PLAN.md` §8.3（Step A/D curl 与 `pytest`）
- 契约与错误码见 `docs/ARCH_AGENT_GATEWAY.md`

## 可选依赖

- `wfm-agents[agenticx]`：`[agenticx]` 为预留空 extra；当前 `engine=agenticx` 使用 **in-tree 最小**实现，无需额外包。真 SDK 合入后在此声明版本。

## 目录约定

包名 `wfm_agents` 与目录一致，从任意工作目录可 `import wfm_agents.*`，与 `uv run uvicorn wfm_agents.server:app` 子进程可发现包一致。
