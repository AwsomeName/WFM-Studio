# 开发环境与启动基线

> **更新日期**：2026-05-07  
> **关联**：`docs/PLAN.md` §3、`scripts/dev.sh`

---

## 1. 系统依赖

| 依赖 | 版本要求 | 安装方式 |
|------|----------|----------|
| Node.js | 22.22.1（以 `.nvmrc` 为准） | `nvm install 22.22.1 && nvm use 22.22.1` |
| npm | 10.x+ | 随 Node.js 安装 |
| Python | 3.11+ | `uv` 自行管理，系统 Python 可低于此 |
| uv | 最新 | `curl -LsSf https://astral.sh/uv/install.sh | sh` |
| Xcode CLI Tools | 最新 | `xcode-select --install` |
| Git | 最新 | 系统自带或 `brew install git` |

**macOS 特殊说明**：
- `uv` 安装后可能不在 PATH（常见于 pip --user 安装），需加入 `~/.zshrc`：
  ```bash
  export PATH="$HOME/Library/Python/3.9/bin:$PATH"
  ```
- `uv` 会自动下载和管理 Python 3.11+，系统 Python 版本不影响运行

---

## 2. 一键启动

### 2.1 最小闭环（推荐首次使用）

```bash
cd /Users/apple/Desktop/WFM-Studio
./scripts/dev-minimal.sh
```

等价于 `./scripts/dev.sh --no-agent-devuis`，只启动：
1. wfm-agents 后端（`http://127.0.0.1:8765`）
2. IDE watch 增量编译
3. OSS IDE（Electron 工作台）

### 2.2 全套启动（含 AgenticX/MAF DevUI）

```bash
./scripts/dev.sh
```

额外启动 AgenticX DevUI（18081）和 MAF DevUI（18082）。

### 2.3 常用启动变体

| 命令 | 用途 |
|------|------|
| `./scripts/dev-minimal.sh` | 最小闭环 |
| `./scripts/dev.sh --smoke-chat` | 启动后自动 curl 验证 /v1/chat |
| `./scripts/dev.sh --no-ide` | 只起后端，不开 IDE |
| `./scripts/dev.sh --no-backend` | 只起 IDE，复用已有后端 |
| `./scripts/dev.sh --kill-port` | 8765 被占时强杀旧进程 |
| `./scripts/dev.sh --tail` | 前台跟踪所有日志 |

### 2.4 停止服务

```bash
./scripts/dev-stop.sh
```

---

## 3. 手动启动（分步骤）

```bash
# 终端 1: 后端
cd wfm-agents
uv sync --extra dev
uv run uvicorn wfm_agents.server:app --reload --host 127.0.0.1 --port 8765

# 终端 2: IDE 增量编译
cd wfm-ide
npm run watch

# 终端 3: 启动 IDE
cd wfm-ide
./scripts/code.sh
```

---

## 4. 验证最小闭环

1. IDE 启动后 `Cmd+O` 打开本地文件夹
2. 右侧 AuxiliaryBar → WFM/Uni 聊天面板 → 发送消息 → 应收到回复
3. 后端健康检查：`curl http://127.0.0.1:8765/v1/health`
4. 后端 echo 测试：
   ```bash
   curl -X POST http://127.0.0.1:8765/v1/chat \
     -H 'Content-Type: application/json' \
     -d '{"workspace_root":"/tmp/test-wfm","message":"ping"}'
   ```

---

## 5. 常见问题

| 问题 | 解决 |
|------|------|
| `uv` 找不到 | `export PATH="$HOME/Library/Python/3.9/bin:$PATH"` |
| 首次 npm watch 编译慢 (3-5 分钟) | 正常现象，等 `Finished compilation` 出现 |
| 端口 8765 被占 | `./scripts/dev.sh --kill-port` 或 `./scripts/dev-stop.sh` |
| Electron 下载失败 | `export ELECTRON_MIRROR='https://ghfast.top/https://github.com/electron/electron/releases/download/'` |
| TypeScript 编译报错 | 确认 Node 版本 `node -v` 输出 22.x |

---

## 6. 日志位置

| 日志 | 路径 |
|------|------|
| 后端 | `.wfm-dev/logs/agents.log` |
| IDE watch | `.wfm-dev/logs/ide-watch.log` |
| IDE 运行 | `.wfm-dev/logs/ide.log` |
| AgenticX DevUI | `.wfm-dev/logs/agent-stack-agenticx-devui.log` |
| MAF DevUI | `.wfm-dev/logs/agent-stack-maf-devui.log` |