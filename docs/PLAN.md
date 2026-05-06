# Uni-Studio — 开发计划（深度定制路线）

> 版本：v0.7 &nbsp;|&nbsp; 更新日期：2026-05-07（品牌更名为 Uni-Studio；加 PPT 编辑器混合方案、标书生成、后端框架评估、并行分支策略）
>
> 路线决策：
> 1. **直接 Fork Code OSS，深度定制 UI，不走插件路线。**
> 2. **近期优先级调整：最小 AI 闭环 > 品牌换皮 > 工作台精简。**
>    先让 OSS 前端与自建 Agent 后端在"工作区"维度打通，再回头做换皮与裁剪。
> 3. **品牌更名为 Uni-Studio**（v0.7 新增），除大标题外尽量中文化。
> 4. **PPT 编辑器采用混合方案**：整体生成用 python-pptx + AI，精细编辑嵌入 PPTist（v0.7 新增）。
> 5. **新增标书/方案生成工作流**（v0.7 新增 Phase 7）。
> 6. **新增后端框架对比评估**（v0.7 新增 Phase 8），对比已有代码的 CrewAI / Anthropic / MAF / AgenticX 四引擎。
> 7. **并行分支开发策略**（v0.7 新增，详见 `docs/MERGE_STRATEGY.md`）。

---

## 0. 先说结论

```
用户双击 Uni-Studio.app
        │
        ▼
  Electron 启动
        │
        ├── 加载 Uni-Studio UI（我们魔改后的 workbench）
        │   ├── 左侧边栏：文件 · 模板 · 文案库 · 资源市场
        │   ├── 主编辑区：Markdown / 富文本 / PPT / 海报 / 标书
        │   ├── 右侧面板：Task Flow + AI 对话
        │   └── 去掉了：终端、调试器、源码管理等开发者功能
        │
        └── 自动拉起 Python 后台进程
            └── FastAPI + Agent Gateway → localhost:8765
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
│   │   │   │   ├── uni/               # ★★★ 我们的核心代码 ★★★（v0.7: wfm→uni 重命名）
│   │   │   │   │   ├── taskflow/       #   Task Flow 面板
│   │   │   │   │   ├── aiChat/         #   AI 对话面板
│   │   │   │   │   ├── pptEditor/      #   PPT 编辑器（混合方案：PPTist Webview + python-pptx 后端）
│   │   │   │   │   ├── docGen/         #   标书/方案生成（v0.7 新增）
│   │   │   │   │   ├── templateHub/    #   模板 & 文案库浏览器
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
├── wfm-agents/                         # ═══ 后端：FastAPI + Agent Gateway ═══
│   ├── pyproject.toml                  # 默认可从 PyPI 依赖 `crewai`；若使用 subtree 再改为 path
│   ├── config/mcp_servers.yaml         # MCP 定义（可选；见 `wfm_agents/tools/mcp/`）
│   └── wfm_agents/
│       ├── server.py                   # FastAPI 入口（`uvicorn wfm_agents.server:app`）
│       ├── routes/                     # HTTP 路由
│       ├── gateway/                    # AgentGateway + models + session + stream_events
│       ├── tools/                      # ToolGateway + builtin + MCP + pptx_provider + proposal_provider（v0.7 新增）
│       ├── engines/                    # Engine adapters: crewai / anthropic / maf / agenticx
│       └── observability/              # trace + error codes
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

## 4. 改造路线图：从 Code OSS → Uni-Studio

### 4.1 总览

```
Phase 0  编译跑通原版 Code OSS
    │    ✅ 已完成（本机环境已就绪，不再重复验证）
    │
Phase 3-Alpha  ✅ 已完成：AI 最小闭环（工作区维度）
    │    ① 打开一个工作区
    │    ② 后端 Agent 被"钉"在该工作区，越界操作被拒
    │    ③ 前端 AI Chat 面板 ↔ 后端 FastAPI（契约见 docs/ARCH_AGENT_GATEWAY.md）
    │        同步 POST /v1/chat 与流式 POST /v1/chat/stream（SSE）均为第一版交付范围
    │
Phase 1  品牌换皮 → Uni-Studio（feat/uni-studio-brand 分支）
    │    改名 + 换图标 + 改欢迎页 + 中文化 + 裁剪工作台
    │    目标：打开看到 "Uni-Studio"，中文界面
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
Phase 6  PPT 编辑器（混合方案，feat/ppt-editor 分支）
    │    整体模式：AI → python-pptx 生成完整 PPTX
    │    精细模式：PPTist Webview 所见即所得编辑
    │    双向转换：PPTX ↔ PPTist JSON（详见 docs/ARCH_PPT_EDITOR.md）
    │
Phase 7  标书/方案生成（feat/doc-generation 分支）
    │    多步 AI 工作流：需求 → 大纲 → 分章节 → 评审 → 格式化
    │    详细架构见 docs/ARCH_DOC_GENERATION.md
    │
Phase 8  后端框架对比评估（feat/backend-eval 分支）
    │    对比已有代码的 4 引擎：CrewAI / Anthropic / MAF / AgenticX
    │    5 个场景任务 × 评估维度 → 选定主引擎
    │    详见 docs/EVAL_REPORT.md（评估完成后产出）
```

> 调整说明：原 Phase 1/2 做完 UI 不意味着"能干活"，只是"看起来像"。把 Phase 3-Alpha 前置，可以最早拿到"一条可用的 AI 链路"，后续所有功能都挂在这条链路上演进。

### 4.2 Phase 1 — 品牌换皮 → Uni-Studio（feat/uni-studio-brand 分支）

> Phase 1 和 Phase 2（裁剪）合并到 `feat/uni-studio-brand` 分支并行推进。

**① `product.json` — 改产品名称为 Uni-Studio**

```json
{
  "nameShort": "Uni-Studio",
  "nameLong": "Uni-Studio",
  "applicationName": "uni-studio",
  "dataFolderName": ".uni-studio",
  "urlProtocol": "uni-studio",
  "win32MutexName": "unistudio",
  "darwinBundleIdentifier": "com.uni-studio",
  "linuxIconName": "uni-studio"
}
```

**② 模块重命名 `wfm/` → `uni/`**（符合 fork policy：新代码放新目录）

- 目录 `contrib/wfm/` → `contrib/uni/`
- 文件名、接口名、CSS class 全部从 `wfm` → `uni`
- `IWfmAgentClientService` → `IUniAgentClientService`
- localize key 从 `wfm.*` → `uni.*`
- 详细改动清单见 `docs/UPSTREAM_PATCHES.md`

**③ `resources/` — 换图标（同路径同名，符合 fork policy 规则 #4）**

**④ 中文化**
- 现有 `localize()` 已使用中文默认字符串（如 "未连接"、"发送"、"助手"），保持此模式
- 核心工作台 UI 中文化：不修改上游 localize 调用，设默认 locale 为 `zh-cn`
- 除大标题外尽量使用中文

**⑤ 裁剪工作台（原 Phase 2 合入）**
- 注释掉 terminal/debug/scm/testing 的 contribution import
- 关闭内置 AgentHost 子系统
- 登记所有改动入 `docs/UPSTREAM_PATCHES.md`

**验证：** 重新编译后启动，标题栏显示 "Uni-Studio"，中文界面，无终端/调试/源码管理图标

### 4.3 Phase 2 — 已合并到 Phase 1

> Phase 2（精简功能）的工作已合并到 `feat/uni-studio-brand` 分支，与品牌换皮一起推进。详见 §4.2。

原 Phase 2 要隐藏的模块（terminal/debug/scm/testing）和要关闭的 AgentHost 告警，全部在 Phase 1 的裁剪步骤中完成。

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

### 4.7 Phase 6 — PPT 编辑器（混合方案，feat/ppt-editor 分支）

> 详细架构见 `docs/ARCH_PPT_EDITOR.md`

PPT 编辑采用 VS Code **CustomEditor API** + Webview 方案，整体生成与精细编辑走不同路径：

**整体模式（AI 一键生成）**：
- 用户在 chat pane 输入 prompt → 后端调用 `uni.pptx_write` 工具生成完整 PPTX → 前端自动在 CustomEditor 打开
- 后端用 python-pptx 创建 PPTX

**精细模式（所见即所得编辑）**：
- 用户双击 `.pptx` 文件 → CustomEditor 注册激活 → Webview 加载 **PPTist**（Vue 开源 PPT 编辑器）
- PPTist 提供完整交互：幻灯片列表、拖拽排版、文本编辑、动画设置、主题切换
- 保存时 PPTist JSON → 通过 `uni.pptist_to_pptx` 工具转写为 PPTX
- 打开时 PPTX → 通过 `uni.pptx_to_pptist` 工具 → 转换为 PPTist JSON 格式

**双向格式转换层**：python-pptx 作为 PPTist ↔ PPTX 的桥梁。

### 4.8 Phase 7 — 标书/方案生成（feat/doc-generation 分支）

> 详细架构见 `docs/ARCH_DOC_GENERATION.md`

标书生成是多步 AI 工作流：

```
需求输入 → 生成大纲 → 分章节撰写 → 评审 → 格式化输出
```

- 后端提供 `uni.proposal_outline` / `uni.proposal_write_section` / `uni.proposal_review` / `uni.proposal_format` 四个 ToolProvider 工具
- 前端注册 `docGen` ViewPane 在 AuxiliaryBar（AI Chat 下方）
- 引擎选择取决于 Phase 8 eval 结果（硬依赖）

### 4.9 Phase 8 — 后端框架对比评估（feat/backend-eval 分支）

> 详细评估场景与维度见 `docs/EVAL_REPORT.md`（评估完成后产出）

对比已拉取代码的 4 个引擎：

| 引擎 | 当前集成深度 | 代码位置 |
|------|------------|----------|
| CrewAI | 浅——直接用 `crewai_runtime.py`，**不经过 ToolHandle** | `third_party/agents/crewai/` |
| Anthropic | **深——完整 ToolHandle 多轮 tool-use loop** | `third_party/anthropics/anthropic-sdk-python/` |
| MAF | 最浅——DevUI HTTP proxy | `third_party/agents/maf/` |
| AgenticX | 最浅——DevUI HTTP proxy | `third_party/agents/agenticx/` |

5 个评估场景：基础对话 / 文件读取 / PPT 大纲 / 标书完整生成 / 错误恢复

关键评估维度：ToolHandle 集成深度、流式粒度、多步编排能力、可定制性

**产出**：选定主引擎 + 备选引擎，记录于 `docs/EVAL_REPORT.md`

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

Step 2  AI 最小闭环（Phase 3-Alpha）────────── ✅ 已完成
        A  wfm-agents FastAPI 骨架 + workspace 越界校验   ✅ 已完成
        B  wfm-ide 最小 contrib（agentClient + aiChat）   ✅ 已完成
        C  手动双进程拉起                                   ✅ 已完成
        D  端到端验收                                       ✅ 已完成

Step 3  品牌 + 裁剪 → Uni-Studio（feat/uni-studio-brand 分支）── 🔄 即将开始
        ├── B1: 改 product.json → Uni-Studio
        ├── B2: 换图标
        ├── B3: 模块重命名 wfm → uni
        ├── B4: 裁剪工作台（注释 terminal/debug/scm/testing）
        ├── B5: 默认布局调整（AuxiliaryBar 默认可见）
        ├── B6: 中文化（设默认 locale zh-cn）
        ├── B7: Welcome 页面
        └── 验证: 标题栏显示 "Uni-Studio"，中文界面

Step 4  PPT 编辑器（feat/ppt-editor 分支）────── 🔄 即将开始
        ├── P1: 后端 PPTX ToolProvider
        ├── P2: 后端 PPTX HTTP 路由
        ├── P3: 前端 CustomEditor 注册
        ├── P4: PPTist Webview 嵌入 + 双向转换
        ├── P5: PPT 生成 recipe
        └── 验证: 双击 .pptx → PPTist 编辑器打开 + AI 整体生成

Step 5  标书/方案生成（feat/doc-generation 分支）── 🔄 即将开始
        ├── D1: 后端 Proposal ToolProvider
        ├── D2: 后端 Proposal HTTP 路由
        ├── D3: 前端文档生成 UI
        ├── D4: Proposal recipe 引擎集成（硬依赖：需等 Step 6 选出引擎）
        └── 验证: 输入需求 → 多步执行 → 输出文档

Step 6  后端框架评估（feat/backend-eval 分支）── 🔄 即将开始
        ├── E1: Eval harness 基础设施
        ├── E2: CrewAI 深度改造探索
        ├── E3: MAF/AgenticX 深度改造探索
        ├── E4: Anthropic 引擎流式增强
        ├── E5: 运行 eval → 输出 EVAL_REPORT.md → 选定主引擎
        └── 验证: Eval report 已产出 → 主引擎已选定
```

### 8.2 并行分支策略

> 详见 `docs/MERGE_STRATEGY.md`

4 条并行分支从 main 拉出，各在各的窗口 checkout：

| 分支 | 职责 | 合并顺序 |
|------|------|----------|
| `feat/backend-eval` | 框架对比 + Eval harness | 第 1（纯后端测试，最低风险） |
| `feat/doc-generation` | 标书/方案生成 | 第 2（依赖 eval 选出的引擎） |
| `feat/ppt-editor` | PPT 编辑器混合方案 | 第 3（前端 webview + 后端工具） |
| `feat/uni-studio-brand` | 品牌重命名 + 中文化 + 裁剪 | 第 4（面最广，最后覆盖） |

```bash
# 创建分支
git checkout -b feat/backend-eval main
git checkout -b feat/uni-studio-brand main
git checkout -b feat/ppt-editor main
git checkout -b feat/doc-generation main
```

合并顺序：backend-eval → doc-generation → ppt-editor → uni-studio-brand

### 8.3 Agent 网关里程碑（`docs/DEV_AGENT_GATEWAY.md` M0→M6）

与 `docs/ARCH_AGENT_GATEWAY.md` 契约对齐的实现进度（在此勾选，避免与 Step 2 子项混淆）：

- [x] **M0** 契约与骨架（`gateway/models.py`、`tools/spec.py`、`observability/*`、目录骨架、`pytest` 模型用例）
- [x] **M1** `fs_ops` + 内置工具 + ToolRegistry / Executor / ToolHandle（HTTP `workspace_ops` 共用 `fs_ops`）
- [x] **M2** `AgentGateway` + `CrewAIEngine`（同步 `/v1/chat` 走新链路，`trace_id` / `engine` 透传）
- [x] **M3** 流式 SSE `POST /v1/chat/stream`（`ToolExecutor` 可选 `event_sink` + 断连 `cancel_event`）
- [x] **M4** MCP 聚合 + reload（`wfm_agents/config/mcp_servers.yaml`、`mcp.*`、`POST /v1/admin/mcp/reload`；pytest `tests/test_mcp_m4.py`）
- [x] **M5** `agenticx` in-tree 最小 `run_turn`/`stream_turn`；`maf` DevUI 适配
- [ ] **M6** Eval harness（🔄 in-progress，`feat/backend-eval` 分支）

### 8.4 Step 2 —— 最小闭环详细拆解（✅ 已完成，保留供参考）

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

# 或仓库根一键（最小闭环，不启 DevUI）：./scripts/dev-minimal.sh
# 或仓库根：./scripts/dev.sh --no-agent-devuis
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
