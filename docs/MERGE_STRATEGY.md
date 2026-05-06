# 分支合并策略

> **更新日期**：2026-05-07  
> **关联**：`docs/PLAN.md` §8.2 并行分支策略

---

## 1. 分支定义

4 条并行分支从 `main` 拉出：

| 分支 | 职责 | 涉及目录 | 冲突风险 |
|------|------|----------|----------|
| `feat/backend-eval` | 框架对比 + Eval harness (M6) | `wfm-agents/` (tests/eval/) | 极低 |
| `feat/uni-studio-brand` | 品牌重命名 + 中文化 + 裁剪 | `wfm-ide/` (product.json, contrib/wfm→uni, workbench.common.main.ts, resources/) | 中 |
| `feat/ppt-editor` | PPT CustomEditor + PPTist + PPTX 工具 | `wfm-ide/contrib/uni/pptEditor/`, `wfm-agents/tools/pptx_provider.py`, `wfm-agents/routes/pptx_ops.py` | 低 |
| `feat/doc-generation` | 标书/方案生成 | `wfm-ide/contrib/uni/docGen/`, `wfm-agents/tools/proposal_provider.py`, `wfm-agents/routes/proposal_ops.py` | 低 |

---

## 2. 分支创建

```bash
cd /Users/apple/Desktop/WFM-Studio

# 先确保 main 干净
git status

# 创建 4 条分支
git checkout -b feat/backend-eval main
git checkout -b feat/uni-studio-brand main
git checkout -b feat/ppt-editor main
git checkout -b feat/doc-generation main
git checkout main
```

---

## 3. 并行开发窗口

每个分支一个 VS Code 窗口，各自 checkout：

| 窗口 | 分支 | 主要操作 |
|------|------|----------|
| 窗口 1 | `feat/backend-eval` | `cd wfm-agents && uv run pytest tests/eval/` |
| 窗口 2 | `feat/uni-studio-brand` | `cd wfm-ide && npm run watch && ./scripts/code.sh` |
| 窗口 3 | `feat/ppt-editor` | 前端 CustomEditor + 后端 PPTX 工具 |
| 窗口 4 | `feat/doc-generation` | 前端 docGen UI + 后端 Proposal 工具 |

---

## 4. 合并顺序

```
feat/backend-eval      → merge to main  (第 1，纯后端测试，最低风险)
feat/doc-generation    → merge to main  (第 2，依赖 eval 选出的引擎)
feat/ppt-editor        → merge to main  (第 3，前端 webview + 后端工具)
feat/uni-studio-brand  → merge to main  (第 4，面最广，最后覆盖)
```

**原因**：
- brand 分支改动面最广（product.json、main.ts、模块重命名），最后合并避免反复冲突
- backend-eval 纯测试代码，风险最低先合
- doc-generation 依赖 eval 选出的引擎，排第二
- ppt-editor 与 doc-generation 不冲突（不同目录），排第三

---

## 5. 合并流程

每个分支合并前：

```bash
# 1. 在分支上确保编译通过
cd wfm-agents && uv sync && uv run pytest
cd wfm-ide && npm run compile

# 2. rebase 到最新 main
git checkout feat/<branch>
git rebase main

# 3. 合并到 main（保留分支历史）
git checkout main
git merge --no-ff feat/<branch>

# 4. 在 main 上验证
./scripts/dev.sh --smoke-chat
```

---

## 6. 冲突热点与解决策略

| 冲突文件 | 原因 | 解决方案 |
|----------|------|----------|
| `wfm-ide/src/vs/workbench/workbench.common.main.ts` | brand 注释旧 import，其他分支加新 import | 保持注释块和新 import 块分开 |
| `wfm-agents/pyproject.toml` | 多个分支加依赖和 optional extras | extras 是追加式的，合并时 union |
| `wfm-agents/wfm_agents/server.py` | ppt-editor 和 doc-generation 各加新路由注册 | 合并时保留所有 router 注册 |

**workbench.common.main.ts 合并模板**：

```typescript
// ─── Uni-Studio: modules disabled for content-production workbench ───
// import './contrib/terminal/terminal.all.js';
// import './contrib/debug/browser/debug.contribution.js';
// ... (other commented-outs)

// ─── Uni-Studio: custom modules ───
import './contrib/uni/browser/uni.contribution.js';
import './contrib/uni/pptEditor/browser/pptEditor.contribution.js';
import './contrib/uni/docGen/browser/docGen.contribution.js';
```

---

## 7. 依赖关系

- `feat/doc-generation` 的 D4（recipe 引擎集成）**硬依赖** `feat/backend-eval` 的 E5（选定引擎）
- D1-D3（工具定义 + UI）可以先做，不依赖 eval
- 其他分支之间无硬依赖，可完全并行

---

## 8. 最终验证

合并全部完成后在 main 上验证：

1. IDE 启动 → 标题栏 "Uni-Studio"
2. AuxiliaryBar 默认可见 → 中文界面
3. 无终端/调试/源码管理图标
4. 双击 `.pptx` → PPTist CustomEditor
5. 标书生成 UI → 多步执行 → 输出文档
6. `curl /v1/health` → 200
7. `uv run pytest` → 全通过
8. Eval report 已产出 → 主引擎已选定