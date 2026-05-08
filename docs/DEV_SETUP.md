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
| `./scripts/dev-bundle.sh` | 生产 bundle 模式启动（**中文界面 / 演示前验证**用，详见 §7） |
| `./scripts/dev-bundle.sh --skip-bundle` | 复用上次 bundle 产物直接启动，秒开 |
| `./scripts/dev-bundle.sh --no-ide` | 只 bundle 不启动 |

### 2.4 停止服务

```bash
./scripts/dev-stop.sh
```

### 2.5 品牌与 `product.json`（当前折中）

窗口标题与「关于」中的 **产品名** 使用 **WFM Studio**（见 `wfm-ide/product.json` 的 `nameShort` / `nameLong` 及 Windows 安装展示相关字段）。

为 **避免本机设置与扩展目录断档**，以下字段**有意未改**，仍与上游 Code OSS 对齐：

- `dataFolderName`：`~/.vscode-oss`（用户数据与扩展默认仍在该路径下）
- `applicationName`、`urlProtocol`：仍为 `code-oss`，操作系统 URL 处理与历史链接不受影响
- `darwinBundleIdentifier`：仍为 `com.visualstudio.code.oss`，避免与签名/更新通道假设冲突

后续若要做「目录与协议一并改名」，需在发行说明中写明迁移步骤（复制或导出 `~/.vscode-oss` 等）。

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
2. 右侧 AuxiliaryBar → **WFM Studio** 侧栏（任务对话）→ 发送消息 → 应收到回复
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
| **在 Cursor / VSCode 内置终端里启动 IDE 报 `does not provide an export named 'Menu'`** | Cursor 的 extension host 给子 shell 注入了 `ELECTRON_RUN_AS_NODE=1`，让 Electron 二进制变成纯 Node 跑，`process.type=undefined`，`electron` 内置模块拿不到 `app/Menu`。`scripts/dev.sh` 与 `scripts/dev-bundle.sh` 已自动 `unset` 它；如果手动跑 `wfm-ide/scripts/code.sh`，先执行 `unset ELECTRON_RUN_AS_NODE VSCODE_*`，或换到独立 terminal 启动 |
| **界面是英文（已经改 `argv.json`）** | 见 §7。dev 模式下 `localize('key', 'msg')` 不会被替换成 number index，bootstrap-esm 在 `VSCODE_DEV` 下也短路 NLS 加载，**dev 模式天然不出中文**。要看中文跑 `./scripts/dev-bundle.sh` |

---

## 6. 日志位置

| 日志 | 路径 |
|------|------|
| 后端 | `.wfm-dev/logs/agents.log` |
| IDE watch | `.wfm-dev/logs/ide-watch.log` |
| IDE 运行 | `.wfm-dev/logs/ide.log` |
| AgenticX DevUI | `.wfm-dev/logs/agent-stack-agenticx-devui.log` |
| MAF DevUI | `.wfm-dev/logs/agent-stack-maf-devui.log` |
| Bundle 编译 | `.wfm-dev/logs/ide-bundle.log` |
| Bundle 运行（prod 模式） | `.wfm-dev/logs/ide-prod.log` |

---

## 7. 中文界面（NLS）与 dev-bundle.sh

### 7.1 为什么 dev 模式永远是英文

VS Code 上游设计：界面文字都用 `localize('key', '英文 fallback')` 包裹。

- **dev 模式**：`watch` 增量编译只做 transpile，每个 `.ts` → `.js`，源代码里的 `localize('key', 'msg')` 原样保留。运行时 `localize` 函数看到第一个参数是字符串，**直接返回英文 fallback** —— 永远是英文，跟语言包配置无关。
- **prod 模式**：bundle 阶段 `nls-plugin` 把所有 `localize('key', 'msg')` 改写成 `localize(123, null)`（123 是统一编号），同时把英文原文写到 `out/nls.messages.json`。启动时 `bootstrap-esm.ts` 根据 `argv.json` 的 `locale` + 已安装的语言包扩展，生成中文消息数组并赋给 `globalThis._VSCODE_NLS_MESSAGES`，`localize(123, null)` 查表得到中文。

`bootstrap-esm.ts` 还有第二道阀门：`if (process.env['VSCODE_DEV']) return undefined`，dev 模式下连 NLS 加载流程都不走。

### 7.2 看中文界面的正确做法：`./scripts/dev-bundle.sh`

```bash
./scripts/dev-bundle.sh                # 完整流程（约 60-70 秒 bundle）
./scripts/dev-bundle.sh --skip-bundle  # 复用上次产物，秒开
./scripts/dev-bundle.sh --no-ide       # 只 bundle 不启动
```

脚本干的事：

1. 停 `dev.sh` 的 watch（避免 watch 把 `out/` 又改回 transpile 版）
2. `transpile` 全量到 `out/`（保留 `main.ts` / `cli.ts` 的单文件 ESM 风格，bundle 后这俩会跟 Electron 主进程的 named import 打架，所以单独保留）
3. `bundle` 渲染端 + 扩展宿主 + worker 到 `.build/wfm-bundle/`，nls-plugin 同步生成 `nls.keys.json` / `nls.messages.json`
4. `rsync` 合并 bundle 产物到 `out/`，主进程 `main.js` / `cli.js` 跳过
5. 同步 `~/.vscode-oss-dev/argv.json` → `~/.vscode-oss/argv.json`、`languagepacks.json` 镜像到 prod 数据目录
6. **合成 builtin 扩展目录** `wfm-ide/.build/wfm-builtin-merged/`：软链 `wfm-ide/extensions/*`（vscode 自带 98 个）+ `wfm-ide/.build/builtInExtensions/*`（marketplace 拉来的 4 个，含简中语言包）
7. 不带 `VSCODE_DEV`、带 `--builtin-extensions-dir <merged>` 启动 IDE → vscode 识别语言包 → bootstrap-esm 加载 NLS messages → 中文界面

### 7.3 prod 模式中文为什么这么坎（踩过的坑）

**坑 1：Cursor 注入 `ELECTRON_RUN_AS_NODE=1`** —— 让 Electron 二进制跑成纯 Node，main.ts 第一行 `import { app, Menu } from 'electron'` 就抛 `does not provide an export named 'Menu'`。dev-bundle.sh 启动前 `unset` 一组 Cursor 注入的 `VSCODE_*` 与这个变量。

**坑 2：prod userData 路径 ≠ `code-oss/`** —— `getUserDataPath` 用的是 `product.nameShort`，我们改成了 `"WFM Studio"`，所以是 `~/Library/Application Support/WFM Studio/`，不是 `code-oss/`。早期版本脚本写错路径，导致同步过去的 `languagepacks.json` 根本不在 vscode 实际读的地方。

**坑 3：prod 模式不扫 `.build/builtInExtensions/`** —— `extensionsScannerService.ts` 里 `isBuilt ? [] : product.builtInExtensions` 这一句把 prod 模式直接屏蔽了。dev 模式自动加载 marketplace 下载到 `.build/builtInExtensions/` 的扩展（含语言包）；prod 模式只看 `wfm-ide/extensions/`（98 个 vscode 自带扩展，**不含语言包**）。vscode 启动后扫不到 zh-cn 语言包扩展 → 把 `languagepacks.json` 重写成 `{}` → NLS 解析回退英文。

**坑 4：单独把语言包软链进 `~/.vscode-oss/extensions/` 没用** —— vscode 把那目录看作"用户安装扩展"，发现 `extensions.json` 没注册它就标记 `.obsolete`、跳过加载、清掉 NLS cache。

**最终法**：用 `--builtin-extensions-dir` 给 vscode 一个合并目录（dev 模式那两个源都软链进去）当 builtin 扩展位置。vscode 把它当 builtin 处理 —— 不需要 `extensions.json` 注册、不会标 obsolete、能正常加载语言包。

### 7.4 数据目录差异

| 模式 | argv.json | 用户数据 | builtin 扩展 |
|------|-----------|----------|----------|
| dev (`./scripts/dev.sh`) | `~/.vscode-oss-dev/argv.json` | `~/Library/Application Support/code-oss-dev/` | `wfm-ide/extensions/` + 自动加载 `wfm-ide/.build/builtInExtensions/`（含语言包） |
| prod bundle (`./scripts/dev-bundle.sh`) | `~/.vscode-oss/argv.json` | `~/Library/Application Support/<product.nameShort>/` | `wfm-ide/.build/wfm-builtin-merged/`（脚本合成，软链了上述两个源）|

dev-bundle 启动时自动同步 `argv.json` / `languagepacks.json` 到 prod 目录、清旧 NLS 缓存、重建合并 builtin 目录。

### 7.5 想回到 dev watch 模式

```bash
./scripts/dev.sh
```

watch 重新覆盖 `out/`，nls.* 产物会被覆盖，不影响下次再跑 `dev-bundle.sh` 重新生成。