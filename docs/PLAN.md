# WFM Studio — 开发计划（深度定制路线）

> 版本：v0.6 &nbsp;|&nbsp; 更新日期：2026-04-22（引用 `ARCH_AGENT_GATEWAY.md`、第一版含流式 SSE）
>
> 路线决策：
> 1. **直接 Fork Code OSS，深度定制 UI，不走插件路线。**
> 2. **近期优先级调整：最小 AI 闭环 > 品牌换皮 > 工作台精简。**  
>    先让 OSS 前端与自建 Agent 后端在"工作区"维度打通，再回头做换皮与裁剪。

---

## 0. 先说结论

```
用户双击 WFM Studio.app
        │
        ▼
  Electron 启动
        │
        ├── 加载 WFM Studio UI（我们魔改后的 workbench）
        │   ├── 左侧边栏：文件 · 模板 · 文案库 · 资源市场
        │   ├── 主编辑区：Markdown / 富文本 / PPT / 海报
        │   ├── 右侧面板：Task Flow + AI 对话
        │   └── 去掉了：终端、调试器、源码管理等开发者功能
        │
        └── 自动拉起 Python 后台进程
            └── FastAPI + CrewAI → localhost:8765
```

用户看到的是**一个全新产品**，不是 VS Code 换了个皮。

---

## 1. 项目目录结构

```
WFM/
├── docs/                               # 项目文档
│   ├── PRD.md                          # 产品需求文档
│   ├── PLAN.md                         # 本文件
│   ├── ARCH_AGENT_GATEWAY.md           # Agent 网关 / HTTP 契约 / Tool+MCP / 多引擎（规格）
│   ├── DEV_AGENT_GATEWAY.md            # Agent 网关研发推进手册（AI / 工程师按步执行）
│   ├── DEV_SETUP.md                    # 开发环境与启动基线（统一口径）
│   ├── CREWAI_UPSTREAM.md              # CrewAI：git subtree + 本地 path 依赖
│   └── CREWAI_PATCHES.md               # 对 CrewAI 上游侵入式改动（升级对账）
│
├── wfm-ide/                            # ═══ 前端：Code OSS Fork ═══
│   │
│   ├── product.json                    # ★ 品牌定制入口
│   ├── resources/                      # ★ 图标、启动图等品牌资源
│   │
│   ├── src/vs/
│   │   ├── code/
│   │   │   └── electron-main/          # Electron 主进程
│   │   │       └── main.ts             # ★ 加入 Python 进程管理
│   │   │
│   │   ├── workbench/                  # ═══ 主战场：workbench 层 ═══
│   │   │   ├── contrib/                # 所有功能模块都在这里
│   │   │   │   │
│   │   │   │   ├── wfm/               # ★★★ 我们的核心代码 ★★★
│   │   │   │   │   ├── taskflow/       #   Task Flow 面板
│   │   │   │   │   ├── aiChat/         #   AI 对话面板
│   │   │   │   │   ├── templateHub/    #   模板 & 文案库浏览器
│   │   │   │   │   ├── pptEditor/      #   PPT 编辑器（Webview）
│   │   │   │   │   ├── posterEditor/   #   海报编辑器（Webview）
│   │   │   │   │   ├── diagramEditor/  #   图表编辑器（Webview）
│   │   │   │   │   ├── agentClient/    #   与 Python 后端通信
│   │   │   │   │   └── common/         #   公共组件和工具
│   │   │   │   │
│   │   │   │   ├── terminal/           # 可删除或隐藏
│   │   │   │   ├── debug/              # 可删除或隐藏
│   │   │   │   └── scm/               # 可删除或隐藏
│   │   │   │
│   │   │   └── browser/
│   │   │       └── layout/             # ★ 改默认布局
│   │   │
│   │   └── platform/                   # 平台层（一般不需要大改）
│   │
│   ├── extensions/                     # 内置扩展（保留有用的，去掉多余的）
│   └── build/                          # 构建脚本
│
├── third_party/
│   └── crewai/                         # 可选：CrewAI 上游（git subtree path 依赖）；未纳入时见 `docs/CREWAI_UPSTREAM.md`
│
├── wfm-agents/                         # ═══ 后端：FastAPI + 业务 Agent/Crew ═══
│   ├── pyproject.toml                  # 默认可从 PyPI 依赖 `crewai`；若使用 subtree 再改为 path
│   ├── config/mcp_servers.yaml         # MCP 定义（可选；见 `wfm_agents/tools/mcp/`）
│   └── wfm_agents/
│       ├── server.py                   # FastAPI 入口（`uvicorn wfm_agents.server:app`）
│       ├── routes/                     # HTTP 路由
│       └── …                           # gateway / tools / engines 等
│
├── wfm-resources/                      # ═══ 模板 & 文案库 & 素材 ═══
│   ├── templates/
│   ├── copywriting/
│   └── assets/
│
└── scripts/
    ├── setup.sh                        # 环境一键安装
    ├── dev.sh                          # 开发模式启动
    └── build.sh                        # 打包构建
```

---

## 2. Code OSS 源码结构速览

想改 Code OSS，先要知道它长什么样。以下是和我们最相关的部分：

```
vscode/src/vs/
│
├── code/                               # ── Electron 入口 ──
│   ├── electron-main/main.ts           # 主进程入口 (★ 我们要改)
│   └── electron-sandbox/               # 渲染进程沙箱
│
├── workbench/                          # ── 整个 IDE 界面 ──
│   │                                   # (★ 我们的主战场)
│   │
│   ├── browser/
│   │   ├── layout/                     # 整体布局控制
│   │   │   └── workbenchLayout.ts      # ★ 面板位置、大小、可见性
│   │   ├── parts/
│   │   │   ├── activitybar/            # 最左侧图标栏
│   │   │   ├── sidebar/               # 左侧边栏
│   │   │   ├── panel/                 # 底部面板
│   │   │   ├── auxiliarybar/          # 右侧辅助栏 (★ 放 AI 面板)
│   │   │   ├── editor/               # 主编辑区
│   │   │   ├── titlebar/             # 标题栏 (★ 改品牌)
│   │   │   └── statusbar/            # 状态栏 (★ 改显示内容)
│   │   └── workbench.ts               # workbench 启动入口
│   │
│   ├── contrib/                        # ── 所有功能模块 ──
│   │   │                               # 每个文件夹 = 一个功能
│   │   ├── files/                      # 文件浏览器 (保留，重要)
│   │   ├── search/                     # 搜索 (保留)
│   │   ├── terminal/                   # 终端 (★ 去掉)
│   │   ├── debug/                      # 调试 (★ 去掉)
│   │   ├── scm/                        # Git (★ 去掉)
│   │   ├── extensions/                 # 扩展管理 (保留，但可简化)
│   │   ├── welcome/                    # 欢迎页 (★ 改为 WFM 欢迎页)
│   │   └── ... (几十个其他模块)
│   │
│   └── services/                       # 服务层（编辑器服务、文件服务等）
│
├── editor/                             # ── Monaco 编辑器核心 ──
│   └── ...                             # 一般不需要改
│
└── platform/                           # ── 平台抽象层 ──
    ├── theme/                          # 主题系统
    └── ...                             # 文件系统、窗口管理等
```

### 核心认知

Code OSS 的 `workbench/contrib/` 目录是**模块化的**。每个功能（终端、调试、Git...）都是一个独立模块，通过依赖注入注册到 workbench。

所以我们的策略是：
1. **去掉不要的模块**（terminal、debug、scm...）—— 不删代码，改注册即可
2. **加入自己的模块**（wfm/taskflow、wfm/aiChat...）—— 模仿现有模块的写法
3. **改布局和品牌**（layout、titlebar、product.json）

---

## 3. 环境准备

> 统一口径以 `docs/DEV_SETUP.md` 为准。本节保留快速说明。

### 3.1 系统依赖

```bash
# ─── Step 1: macOS 基础工具 ───
xcode-select --install

# ─── Step 2: Node.js 22.22.1 (以 .nvmrc 为准) ───
# 推荐用 nvm 管理
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.zshrc
nvm install 22.22.1
nvm use 22.22.1
node -v   # 验证: v22.22.1

# ─── Step 3: Python 3.11+ (CrewAI 要求) ───
brew install pyenv
pyenv install 3.11.9
pyenv global 3.11.9
echo 'eval "$(pyenv init -)"' >> ~/.zshrc
source ~/.zshrc
python3 --version   # 验证: 3.11.x

# ─── Step 4: uv (Python 包管理，可选但推荐) ───
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 3.2 下载源码

```bash
cd /Users/lc/Desktop/WFM

# ─── Code OSS 源码 ───
# 约 600MB，shallow clone 加速
# 直连 GitHub:
git clone --depth 1 --branch 1.99.0 \
    https://github.com/microsoft/vscode.git wfm-ide

# 如果直连不通，用 ghfast.top 镜像:
git clone --depth 1 \
    https://ghfast.top/https://github.com/microsoft/vscode.git wfm-ide

# ─── CrewAI：以 git subtree 纳入本仓库（可改上游、与 PyPI 解耦）───
# 详见 docs/CREWAI_UPSTREAM.md。首次添加示例：
#
#   git remote add upstream-crewai https://github.com/crewAIInc/crewAI.git
#   git fetch upstream-crewai
#   git subtree add --prefix=third_party/crewai upstream-crewai <tag> --squash
#
# wfm-agents 侧在 pyproject.toml 用 path 依赖指向 third_party/crewai（包根以仓库实际布局为准），
# 再 uv lock && uv sync。
#
# 临时对照可读上游：可 shallow clone 到任意目录，勿提交进仓库。
# git clone --depth 1 https://ghfast.top/https://github.com/crewAIInc/crewAI.git ../crewai-readonly
```

### 3.3 编译 Code OSS (首次)

```bash
cd /Users/lc/Desktop/WFM/wfm-ide

# 安装依赖 (耗时 10-20 分钟，需要网络)
npm ci

# 若网络环境不稳定，先设置 Electron 镜像
export ELECTRON_MIRROR='https://ghfast.top/https://github.com/electron/electron/releases/download/'
npm run electron

# 编译 (首次 10-30 分钟)
npm run compile

# 启动! 看到 Code OSS 窗口就说明成功了
./scripts/code.sh
```

> **⚠ 首次编译常见问题及解决：**
>
> | 问题 | 解决 |
> |------|------|
> | `node-gyp` 编译报错 | 确认 `xcode-select --install` 已执行 |
> | Node 版本不对 | `nvm use 22.22.1`（与 `wfm-ide/.nvmrc` 一致） |
> | 内存不足 OOM | 关掉其他应用，或加 `NODE_OPTIONS=--max_old_space_size=8192` |
> | 网络超时下载失败 | 设置 npm 镜像/代理，并先执行 `npm run electron` |
> | Python 找不到 | node-gyp 需要 Python，确认 `python3` 可用 |
> | Electron 下载失败 | `export ELECTRON_MIRROR='https://ghfast.top/https://github.com/electron/electron/releases/download/'` |

### 3.4 验证：编译成功后你会看到

```
┌─────────────────────────────────────────────────────┐
│  Code - OSS Development                     [─ □ ✕] │
│  ─── 这就是原版 Code OSS，接下来我们改造它 ───       │
│                                                     │
│  看到这个窗口 = 编译环境没问题 ✅                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 4. 改造路线图：从 Code OSS → WFM Studio

### 4.1 总览

```
Phase 0  编译跑通原版 Code OSS
    │    ✅ 已完成（本机环境已就绪，不再重复验证）
    │
Phase 3-Alpha  ★ 当前阶段：AI 最小闭环（工作区维度）
    │    ① 打开一个工作区
    │    ② 后端 Agent 被"钉"在该工作区，越界操作被拒
    │    ③ 前端 AI Chat 面板 ↔ 后端 FastAPI（契约见 docs/ARCH_AGENT_GATEWAY.md）
    │        同步 POST /v1/chat 与流式 POST /v1/chat/stream（SSE）均为第一版交付范围
    │    目标：在 OSS 窗口内发一条消息，后端带工作区上下文返回回复（流式优先）
    │
Phase 1  品牌换皮（后置）
    │    改名 + 换图标 + 改欢迎页
    │    目标：打开看到 "WFM Studio"
    │
Phase 2  精简功能（后置，顺手解决 agentHost 告警）
    │    隐藏终端、调试、Git 等开发者模块
    │    顺带关闭 VS Code 1.99 内置 AgentHost 子系统（见 §10）
    │    目标：干净的文案工作台 + 启动日志无红色实例化失败
    │
Phase 4  Task Flow 面板
    │    右侧辅助栏 → Task Flow + AI Chat
    │    + WebSocket 实时状态推送
    │    目标：可视化任务流
    │
Phase 5  模板 & 文案库
    │    左侧边栏新增：模板浏览器、文案库、资源市场
    │    目标：可选模板开始写作
    │
Phase 6  PPT / 海报 / 图表编辑器
         主编辑区 Webview 承载
         目标：在 IDE 内编辑 PPT
```

> 调整说明：原 Phase 1/2 做完 UI 不意味着"能干活"，只是"看起来像"。把 Phase 3-Alpha 前置，可以最早拿到"一条可用的 AI 链路"，后续所有功能都挂在这条链路上演进。

### 4.2 Phase 1 — 品牌换皮 (半天)

只改几个文件，就能让 Code OSS 变成 WFM Studio：

**① `product.json` — 改产品名称**

```json
{
  "nameShort": "WFM Studio",
  "nameLong": "WFM Studio - Writing Factory & Media",
  "applicationName": "wfm-studio",
  "dataFolderName": ".wfm-studio",
  "urlProtocol": "wfm-studio",
  "win32MutexName": "wfmstudio",
  "licenseName": "MIT",
  "welcomePage": "wfm://welcome"
}
```

**② `resources/` — 换图标**

```
resources/
├── darwin/
│   └── wfm-studio.icns         # macOS 图标
├── win32/
│   └── wfm-studio.ico          # Windows 图标
└── linux/
    └── wfm-studio.png          # Linux 图标
```

**③ 标题栏文字** — 文件：`src/vs/workbench/browser/parts/titlebar/`

**验证：** 重新编译后启动，标题栏显示 "WFM Studio"

### 4.3 Phase 2 — 精简功能 (1-2 天)

Code OSS 的模块注册在 `workbench.common.main.ts` 和各模块的 `*.contribution.ts` 中。

**要隐藏的模块：**

| 模块 | 路径 | 操作 |
|------|------|------|
| 终端 (Terminal) | `contrib/terminal/` | 注释掉 contribution 注册 |
| 调试 (Debug) | `contrib/debug/` | 注释掉 contribution 注册 |
| 源码管理 (Git) | `contrib/scm/` | 注释掉 contribution 注册 |
| 测试 (Testing) | `contrib/testing/` | 注释掉 contribution 注册 |
| 远程开发 | `contrib/remote/` | 注释掉 contribution 注册 |
| 扩展市场 | `contrib/extensions/` | 简化或隐藏 |

**要保留的模块：**

| 模块 | 原因 |
|------|------|
| 文件浏览器 (Files) | 核心功能 |
| 搜索 (Search) | 文案搜索 |
| 编辑器 (Editor) | 核心功能 |
| 主题 (Themes) | 换肤 |
| 文件类型关联 | 识别 .md / .ppt.html 等 |

**怎么隐藏：**

找到 `src/vs/workbench/workbench.common.main.ts`，这个文件 import 了所有 contribution：

```typescript
// 注释掉不需要的模块
// import 'vs/workbench/contrib/terminal/browser/terminal.contribution';
// import 'vs/workbench/contrib/debug/browser/debug.contribution';
// import 'vs/workbench/contrib/scm/browser/scm.contribution';
// import 'vs/workbench/contrib/testing/browser/testing.contribution';
```

**验证：** 启动后左侧图标栏只剩文件浏览器和搜索

### 4.4 Phase 3 — AI 对话面板 (1-2 周)

**前端：在 workbench 中注册 AI Chat 面板**

在 `src/vs/workbench/contrib/wfm/aiChat/` 中创建：

```
aiChat/
├── browser/
│   ├── aiChat.contribution.ts      # 注册模块
│   ├── aiChatViewPane.ts           # 面板容器
│   ├── aiChatWebview.ts            # Webview 加载 React 应用
│   └── aiChatService.ts            # 与 Python 后端通信
└── common/
    └── aiChat.ts                   # 接口定义
```

关键代码模式——每个 workbench 模块都遵循这个套路：

```typescript
// aiChat.contribution.ts
import { registerWorkbenchContribution2 } from 'vs/workbench/common/contributions';
import { registerAction2 } from 'vs/platform/actions/common/actions';

// 1. 注册侧边栏视图
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
    id: 'wfm.aiChat',
    name: 'AI 助手',
    containerLocation: ViewContainerLocation.AuxiliaryBar,  // 右侧栏
    // ...
}]);

// 2. 注册命令
registerAction2(class extends Action2 {
    constructor() {
        super({ id: 'wfm.aiChat.open', title: '打开 AI 助手' });
    }
    run() { /* 打开面板 */ }
});
```

**后端：同步搭建 wfm-agents**

HTTP 与 Agent 网关的单一规格见 **`docs/ARCH_AGENT_GATEWAY.md`**（含 `/v1/chat` 与 **`/v1/chat/stream`**、Tool Gateway、MCP 聚合、多引擎适配）；**实现推进步骤** 见 **`docs/DEV_AGENT_GATEWAY.md`**（M0→M6 里程碑与验收清单，AI 可直接按步执行）。

```bash
cd /Users/lc/Desktop/WFM
# 先按 docs/CREWAI_UPSTREAM.md 完成 third_party/crewai subtree 与 path 依赖

cd wfm-agents
uv sync
# 写 wfm_agents/server.py 等，启动（端口以本仓库约定为准，默认 8765）
uv run uvicorn wfm_agents.server:app --reload --port 8765
```

**验证：** WFM Studio 右侧面板能和 AI 对话；**流式 SSE** 与同步接口行为与 `ARCH_AGENT_GATEWAY.md` 一致；CrewAI 集成后由本地 `third_party/crewai` 提供框架实现。

### 4.5 Phase 4 — Task Flow 面板 (1 周)

同样在 `contrib/wfm/taskflow/` 中创建模块。

Task Flow 和 AI Chat 共享右侧辅助栏（AuxiliaryBar），上下分栏：

```
右侧辅助栏 (AuxiliaryBar)
┌──────────────────┐
│  📋 Task Flow     │  ← ViewPane 1
│  T1 ✅ T2 🔄 T3 ⏳│
├──────────────────┤
│  💬 AI 对话       │  ← ViewPane 2
│  ...             │
└──────────────────┘
```

后端通过 WebSocket 实时推送 Task 状态变更。

### 4.6 Phase 5 — 模板 & 文案库 (1-2 周)

在左侧边栏的 Activity Bar 中新增入口：

```
Activity Bar (最左侧图标栏)
┌────┐
│ 📁 │  文件浏览器 (原有)
│ 🔍 │  搜索 (原有)
│ 📋 │  模板库 (★ 新增)
│ 📝 │  文案库 (★ 新增)
│ 🛒 │  资源市场 (★ 新增)
└────┘
```

每个入口对应一个 ViewContainer + 多个 TreeView / Webview。

### 4.7 Phase 6 — PPT / 海报 / 图表编辑器 (2-4 周)

为新文件类型注册自定义编辑器（Custom Editor API）：

```typescript
// 当用户打开 .ppt.html 文件时，用 PPT 编辑器打开
registerEditorSerializer('wfm.pptEditor', {
    canSerialize: (editor) => editor.resource.path.endsWith('.ppt.html'),
    // 在 Webview 中加载 PPTist
});
```

每种编辑器都是一个 Webview，内嵌对应的开源方案：
- PPT → PPTist
- 海报 → Fabric.js 编辑器
- 图表 → Draw.io / Excalidraw

---

## 5. 两条线并行开发

Code OSS 改造（TypeScript）和 CrewAI 后端（Python）可以**并行推进**，互不阻塞：

```
时间线
──────────────────────────────────────────────────►

Code OSS 改造线 (TypeScript):
  [Phase 1: 品牌] → [Phase 2: 精简] → [Phase 3: AI面板前端] → [Phase 4-6...]
                                              │
                                              │ HTTP / WebSocket
                                              │ localhost:8765
                                              │
CrewAI 后端线 (Python):                        │
  [搭 FastAPI 框架] → [写 Agent] → [写 Crew] ──┘──→ [Task Flow 推送] → ...
```

### 日常开发工作流

```bash
# ═══ 终端 1: Python 后端（热重载）═══
cd /Users/lc/Desktop/WFM/wfm-agents
uv run uvicorn wfm_agents.server:app --reload --port 8765

# ═══ 终端 2: Code OSS 监听编译 ═══
cd /Users/lc/Desktop/WFM/wfm-ide
npm run watch

# ═══ 终端 3: 启动 WFM Studio ═══
cd /Users/lc/Desktop/WFM/wfm-ide
./scripts/code.sh

# 改了 TypeScript 代码后，npm run watch 自动增量编译
# 在 WFM Studio 窗口按 Cmd+Shift+P → Reload Window 即可看到变更
# 改了 Python 代码后，uvicorn --reload 自动重启
```

---

## 6. Code OSS 关键文件速查表

改造过程中最常碰的文件：

| 要改什么 | 文件位置 | 说明 |
|---------|---------|------|
| 产品名称/品牌 | `product.json` | 改名、改协议、改数据目录 |
| 应用图标 | `resources/darwin/` `win32/` `linux/` | 替换 .icns / .ico / .png |
| 标题栏 | `src/vs/workbench/browser/parts/titlebar/` | 改标题文字和样式 |
| 状态栏 | `src/vs/workbench/browser/parts/statusbar/` | 改底部显示项 |
| 侧边栏图标栏 | `src/vs/workbench/browser/parts/activitybar/` | 增减图标入口 |
| 欢迎页 | `src/vs/workbench/contrib/welcome/` | 改为 WFM 欢迎页 |
| 整体布局 | `src/vs/workbench/browser/layout/` | 面板位置、默认大小 |
| 模块注册总入口 | `src/vs/workbench/workbench.common.main.ts` | 控制加载哪些模块 |
| 右侧辅助栏 | `src/vs/workbench/browser/parts/auxiliarybar/` | AI 面板的容器 |
| 自定义编辑器 | `src/vs/workbench/contrib/customEditor/` | PPT 等编辑器注册 |
| Electron 主进程 | `src/vs/code/electron-main/main.ts` | 加入 Python 进程管理 |
| 主题/配色 | `src/vs/platform/theme/` | 默认主题定制 |

---

## 7. 依赖版本要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| **Node.js** | 22.22.1 | 以 `wfm-ide/.nvmrc` 为准 |
| **npm** | 10.x+ | 当前项目实际开发与脚本执行基线 |
| **Python** | 3.11+ | CrewAI 要求 |
| **Xcode CLI Tools** | 最新 | macOS 编译原生模块需要 |
| **Git** | 最新 | Code OSS 构建脚本依赖 |
| **CrewAI** | 锁定上游 tag + subtree | 源码在 `third_party/crewai`，`wfm-agents` 用 path 依赖；详见 `docs/CREWAI_UPSTREAM.md` |
| **FastAPI** | 最新 (pip) | HTTP API 框架 |
| **uvicorn** | 最新 (pip) | ASGI 服务器 |

---

## 8. 行动清单（按当前进度更新）

### 8.1 总览

```
Step 1  基线固化 ───────────────────────────── ✅ 已完成
        本机 wfm-ide 可经 ./scripts/code.sh 启动，环境就绪

Step 2  ★ AI 最小闭环（Phase 3-Alpha，进行中）
        A  wfm-agents FastAPI 骨架 + workspace 越界校验   ✅ 已完成
        B  wfm-ide 最小 contrib（agentClient + aiChat）   ✅ 已完成
        C  手动双进程拉起                                   ✅ 命令见 §8.3 Step C（与仓库一致）
        D  端到端验收                                       ✅ 见 §8.3 Step D；自动化基线 `cd wfm-agents && uv run pytest`

Step 3  品牌换皮 (Phase 1) ──────────────────── 2-4 小时
        ├── 改 product.json（名称/协议/数据目录）
        ├── 换图标和欢迎页文案
        └── 验证: 标题栏和启动页显示 WFM Studio

Step 4  精简工作台 (Phase 2) ───────────────── 1-2 天
        ├── 隐藏 terminal/debug/scm/testing 等入口
        ├── 顺手关闭内置 AgentHost（terminal.contribution.ts:69）
        ├── 保留 files/search/editor 主流程
        └── 验证: 工作台聚焦文案生产场景 + 启动日志无红错

Step 5  Task Flow 最小版 (Phase 4-Alpha) ───── 3-5 天
        ├── 3-5 个固定任务节点 + 状态流转
        ├── WebSocket 状态推送
        └── 验证: 可视化执行流程 + 基本控制操作
```

### 8.2 Agent 网关里程碑（`docs/DEV_AGENT_GATEWAY.md` M0→M6）

与 `docs/ARCH_AGENT_GATEWAY.md` 契约对齐的实现进度（在此勾选，避免与 Step 2 子项混淆）：

- [x] **M0** 契约与骨架（`gateway/models.py`、`tools/spec.py`、`observability/*`、目录骨架、`pytest` 模型用例）
- [x] **M1** `fs_ops` + 内置工具 + ToolRegistry / Executor / ToolHandle（HTTP `workspace_ops` 共用 `fs_ops`）
- [x] **M2** `AgentGateway` + `CrewAIEngine`（同步 `/v1/chat` 走新链路，`trace_id` / `engine` 透传）
- [x] **M3** 流式 SSE `POST /v1/chat/stream`（`ToolExecutor` 可选 `event_sink` + 断连 `cancel_event`）
- [x] **M4** MCP 聚合 + reload（`wfm_agents/config/mcp_servers.yaml`、`mcp.*`、`POST /v1/admin/mcp/reload`；pytest `tests/test_mcp_m4.py`）
- [x] **M5** `agenticx` in-tree 最小 `run_turn`/`stream_turn`（`[agenticx]` extra 空占位）；`maf` 仍为 `ENGINE_NOT_INSTALLED`
- [ ] **M6** Eval harness

### 8.3 Step 2 —— 最小闭环详细拆解

目标：**打开某个文件夹 → 在右侧 AI 面板发消息 → 后端带工作区上下文返回回复，且后端无法越界写磁盘。**

#### Step A — 后端骨架 `wfm-agents/`

实际包布局为 **平铺 `wfm_agents/`**（非 `src/`），与 `uv sync` / `uvicorn` 一致：

```
wfm-agents/
├── pyproject.toml
├── README.md
└── wfm_agents/
    ├── server.py               # FastAPI app 工厂 + `app` 实例
    ├── workspace.py            # 工作区绑定 + 路径越界校验
    ├── routes/
    │   ├── health.py           # GET  /v1/health
    │   ├── chat.py             # POST /v1/chat
    │   └── …
    └── …
```

核心约束：

- 所有涉及文件 I/O 的接口必须带 `workspace_root` 参数
- 服务端统一用 `Path.resolve().is_relative_to(workspace_root)` 做越界校验
- 默认 `echo` 不调用 LLM；CrewAI 经 PyPI 或未来 `third_party/crewai` path 接入（见 `docs/CREWAI_UPSTREAM.md`）
- 默认端口 `8765`（避开 VS Code 常用端口）

**验收**：

```bash
# 启动（模块路径须为 wfm_agents.server:app，勿写 src.server）
cd wfm-agents && uv sync --extra dev && uv run uvicorn wfm_agents.server:app --reload --port 8765

# 健康检查
curl http://127.0.0.1:8765/v1/health

# echo chat（带工作区，响应 content / workspace_root 含路径）
curl -X POST http://127.0.0.1:8765/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"workspace_root":"/tmp/demo","message":"hi"}'

# 越界写入被拒
curl -X POST http://127.0.0.1:8765/v1/workspace/write \
  -H 'Content-Type: application/json' \
  -d '{"workspace_root":"/tmp/demo","path":"../../etc/passwd","content":"x"}'
# 预期: 400
```

#### Step B — 前端最小 contrib（已完成）

实际落地结构（相较初稿做了扁平化，单一 `wfm/` 容器 + `common/` + `browser/`）：

```
wfm-ide/src/vs/workbench/contrib/wfm/
├── common/
│   └── wfmAgentClient.ts          # DI 接口 + IWfmAgentClientService
└── browser/
    ├── wfmAgentClientService.ts   # HTTP 实现（IRequestService，绕过 renderer CSP）
    ├── wfmChatViewPane.ts         # ViewPane：原生 DOM 输入框 + 消息列表
    ├── wfm.contribution.ts        # 注册 singleton + ViewContainer + View
    └── media/wfmChat.css
```

关键实现细节：

- **HTTP 走 `IRequestService`**（不用 `fetch`）—— 走 Electron `net` 模块，不被 renderer CSP 拦截，同时自动享受代理配置
- **工作区注入**：`WfmAgentClientService` 注入 `IWorkspaceContextService`，从 `getWorkspace().folders[0].uri.fsPath` 取根目录，调用方不需要手动传
- **仅支持 `file://` scheme**：远程工作区（vscode-vfs 等）先返回 undefined 让 UI 提示"请先打开文件夹"，后续阶段再支持
- **无 Webview、无 Monaco**：`ViewPane.renderBody` 里直接 `dom.append` 出 `<textarea>` + `<div class="wfm-chat-messages">`，用 VS Code 的 CSS 变量做主题自适应
- **注册入口**：`workbench.common.main.ts` 在 Chat contribution 块后新增一行 `import './contrib/wfm/browser/wfm.contribution.js';`

类型 & 分层验证：

- `npm run compile-check-ts-native` ✅
- `npm run valid-layers-check` ✅

#### Step C — 进程拉起（手动）

```bash
# 终端 1: 后端（入口模块名 wfm_agents 带下划线）
cd /Users/lc/Desktop/WFM/wfm-agents
uv run uvicorn wfm_agents.server:app --reload --host 127.0.0.1 --port 8765

# 或仓库根：./scripts/dev.sh --no-ide
```

另：仓库根 `scripts/dev.sh` 会同步运行 `wfm-ide` 的 `npm run watch` 与 OSS `./scripts/code.sh`（与上两条等价，供一键开发）。

> Electron 主进程托管 Python 子进程（`spawn` + 窗口关闭 kill）放到 Step 2 之后再做，避免早期调试噪音。

#### Step D — 端到端验收清单

> **自动化子集**（不启动 IDE，验证后端）：`cd wfm-agents && uv run pytest`（含 chat echo 含工作区路径、区内写读、越界 400、MCP 桩等）。  
> **本机**（IDE + 人眼）：`Cmd+O` 开文件夹后，右侧面板发送消息，助手条目标注「工作区: …」；`POST /v1/workspace/write` 在区内成功、越界 `../` 400。

- [x] `Cmd+O` 打开任意文件夹（手工）
- [x] 右侧 WFM 面板可见；连接状态显示 `http://127.0.0.1:8765`（手工 / `wfm.contribution`）
- [x] 发消息有回复，且助手气泡下方有「工作区: 绝对路径」（亦含于 JSON `workspace_root` 与 echo `content`）（手工 + pytest）
- [x] 工作区内写文件 `tests/test_api.py` / 手工 `POST /v1/workspace/write`
- [x] 越界路径 400 `tests/test_api.py` `test_workspace_write_rejects_escape`
- [x] 关闭 OSS 窗口不杀 uvicorn（`dev.sh` 为独立子进程，手工关 IDE 验证）

---

## 9. 当前已知问题

### 9.1 启动日志里的 `agentHostTerminal` 相关告警

**定位**：这是 VS Code 1.99 官方**内置的 AgentHost 子系统**（为 Copilot Chat 的 Agent Sessions 设计），**与本项目要做的 WFM Agent 无关**，只是撞名。

涉及模块：

| 模块 | 文件 |
|------|------|
| Agent Host 独立进程 | `src/vs/platform/agentHost/node/agentHostMain.ts` |
| Workbench 侧终端 profile 注册 | `src/vs/workbench/contrib/terminal/browser/agentHostTerminalContribution.ts` |
| 注册入口 | `src/vs/workbench/contrib/terminal/browser/terminal.contribution.ts:69` |

**告警成因**：Code OSS 开源版不带 Copilot 授权，`VSCODE_AGENT_HOST_PORT` 等也未配置，运行时连不上/拿不到 provider → 抛 warning。但注册在 `WorkbenchPhase.AfterRestored`，**不阻断主 workbench**。

**处理策略**：

- **当前（Step 2 最小闭环阶段）**：**忽略**。自建 Agent 后端与这套内置机制不复用，打通自建链路不会让这些告警消失。
- **Phase 2 精简工作台时**：注释 `terminal.contribution.ts:69` 的 `registerWorkbenchContribution2(AgentHostTerminalContribution.ID, ...)` 及对应 import，顺带检查 `agentHostMain` 的启动触发点，一并关闭。

### 9.2 "主链路无模块实例化失败"的定义

当前里程碑的验收口径：workbench 所有 `registerWorkbenchContribution2(...)` 注册的模块在构造时不抛异常，日志中**不出现红色的 `Failed to instantiate xxxContribution`**。warning 可以留但要分级记录。

---

## 10. 风险与应对

| 风险 | 应对 |
|------|------|
| **GitHub 访问不稳定** | 用 ghfast.top 镜像 clone |
| **Code OSS 首次编译失败** | 严格对齐 `wfm-ide/.nvmrc` 的 Node 版本 + npm 流程；逐个解决报错 |
| **Electron 下载失败** | `export ELECTRON_MIRROR='https://ghfast.top/https://github.com/electron/electron/releases/download/'` |
| **Code OSS 源码太大不知道改哪里** | 参考第 6 节速查表；善用全局搜索 |
| **workbench 模块写法不熟** | 模仿 `contrib/` 下现有模块的代码结构 |
| **Python 和 Electron 进程通信** | 先用 HTTP 轮询，再升级 WebSocket |
| **macOS ARM 兼容性** | M 系列芯片基本没问题，个别 native module 注意 |
