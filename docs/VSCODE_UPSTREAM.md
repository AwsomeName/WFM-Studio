# wfm-ide 维护手册：如何修改、如何升级

> 面向开发者。说明 `wfm-ide/` 目录（vscode fork）在本 Monorepo 中的管理方式、日常修改规范、以及升级 vscode 上游的完整流程。

---

## 1. 仓库结构

```
WFM/                              ← 单一 Git 仓库
├── .cursor/rules/                  Cursor AI 守则（自动生效）
│   └── wfm-ide-fork-policy.mdc
├── docs/
│   ├── PRD.md                      产品需求
│   ├── PLAN.md                     开发计划
│   ├── DEV_SETUP.md                环境与启动
│   ├── VSCODE_UPSTREAM.md          ← 本文件
│   ├── UPSTREAM_PATCHES.md         我们对 vscode 源码的"侵入式"改动登记
│   ├── CREWAI_UPSTREAM.md          CrewAI：subtree + 本地 path 依赖说明
│   └── CREWAI_PATCHES.md           我们对 CrewAI 上游的侵入式改动登记
├── third_party/
│   └── crewai/                     CrewAI 上游（git subtree），供 wfm-agents path 依赖
├── wfm-ide/                        vscode fork，通过 git subtree 纳入
│   └── src/vs/workbench/contrib/wfm/   ★ 我们自己的定制代码（要新建）
├── wfm-agents/                     Python/FastAPI Agent 后端
└── wfm-resources/                  模板、文案、素材
```

Git remote 配置：

```
origin            本项目主仓库
upstream-vscode   https://github.com/microsoft/vscode.git   ← 升级源
```

基线 commit：`f0f1768a`（vscode main, 对应 package.json version `1.117.0`）。

---

## 2. 核心理念：为什么这样管理

### 2.1 为什么用 `git subtree` 而不是 submodule

| 维度 | subtree | submodule |
|------|---------|-----------|
| 克隆仓库 | 一次就全拿到 | 还要 `submodule init/update` |
| 提交历史 | 统一在主仓库 | 分散在两个仓库 |
| 修改子目录代码 | 和普通目录一样 | 要切到子仓库再提交 |
| 升级上游 | `subtree pull` | `cd sub && git pull` |

对我们场景（一个团队、一份代码、长期 fork），subtree 更合适。

### 2.2 为什么要"定制隔离"

vscode 上游每隔几周发一个版本，大量改动。如果我们的定制和上游改动在**同一个文件的同一片区域**，`subtree pull` 就冲突。

**解法：让我们的改动尽量和上游的改动物理隔离。**

- 新写代码 → 独立目录 `contrib/wfm/**` → 上游永远不会动这里 → 零冲突
- 必须改上游源码 → 集中几个点 + 登记清单 → 可控冲突

---

## 3. 如何修改代码（四种场景）

### 3.1 场景一：新增功能（90% 的情况都是这个）

**一律放在 `wfm-ide/src/vs/workbench/contrib/wfm/<功能名>/`。**

目录结构模仿 vscode 现有 contrib，例如：

```
wfm-ide/src/vs/workbench/contrib/wfm/aiChat/
├── browser/
│   ├── aiChat.contribution.ts   注册入口
│   ├── aiChatViewPane.ts        UI
│   └── aiChatService.ts         逻辑
└── common/
    └── aiChat.ts                接口定义
```

然后在 `wfm-ide/src/vs/workbench/workbench.common.main.ts` 末尾加一行 import：

```typescript
import 'vs/workbench/contrib/wfm/aiChat/browser/aiChat.contribution';
```

**这一行 import 的添加也要登记到 `UPSTREAM_PATCHES.md`**（因为它改了上游文件）。

### 3.2 场景二：裁剪 vscode 功能（例如不要终端、调试、Git）

**不要删目录**，只注释注册入口。

编辑 `wfm-ide/src/vs/workbench/workbench.common.main.ts`：

```typescript
// ❌ 原来
import 'vs/workbench/contrib/terminal/browser/terminal.contribution';
import 'vs/workbench/contrib/debug/browser/debug.contribution';
import 'vs/workbench/contrib/scm/browser/scm.contribution';

// ✅ 修改后
// import 'vs/workbench/contrib/terminal/browser/terminal.contribution';  // WFM: 精简工作台
// import 'vs/workbench/contrib/debug/browser/debug.contribution';         // WFM: 精简工作台
// import 'vs/workbench/contrib/scm/browser/scm.contribution';             // WFM: 精简工作台
```

然后在 `docs/UPSTREAM_PATCHES.md` 登记这次改动。

### 3.3 场景三：换品牌（logo / 产品名 / 欢迎页）

**logo（推荐）——直接替换文件**

```bash
# 保持文件名不变，只替换内容
cp /path/to/wfm-logo.icns    wfm-ide/resources/darwin/code.icns
cp /path/to/wfm-logo.ico     wfm-ide/resources/win32/code.ico
cp /path/to/wfm-logo.png     wfm-ide/resources/linux/code.png
```

二进制文件上游很少改，这样做几乎不会冲突。

**产品名——只改 `product.json` 字段值**

```json
{
  "nameShort": "WFM Studio",
  "nameLong": "WFM Studio - Writing Factory & Media",
  "applicationName": "wfm-studio",
  "dataFolderName": ".wfm-studio",
  "urlProtocol": "wfm-studio"
}
```

**欢迎页——新建模块替换，不要就地改**

不要改 `contrib/welcomeGettingStarted/`。做法：

1. 新建 `contrib/wfm/welcome/` 自己的欢迎页实现。
2. 在 `workbench.common.main.ts` 里**注释掉**官方 welcome 的 import。
3. 新增你自己 welcome 的 import。

### 3.4 场景四：必须修改 vscode 原有功能代码（尽量避免）

**判断：能用"新建 + 替换注册"解决的，就不要就地改。**

如果确实避不开（例如改某个服务的默认行为），遵循：

1. 改动范围**尽可能小**（只改必要的几行）。
2. 用明显注释标注：`// WFM: 原因/效果`。
3. 在 `docs/UPSTREAM_PATCHES.md` 登记文件路径、行号区间、原因。
4. 升级 vscode 时，**优先检查这些点**。

---

## 4. 如何升级 vscode

### 4.1 升级前准备

1. **工作区干净**：`git status` 无未提交改动。
2. **当前分支是 main 或稳定分支**，且已 push。
3. **打开** `docs/UPSTREAM_PATCHES.md`，心里有数：哪些上游文件我们动过。

### 4.2 标准升级流程

```bash
cd /Users/lc/Desktop/WFM

# 1. 开升级分支（别在 main 上直接搞）
git checkout -b chore/upstream-1.101.0

# 2. 抓上游最新
git fetch upstream-vscode

# 3. 查想升级到哪个版本
git ls-remote --tags upstream-vscode | grep '1.101' | head

# 4. 执行 subtree pull（把 <tag> 换成实际版本号）
git subtree pull --prefix=wfm-ide upstream-vscode 1.101.0 --squash
```

### 4.3 处理冲突

冲突位置**几乎一定**是 `UPSTREAM_PATCHES.md` 里登记过的文件：

- `wfm-ide/src/vs/workbench/workbench.common.main.ts`（裁剪的那些 import）
- `wfm-ide/product.json`（品牌字段）
- 登记的其它侵入式改动

解决步骤：

```bash
git status                              # 看哪些文件冲突
# 用编辑器打开冲突文件，按 UPSTREAM_PATCHES.md 的语义合并
# 保留上游新增字段 + 保留你的定制字段值
git add <冲突文件>
git commit                              # 完成 subtree pull 合并
```

### 4.4 升级后验证

```bash
cd wfm-ide

# 依赖可能变了，重装
npm ci

# 首次启动/编译可能要重新拉 electron
export ELECTRON_MIRROR='https://ghfast.top/https://github.com/electron/electron/releases/download/'
npm run electron
npm run compile

# 冒烟测试
./scripts/code.sh
```

确认：

- [ ] 窗口能打开
- [ ] 品牌（logo、标题）还是 WFM Studio
- [ ] 裁剪过的模块（terminal/debug/scm 等）依然看不到
- [ ] 我们自己 `contrib/wfm/` 的面板正常
- [ ] 启动日志没有新的阻断型错误

### 4.5 合并回 main

```bash
git checkout main
git merge chore/upstream-1.101.0
git push
```

---

## 5. 升级对账单：`docs/UPSTREAM_PATCHES.md`

**这份文件是你升级时的救命稻草，必须随改动实时维护。**

模板：

```markdown
# UPSTREAM_PATCHES

记录所有对 `wfm-ide/` 下 vscode 源码的"侵入式"修改。升级 vscode 时优先检查这里的文件。

## wfm-ide/product.json

- 改动：`nameShort` / `nameLong` / `applicationName` / `dataFolderName` / `urlProtocol`
- 目的：WFM Studio 品牌
- 升级检查：对比上游新增字段（如新版本加的遥测、更新源等），保留我们的字段值

## wfm-ide/src/vs/workbench/workbench.common.main.ts

- 注释掉的 import（精简工作台）：
  - `vs/workbench/contrib/terminal/browser/terminal.contribution`
  - `vs/workbench/contrib/debug/browser/debug.contribution`
  - `vs/workbench/contrib/scm/browser/scm.contribution`
  - `vs/workbench/contrib/testing/browser/testing.contribution`
- 新增的 import（WFM 模块）：
  - `vs/workbench/contrib/wfm/aiChat/browser/aiChat.contribution`
  - `vs/workbench/contrib/wfm/taskflow/browser/taskflow.contribution`
- 升级检查：确认注释和新增都还在，上游未删除我们依赖的模块路径

## wfm-ide/resources/{darwin,win32,linux}/

- 替换的二进制文件：
  - `darwin/code.icns`
  - `win32/code.ico`
  - `linux/code.png`
- 升级检查：如果上游重命名这些文件，我们要跟着改名
```

---

## 6. 常见问题

### Q1：subtree pull 说 "Working tree has modifications"

确保 `git status` 干净。未提交的改动要先 commit 或 stash。

### Q2：升级后 node-gyp 编译报错（例如 spdlog `constexpr` 错误）

这是新版 macOS Clang 和老版 vscode 的 C++ 依赖不兼容。通常升级到更新的 vscode 版本就能解决——本项目基线选在 1.117.0 正是因为它兼容当前工具链。

### Q3：subtree pull 下载量很大

首次会比较大（几百 MB）。以后增量会小很多。

### Q4：想放弃这次升级

```bash
git merge --abort       # 如果还在 merge 状态
git checkout main       # 回到安全分支
git branch -D chore/upstream-xxx
```

`main` 不会被污染，因为我们是在升级分支上做的。

### Q5：想看 vscode 某个文件最近被上游改了什么

```bash
git log upstream-vscode/main -- path/in/vscode/file.ts | head
```

---

## 7. 最小规则回顾

1. **新代码进 `contrib/wfm/**`**
2. **能新增就别修改**
3. **必改的，登记到 `UPSTREAM_PATCHES.md`**
4. **图标直接覆盖同名文件**
5. **升级前开新分支，升级后跑冒烟**

做到这五条，长期维护一个 fork 就是一件**可预期、低成本**的事。
