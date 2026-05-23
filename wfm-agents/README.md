# wfm-agents

WFM Studio 的 Agent 后端服务（FastAPI + Claude Code CLI）。

## 架构

对话后端基于 **Claude Code CLI**（`wfm_agents/agent_v2/`），通过子进程调用 `claude` 命令行工具，使用 MCP（Model Context Protocol）工具服务器暴露 workspace/CAD/DOCX 操作能力。

```
wfm_agents/
├── agent_v2/               # ★ 当前运行时
│   ├── claude_runner.py     # Claude Code CLI 子进程调用 + NDJSON → SSE 映射
│   ├── wfm_mcp_server.py    # MCP 工具服务器（workspace / CAD / DOCX 工具）
│   ├── sse.py               # SSE 事件编码
│   └── __init__.py
├── cad/                     # DXF 解析 / DWG 转换 / 审图 checks
├── docx/                    # DOCX 解析
├── routes/                  # HTTP 薄路由（chat / chat_stream / cad_review / workspace / health / admin）
├── workspace.py             # 工作区路径解析与安全校验
├── fs_ops.py                # 文件读写操作
├── server.py                # FastAPI 入口
└── config.py                # [遗留] 旧 OpenAI 兼容配置，仅测试引用
```

### 工作原理

1. IDE 前端通过 HTTP/SSE 发送聊天请求到 `/v1/chat` 或 `/v1/chat/stream`
2. 路由层做结构检测（文件引用、附件），构建轻量 prompt
3. `claude_runner.py` 启动 `claude -p <prompt> --output-format stream-json --verbose` 子进程
4. 通过 `--mcp-config` 注册 WFM MCP 工具服务器，Claude 可调用 workspace/CAD/DOCX 工具
5. CLI 输出的 NDJSON 流被映射为 SSE 事件，前端无感消费

### MCP 工具列表

| 工具名 | 说明 |
|--------|------|
| `workspace_read` | 读取工作区内文本文件 |
| `workspace_write` | 写入工作区文件 |
| `cad_file_read` | 解析 CAD 文件概览（图层、实体统计、标题栏） |
| `cad_extract_texts` | 提取文本实体 |
| `cad_extract_dims` | 提取标注实体 |
| `cad_extract_blocks` | 提取块定义 |
| `cad_layer_inspect` | 检查特定图层详情 |
| `cad_check_naming` | 图层/块命名规范检查 |
| `cad_check_titleblock` | 标题栏完整性检查 |
| `cad_check_dim_accuracy` | 标注精度检查 |
| `cad_modify_colors` | 修改实体颜色 |
| `cad_generate_step` | build123d → STEP 编译 |
| `cad_inspect` | STEP 几何检查 |
| `cad_render` | STEP → PNG 渲染 |
| `cad_export_dxf` | 导出 DXF |
| `cad_convert_format` | DWG → DXF 转换 |
| `docx_read` | 解析 Word 文档 |

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `WFM_CLAUDE_MODEL` | Claude 模型（传 `--model` 参数） | `sonnet` |

`engine` / `mode` / `backend` / `recipe` 请求字段已废弃（接受但忽略）。

启动时自动加载 `wfm-agents/.env`（缺包静默跳过，shell env 优先于 .env）。范例见 [`.env.example`](.env.example)。

## 运行

```bash
cp .env.example .env  # 首次：按需填写（Claude Code 默认即用，无需额外配置）
uv sync --extra dev
uv run uvicorn wfm_agents.server:app --reload --host 127.0.0.1 --port 8765
```

仓库根亦可用：`./scripts/dev.sh`（默认含 DevUI）或 **`./scripts/dev-minimal.sh`（最小闭环）**；先停再起：`./scripts/wfm-up.sh`。日志在 `.wfm-dev/logs/`。

## 接口

所有涉及文件 I/O 的接口都必须携带 `workspace_root`；服务端会强制校验相对路径在 `workspace_root` 内。

| Method | Path | 说明 |
|--------|------|------|
| GET  | `/v1/health` | 健康检查 |
| POST | `/v1/chat` | 对话（Claude Code 后端；`engine`/`mode`/`backend` 字段已废弃） |
| POST | `/v1/chat/stream` | SSE 流式对话 |
| POST | `/v1/cad/review` | CAD 审图（同步） |
| POST | `/v1/cad/review/stream` | CAD 审图（SSE 流式） |
| POST | `/v1/workspace/write` | 工作区内写文件 |
| POST | `/v1/workspace/read` | 工作区内读文件 |
| POST | `/v1/admin/mcp/reload` | 重载 MCP 工具列表 |

## 验收

- 单元测试：`cd wfm-agents && uv run pytest -x -q`

## 目录约定

包名 `wfm_agents` 与目录一致，从任意工作目录可 `import wfm_agents.*`，与 `uv run uvicorn wfm_agents.server:app` 子进程可发现包一致。
