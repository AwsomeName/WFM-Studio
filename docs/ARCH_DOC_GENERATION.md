# 标书/方案生成架构规格

> **状态**：规格（实现前）  
> **更新日期**：2026-05-07  
> **分支**：`feat/doc-generation`  
> **关联**：`docs/PLAN.md` Phase 7、`docs/ARCH_AGENT_SDK_NATIVE.md`（对话后端正式规格；工具底座由 `agent/tools/adapter.py` 复用既有 builtin/MCP provider）。原 `docs/ARCH_AGENT_GATEWAY.md` 工具层描述已废弃，相关 provider 代码本身保留。

---

## 1. 产品需求

用户需要两种标书/方案交互方式：

- **一键生成**：输入需求描述 → AI 自动完成整个标书生成流程（大纲 → 分章节 → 评审 → 格式化）→ 输出完整文档
- **精细调整**：在生成结果的基础上逐章节修改、补充、润色 → AI 辅助局部优化

---

## 2. 多步工作流

标书生成是 5 步 AI 工作流：

```
Step 1: 解析需求 → 结构化需求文档
Step 2: 生成大纲 → 确定章节结构和内容要点
Step 3: 分章节撰写 → 各章节并行/顺序生成
Step 4: 评审 → 检查完整性、合规性、逻辑一致性
Step 5: 格式化输出 → docx / markdown / pdf
```

每步对应一个 ToolProvider 工具，引擎通过 `ToolHandle.invoke` 串联调用。

---

## 3. 后端 Proposal ToolProvider

### 3.1 工具列表

| FQN | risk_tier | 功能 |
|-----|-----------|------|
| `uni.proposal_outline` | read | 根据需求描述生成结构化大纲（JSON） |
| `uni.proposal_write_section` | write | 撰写指定章节（章节名 + 大纲要点 → 正文） |
| `uni.proposal_review` | read | 评审草稿（完整性、合规、质量评分） |
| `uni.proposal_format` | write | 格式化输出（docx/markdown/pdf） |

### 3.2 工具实现策略

- 工具背后调用 LLM（通过 Agent Gateway 的引擎），但统一通过 `ToolHandle.invoke` 接口
- 引擎选择取决于 backend-eval 结果（硬依赖）
- 现有 Anthropic 引擎已有完整 ToolHandle 集成，可作为默认引擎

### 3.3 安全约束

- 所有文件操作通过 `resolve_within(workspace_root)` 强制工作区边界
- 输出文件限定在 workspace 内

---

## 4. 后端 HTTP 路由

| 路由 | 方法 | 功能 |
|------|------|------|
| `/v1/proposal/generate` | POST | 启动完整标书生成（recipe_id: `uni.proposal_generate`） |
| `/v1/proposal/refine` | POST | 精细调整指定章节 |
| `/v1/proposal/status` | POST | 查询生成进度 |

---

## 5. 前端文档生成 UI

### 5.1 注册

- `docGen.contribution.ts`：注册 ViewPane 在 AuxiliaryBar（AI Chat 下方）
- 文件位置：`wfm-ide/src/vs/workbench/contrib/uni/docGen/`

### 5.2 UI 流程

```
┌─────────────────────────────┐
│  标书/方案生成               │
├─────────────────────────────┤
│  1. 输入需求描述             │
│  ┌───────────────────────┐  │
│  │ textarea              │  │
│  └───────────────────────┘  │
│                             │
│  2. 选择模板 / 输出格式      │
│  ○ 标书  ○ 方案  ○ 报告     │
│  输出: ○ docx ○ md ○ pdf    │
│                             │
│  3. 生成大纲预览             │
│  ┌───────────────────────┐  │
│  │ 章节 1: xxx           │  │
│  │ 章节 2: xxx           │  │
│  │ ...                   │  │
│  └───────────────────────┘  │
│                             │
│  4. 章节调整（可选）         │
│                             │
│  [开始生成]  [取消]          │
│                             │
│  进度: ████████░░ 80%        │
│  当前: 正在撰写第3章...      │
└─────────────────────────────┘
```

- 所有 localize 使用中文默认字符串
- 生成进度通过 SSE 事件流实时更新

---

## 6. Proposal recipe 引擎集成

### 6.1 recipe_id: `uni.proposal_generate`

5 步 pipeline 对应不同引擎实现方式：

**Anthropic 引擎**（当前最深集成）：
- 多轮 tool-use loop：LLM 自动调用 `uni.proposal_outline` → `uni.proposal_write_section` → `uni.proposal_review` → `uni.proposal_format`
- `max_tool_rounds=16` 足够覆盖 5 步

**CrewAI 引擎**（深度改造后）：
- 多 Agent Crew：OutlineAgent → WriterAgent → ReviewerAgent → FormatterAgent
- 每个 Agent 通过 ToolHandle 调用对应工具

**硬依赖**：具体实现需等 backend-eval 选出引擎。

---

## 7. 与 ARCH_AGENT_GATEWAY 的关系

- Proposal 工具遵循 ARCH §3.3 ToolGateway 规范
- 引擎调用一律通过 `ToolHandle.invoke`（硬规范）
- HTTP 路由是 ToolProvider 的薄包装