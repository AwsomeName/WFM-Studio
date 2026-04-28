# CrewAI 上游与本地定制（git subtree）

> 面向开发者。说明在本 Monorepo 中如何通过 **git subtree** 引入 [CrewAI](https://github.com/crewAIInc/crewAI) 源码、用 **本地路径依赖** 替代 PyPI 安装，以及升级上游与记录侵入式改动的流程。

---

## 0. 命令操作指南（按顺序执行）

**是的：应先选定上游版本（tag 或 commit），再 `subtree add`。** 下面假定仓库根目录为 `WFM/`，前缀为 `third_party/crewai`。

### 0.1 前置条件

- 当前分支工作区干净（或已提交本地改动），避免 subtree 合并时难以回滚。
- 已安装 Git；本机可访问 GitHub（或已配置镜像）。

### 0.2 登记 remote（只需做一次）

```bash
cd /path/to/WFM

# 若尚未添加：
git remote add upstream-crewai https://github.com/crewAIInc/crewAI.git

# 若已存在会报错，可改为查看：
git remote -v | grep upstream-crewai

# 网络不稳定时可用镜像（任选其一 URL）：
# git remote add upstream-crewai https://ghfast.top/https://github.com/crewAIInc/crewAI.git
```

### 0.3 查看上游版本（选 tag）

```bash
git fetch upstream-crewai --tags

# 列出标签（末尾几屏通常是最新版）
git ls-remote --tags upstream-crewai | tail -n 30
```

上游 Release 的 **tag 名多为纯版本号**（例如 `1.14.2`），**不一定**带 `v` 前缀；以 `git ls-remote` 输出为准。

选定后设变量（示例，请改成你锁定的版本）：

```bash
export CREWAI_TAG=1.14.2
```

### 0.4 首次纳入：subtree add

```bash
cd /path/to/WFM

git subtree add --prefix=third_party/crewai upstream-crewai "$CREWAI_TAG" --squash
```

说明：

- `--prefix=third_party/crewai`：上游整棵仓库会出现在该目录下。
- `--squash`：主仓库里只有一条合并提交，历史更短；升级仍用 `subtree pull`。

完成后应存在例如 `third_party/crewai/lib/crewai/pyproject.toml`（当前上游为 **monorepo**，核心包在 **`lib/crewai`**，不是仓库根）。

### 0.5 连接 wfm-agents：path 依赖

在 `wfm-agents/pyproject.toml` 的 `[project]` 里加入对 `crewai` 的依赖（若已有 PyPI 版本约束，改为与下面二选一一致），并增加 **指向子包目录** 的 path 源：

```toml
[project]
dependencies = [
    "crewai",
    # ... 其余不变
]

[tool.uv.sources]
crewai = { path = "../third_party/crewai/lib/crewai", editable = true }
```

若未来上游改掉 `lib/crewai` 布局，以 subtree 内**实际含 `name = "crewai"` 的包目录**为准，并同步改 `path`。

### 0.6 锁定并校验

```bash
cd /path/to/WFM/wfm-agents
uv lock
uv sync
uv run python -c "import crewai; print(crewai.__version__, crewai.__file__)"
```

`__file__` 应落在 `.../third_party/crewai/lib/crewai/...`。

### 0.7 提交

```bash
cd /path/to/WFM
git add third_party/crewai wfm-agents/pyproject.toml wfm-agents/uv.lock
git status
git commit -m "chore(third_party): add crewai subtree ${CREWAI_TAG} + path dep in wfm-agents"
```

### 0.8 日后升级上游

```bash
cd /path/to/WFM
git fetch upstream-crewai --tags
export CREWAI_TAG_NEW=1.15.0   # 示例
git subtree pull --prefix=third_party/crewai upstream-crewai "$CREWAI_TAG_NEW" --squash
```

若有改 `third_party/crewai` 内文件，按 `docs/CREWAI_PATCHES.md` 对照解决冲突，再 `uv lock && uv sync` 与跑测试。

---

## 1. 为什么不用「纯 pip 安装」

- **pip / `uv add crewai`** 适合快速验证与 CI 缓存，安装的是**发布包**，改框架内部行为需要 monkey patch 或 fork 后单独维护。
- 产品规划里需要 **长期修改、定制 Agent / Crew / 工具链**，与 `wfm-ide` 用 subtree 管理 vscode 的思路一致：把上游源码**纳入同一 Git 历史**，在子目录内直接改，再通过 **path 依赖** 让 `wfm-agents` 引用本地树。

---

## 2. 仓库中的位置

推荐目录（与前端 `wfm-ide/` 并列，避免和 `wfm-agents` 业务包混在一起）：

```
WFM/
├── docs/
│   ├── CREWAI_UPSTREAM.md    ← 本文件
│   └── CREWAI_PATCHES.md     ← 侵入式改动登记（升级对账）
├── third_party/
│   └── crewai/                 ← git subtree：上游 CrewAI 源码树
└── wfm-agents/
    ├── pyproject.toml          ← crewai 改为 path 指向 ../third_party/crewai/…
    └── wfm_agents/
```

> **包根路径**：当前上游（如 `1.14.x`）为 **uv workspace**，可编辑安装的 **`crewai` 包目录为 `lib/crewai`**（仓库根 `pyproject.toml` 的 `name` 为 workspace，勿把根当成 `crewai` 包）。若未来布局变更，以 subtree 内实际包目录为准。

---

## 3. Git remote 约定

在仓库根目录执行一次（remote 名与 `VSCODE_UPSTREAM.md` 里的 `upstream-vscode` 对称）：

```bash
cd /Users/lc/Desktop/WFM
git remote add upstream-crewai https://github.com/crewAIInc/crewAI.git
# 网络不稳定时可用镜像，例如：
# git remote add upstream-crewai https://ghfast.top/https://github.com/crewAIInc/crewAI.git
```

查看可用标签：

```bash
git ls-remote --tags upstream-crewai
```

---

## 4. 首次纳入：subtree add

在选定上游标签（示例：`v0.x.x`，请替换为团队锁定的版本）后：

```bash
cd /Users/lc/Desktop/WFM
git fetch upstream-crewai
git subtree add --prefix=third_party/crewai upstream-crewai <tag-or-commit> --squash
```

提交信息建议：`chore(third_party): add crewai subtree <version>`。

---

## 5. wfm-agents：本地安装（path / editable）

在 `wfm-agents/pyproject.toml` 中**不要**再从 PyPI 解析 `crewai`（或删除纯版本约束），改为指向 subtree 目录，例如使用 uv 的路径源（具体字段以当前 uv 文档为准）：

```toml
[project]
dependencies = [
    # "crewai>=...",  # 移除 PyPI 版本钉，改为 path
    # ...
]

[tool.uv.sources]
crewai = { path = "../third_party/crewai/lib/crewai", editable = true }
```

若你锁定的上游版本将包放在别的子路径，把 `path` 改成该目录（见 §0.4 说明）。

然后：

```bash
cd /Users/lc/Desktop/WFM/wfm-agents
uv lock
uv sync
uv run python -c "import crewai; print(crewai.__file__)"
```

确认 `__file__` 落在 `third_party/crewai/...` 下即表示走本地树。

---

## 6. 升级上游：subtree pull

```bash
cd /Users/lc/Desktop/WFM
git fetch upstream-crewai
git subtree pull --prefix=third_party/crewai upstream-crewai <new-tag-or-branch> --squash
```

冲突通常只出现在：

- `docs/CREWAI_PATCHES.md` 中登记的、你们**主动改过**的上游文件；
- 或你们改了 `third_party/crewai` 内与上游同路径的文件。

解决冲突后跑 `wfm-agents` 测试与最小端到端验收，再合并。

---

## 7. 定制规范与登记

1. **优先**在 `wfm-agents/wfm_agents/` 写业务 Agent、Crew、Tools，避免改 `third_party/crewai`。
2. **必须修改框架内部**时：改动处应能在代码 review 中一眼看出（必要时加简短注释 `WFM:`），并**逐条写入** `docs/CREWAI_PATCHES.md`，便于 subtree pull 时对照解决冲突。
3. 大版本升级前：先阅读上游 changelog，再对照 `CREWAI_PATCHES.md` 重放或调整补丁。

---

## 8. 与「仅 pip 安装」的关系

- **开发/定制**：以本文件流程为准（subtree + path）。
- **CI 或临时环境**：仍可短时间使用 PyPI 的 `crewai` 做冒烟；与生产/主线不一致时，应在流水线中改为 checkout subtree 并 `uv sync`，避免「本地可跑、线上行为不同」。
