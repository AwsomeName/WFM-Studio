# WFM Studio 真实任务场景（用户故事与 API 映射）

> **用途**：把「任务对话」产品目标落到可验收的故事，并对齐 [wfm-agents `POST /v1/chat`](wfm-agents/wfm_agents/routes/chat.py) 与前端缺口。

---

## 后端请求体（当前）

| 字段 | 必填 | 说明 |
|------|------|------|
| `workspace_root` | 是 | 当前工作区根路径（IDE 已自动注入） |
| `message` | 是 | 用户任务描述 |
| `dxf_text` | 否 | 前端 viewer 直接附带的 DXF 文本（CAD 审图用） |
| `cad_source_uri` | 否 | CAD 文件 URI（支持 .dwg 和 .dxf，右键菜单或消息提取） |
| `dxf_source_uri` | 否 | 向后兼容，等同 `cad_source_uri` |
| `docx_path` | 否 | 工作区内 .docx 文件相对路径（DOCX 审阅用） |
| `attachments` | 否 | 文件附件列表（Explorer / 附件 UI），含 `uri`、`name`、`rel_path` |
| `session_id` | 否 | 会话 ID（连续对话） |
| `language` | 否 | `zh-CN`（默认） \| `en` |
| `recipe` | 否 | 已废弃（Router Agent 自行判断意图） |
| `mode` | 否 | 已废弃（接受但忽略） |
| `engine` | 否 | 已废弃（接受但忽略） |

响应除正文外还包含 `session_id` 和 `trace_id`（便于日志与评测）。

> **2026-05 agent_v2 v2.0 迁移**：对话后端已切到 Router Agent + Handoff 架构。所有请求统一发给 `router_agent`，由 LLM 根据意图决定 handoff 到专用 Agent（text_to_cad / cad_review / docx_review）。`engine`、`mode`、`recipe` 字段不再影响路由选择。详见 [`docs/ARCH_AGENT_SDK_NATIVE.md`](ARCH_AGENT_SDK_NATIVE.md)。

---

## 用户故事 1：打开仓库并确认「任务对话」连通

**作为**开发者，**我要**在打开文件夹后发送一句简单指令，**以便**确认 WFM Studio 与本地 Agent 后端闭环可用。

| 环节 | 行为 |
|------|------|
| 前置 | 后端 `GET /v1/health` 成功；IDE 侧栏显示「WFM Studio 后端已连接」 |
| 操作 | 在「任务对话」输入任意非空消息并发送 |
| 期望 | 收到助手回复；若 `mode` 为默认 `echo`，应答为 echo 类结果（见后端 `recipe_id` / `wfm.echo`） |

**API**：`POST /v1/chat/stream`（SSE 流式），仅需 `workspace_root` + `message`（与当前 [WfmAgentClientService](wfm-ide/src/vs/workbench/contrib/wfm/browser/wfmAgentClientService.ts) 一致）。IDE 优先走 SSE 流式端点，实时展示回复；若流式失败自动降级到 `POST /v1/chat` 同步端点。

**前端 SSE 流式展示**：
- 助手消息实时流式渲染，带闪烁光标和脉冲圆点
- 中间步骤可视化：Agent 切换（"调用 Agent: CAD 审图"）、工具调用（"读取文件..." → "读取文件 ✓"）
- 执行完成后活动日志折叠为摘要行（如 "5 步完成"），点击可展开查看详情
- 工具名自动映射为中文显示名

---

## 用户故事 2：用 OpenAI 兼容引擎完成「改一个文件」类任务（2026-05 默认链路）

**作为**开发者，**我要**用自然语言描述对当前仓库的小改动并让 Agent 执行，**以便**减少手写重复编辑。

| 环节 | 行为 |
|------|------|
| 前置 | `wfm-agents/.env` 配好 `WFM_OPENAI_API_KEY`、`WFM_OPENAI_BASE_URL`、`WFM_OPENAI_MODEL`（推荐 DashScope + `glm-5.1`）；后端默认引擎已是 `openai` |
| 操作 | 发送明确任务（例如「在 README 末尾加一行今日日期」） |
| 期望 | 返回可读的执行摘要或变更说明；工具若启用，应在工作区内产生真实变更（依工具策略） |

**API**：`POST /v1/chat/stream`（SSE 流式），body 默认不需要传 `engine`（默认即 `openai`）。模型与 base_url 由后端 env 决定，前端无感知。IDE 实时展示 Agent 执行步骤和流式文本。

**前端 SSE 已打通**：
- 工具调用步骤实时显示（读取文件、写入文件等），带 loading → ✓ 状态切换
- Agent 切换时显示 "调用 Agent: xxx"
- 文本增量流式输出

---

## 用户故事 3：固定编排引擎与可观测性（对比 OpenAI / CrewAI / MAF / Agenticx）

**作为**平台维护者，**我要**在同一工作区下切换引擎并保留追问上下文以外的关键元数据，**以便**评估不同后端表现。

| 环节 | 行为 |
|------|------|
| 前置 | 目标引擎已安装且配置合法（如 `openai` 需 `WFM_OPENAI_*` env；`crewai` 需 `WFM_CREWAI_*`） |
| 操作 | 指定 `engine` 发送相同 `message` |
| 期望 | 不同引擎返回均可解析；失败时返回明确 HTTP 错误信息 |

**API**：`POST /v1/chat`，body 显式传 **`engine`**（`openai` \| `crewai` \| `maf` \| `agenticx`）；不传则按 `WFM_DEFAULT_ENGINE` 选默认。

**前端缺口**：

- 请求体增加可选 **`engine`**。
- 展示响应中的 **`trace_id`**（及后续若扩展的 `tool_ledger`）——同步接口当前 [ChatReply](wfm-agents/wfm_agents/routes/chat.py) 已含 `trace_id`，前端可只读展示一行「本轮 trace」。

---

## 建议实现顺序

1. 故事 1：保持现状，用文案与状态栏强化「已连接 / 未响应」。
2. 故事 2：扩展 `IWfmAgentClientService.chat` 与设置或下拉，传入 `mode`（优先），再视需要 `engine`。
3. 故事 3：在故事 2 的基础上增加 `engine` 与 `trace_id` 展示；流式与工具进度可对接 `chat_stream` 另开迭代。

---

## 用户故事 4：CAD 浏览与审图（v0.2 真渲染 + 工具化审图，详见 [ARCH_CAD_REVIEW.md](ARCH_CAD_REVIEW.md) + [ARCH_CAD_REVIEW_AGENT.md](ARCH_CAD_REVIEW_AGENT.md)）

**作为**审图工程师，**我要**把 .dwg 或 .dxf 放进工作目录后双击就能看到接近 AutoCAD 的可交互视图（pan/zoom/选实体/切图层），再点工具栏「AI 审图」或在右侧任务对话里发指令拿审图意见，**以便**完整覆盖"看图 + 审图"两个动作。

| 环节 | 行为 |
|------|------|
| 前置 | 后端已起（`./scripts/dev-minimal.sh`）；`uv sync --extra dev` 已拉到 `ezdxf`。**无需安装 ODAFileConverter** |
| 操作 1 | Explorer 双击 .dwg 或 .dxf |
| 期望 1 | 中央区直接出现 cad-viewer：可平移/缩放/选实体/切图层/查图层统计；首次加载 1-2 秒下载 viewer bundle |
| 操作 2A | 在 viewer 工具栏点「AI 审图」按钮 |
| 期望 2A | viewer 把 in-browser 解析得到的 DXF 文本通过 IPC 送到 `POST /v1/chat/stream`（SSE 流式，带 `dxf_text` 字段）→ route 层写临时文件 → `cad_review_agent` 通过 8 个工具自主审图 → 右侧任务对话实时展示每个工具调用步骤和流式审图意见 |
| 操作 2B（兼容路径） | 在「任务对话」直接输入：`审一下 <相对路径>.dwg` |
| 期望 2B | 后端 chat 路由识别到 .dwg token → `_resolve_cad_file_ref` → 后端 DWG→DXF 转换 → `cad_review_agent` 通过工具自主审图 |

**API**：
- 审图：复用 `POST /v1/chat`，支持 `dxf_text`、`cad_source_uri`、消息中 `.dxf`/`.dwg` 路径三种入口
- route 层不再解析文件，只做路径标准化（`_resolve_cad_file_ref`），交给 `cad_review_agent` 的 8 个 `@function_tool` 自主完成审图
- 详见 [ARCH_CAD_REVIEW_AGENT.md](ARCH_CAD_REVIEW_AGENT.md) §6

**前端**：
- 模块 `contrib/wfm/cadReview/`（EditorPane + .dwg/.dxf 双关联 + webview 内嵌 cad-viewer）
- `IWfmAgentClientService.chat(message, { dxfText? })` 接受可选 inline DXF

**v0.2 已落地**：
- ✅ DXF / DWG 真渲染（cad-viewer + libredwg-web + Three.js + WebGL）
- ✅ viewer ↔ 审图触发联动（工具栏按钮）

**工具化审图已设计（待实现）**：
- `cad_review_agent` 拥有 8 个 `@function_tool`（总览 / 文字提取 / 标注提取 / 块提取 / 图层深挖 / 命名规范 / 标题块 / 标注精度），详见 [ARCH_CAD_REVIEW_AGENT.md](ARCH_CAD_REVIEW_AGENT.md) §3
- route 层简化为路径解析 + agent 选择，详见同文档 §6
- 后端 DWG→DXF fallback 转换，详见同文档 §4

**仍是缺口（Phase 3）**：

（配套文档：[CAD_AI_FEASIBILITY.md](CAD_AI_FEASIBILITY.md) 效果可行性与能力边界、[CAD_AI_SELECTION_REVIEW.md](CAD_AI_SELECTION_REVIEW.md) 实现方案。）

- 审图意见 issue ←→ viewer 实体高亮（双向定位）
- @文件自动补全
- 多模态视觉补充（截图喂 GPT-4V）
- 批量审图 + issue 持久化

---

## 用户故事 5：自然语言生成 3D CAD 模型（Text-to-CAD）

**作为**工程师，**我要**在任务对话中输入一句自然语言描述，系统自动生成对应的 STEP 3D 模型并渲染预览图，**以便**快速创建标准零件。

| 环节 | 行为 |
|------|------|
| 前置 | 后端已起；`build123d` + `playwright` + `trimesh` 依赖已安装；third_party/text-to-cad Three.js 已就位 |
| 操作 | 在「任务对话」输入：「生成一个 M10 六角螺栓」 |
| 期望 | router_agent 识别意图 → handoff 到 text_to_cad_agent → 生成 build123d 源码 → 编译 STEP → 渲染 PNG → 返回文件路径 |

**完整流程**（4 个 API 往返，`max_turns=15`）：

```
用户: "生成一个半径5mm的球体"
  → router_agent: 识别为 CAD 建模意图
  → handoff → text_to_cad_agent
  → workspace_write: cad_generated/sphere_r5.py (build123d 源码)
  → cad_generate_step: scripts/step → sphere_r5.step + .sphere_r5.step.glb
  → cad_render: scripts/render view → sphere_r5.png (Playwright + Three.js WebGL)
  → 返回: 源文件路径 + STEP 路径 + 预览图路径
```

**API**：`POST /v1/chat` 或 `POST /v1/chat/stream`，仅需 `workspace_root` + `message`。无需传 `recipe` 或 `engine`——Router Agent 自动识别。

**SSE 事件流**（流式接口，IDE 实时渲染）：

```
session → session_id
agent_handoff → wfm.router
tool_call_started → transfer_to_text_to_cad
agent_handoff → text_to_cad              → IDE 显示 "调用 Agent: 3D 模型生成"
text_delta → "我来为您生成..."            → IDE 流式显示文本
tool_call_started → workspace_write       → IDE 显示 "⟳ 写入文件..."
tool_call_done                           → IDE 显示 "✓ 写入文件 ✓"
tool_call_started → cad_generate_step     → IDE 显示 "⟳ 生成 STEP 模型..."
tool_call_done                           → IDE 显示 "✓ 生成 STEP 模型 ✓"
tool_call_started → cad_render            → IDE 显示 "⟳ 渲染预览..."
tool_call_done                           → IDE 显示 "✓ 渲染预览 ✓"
text_delta → 结果汇总
done → 最终文本，活动日志折叠
```

**依赖**：

| 依赖 | 大小 | 安装方式 |
|------|------|----------|
| build123d（含 OCP） | ~100MB | `uv add build123d` |
| Playwright + Chromium | ~170MB | `uv add playwright && python -m playwright install chromium` |
| Three.js | ~5MB | `cd third_party/text-to-cad/skills/cad/explorer && npm install three` |
| trimesh | ~5MB | `uv add trimesh` |

**渲染管线**：详见 [ARCH_RENDER_PIPELINE.md](ARCH_RENDER_PIPELINE.md)。

**限制**：
- LLM 生成的 build123d 代码质量取决于模型能力；复杂零件可能需要多轮修正
- `max_turns` 建议 ≤ 20，防止无限重试耗尽 API 配额
- Chromium 首次冷启动约 2-3 秒

