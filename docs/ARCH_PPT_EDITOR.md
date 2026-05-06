# PPT 编辑器架构规格（混合方案）

> **状态**：规格（实现前）  
> **更新日期**：2026-05-07  
> **分支**：`feat/ppt-editor`  
> **关联**：`docs/PLAN.md` Phase 6、`docs/ARCH_AGENT_GATEWAY.md` 工具层

---

## 1. 产品需求

用户需要两种 PPT 编辑模式：

- **整体模式**：输入 prompt → AI 生成完整 PPT → 一键下载/打开
- **精细模式**：双击 `.pptx` 文件 → 所见即所得编辑 → 逐页调整文本、布局、动画

两种模式之间可以无缝切换：AI 生成的 PPT 自动进入精细编辑器，精细编辑后的 PPT 可以再次由 AI 优化。

---

## 2. 技术方案

### 2.1 整体模式

```
Chat Pane → prompt → Agent Gateway → engine.run_turn()
                                → ToolHandle.invoke("uni.pptx_write", {spec, ...})
                                → python-pptx 创建 PPTX 文件
                                → 返回文件路径
          → IDE 打开该 .pptx → CustomEditor 激活
```

- 后端 `PptxToolProvider` 提供 `uni.pptx_write` 工具
- 引擎（Anthropic/CrewAI）调用 ToolHandle 生成 PPT
- Chat pane 加快捷按钮："生成 PPT"

### 2.2 精细模式

```
用户双击 .pptx → CustomEditor 激活 → Webview 加载 PPTist
                                → 后端 uni.pptx_to_pptist → PPTist JSON
                                → PPTist 渲染

用户编辑 → PPTist 输出 JSON → postMessage → IDE 前端
                          → HTTP uni.pptist_to_pptx → python-pptx 更新 PPTX
                          → 保存到 workspace
```

- PPTist：Vue 开源 PPT 编辑器（https://github.com/pipipi-pikachu/PPTist）
- 嵌入方式：打包为独立 HTML + JS，放入 webview media 目录
- 通信：`acquireVsCodeApi().postMessage()` 双向

### 2.3 双向转换层

python-pptx 作为 PPTist ↔ PPTX 的格式桥梁：

| 方向 | 工具 FQN | 输入 | 输出 |
|------|----------|------|------|
| PPTX → PPTist | `uni.pptx_to_pptist` | PPTX 文件路径 | PPTist 兼容 JSON |
| PPTist → PPTX | `uni.pptist_to_pptx` | PPTist JSON + 目标路径 | 更新 PPTX 文件 |

转换层需要处理的映射：

- PPTX slide → PPTist slide（形状、文本框、图片位置）
- PPTist slide → PPTX slide（反向）
- 不完全兼容的元素（动画、SmartArt）需要降级处理策略

---

## 3. 后端 PPTX ToolProvider

### 3.1 工具列表

| FQN | risk_tier | 功能 |
|-----|-----------|------|
| `uni.pptx_read` | read | 读 PPTX 结构 → JSON（幻灯片索引、shape、文本、布局） |
| `uni.pptx_write` | write | 从 JSON spec 创建/更新 PPTX |
| `uni.pptx_slide_edit` | write | 修改指定幻灯片（文本、shape、布局） |
| `uni.pptx_render_slide` | read | 渲染单页为 SVG/PNG（用于预览） |
| `uni.pptx_to_pptist` | read | PPTX → PPTist JSON（精细编辑器打开时调用） |
| `uni.pptist_to_pptx` | write | PPTist JSON → PPTX（精细编辑器保存时调用） |

### 3.2 安全约束

- 所有工具通过 `resolve_within(workspace_root)` 强制工作区边界
- PPTX 文件路径必须在 workspace 内
- 与 ARCH_AGENT_GATEWAY §5.1 安全模型一致

### 3.3 依赖

- `python-pptx>=1.0.2`（加入 `pyproject.toml` dependencies）

---

## 4. 后端 HTTP 路由

| 路由 | 方法 | 功能 |
|------|------|------|
| `/v1/pptx/read` | POST | 读 PPTX 结构 |
| `/v1/pptx/write` | POST | 创建/更新 PPTX |
| `/v1/pptx/convert-to-pptist` | POST | PPTX → PPTist JSON |
| `/v1/pptx/convert-from-pptist` | POST | PPTist JSON → PPTX |

所有路由带 `workspace_root` 参数，与现有路由模式一致。

---

## 5. 前端 CustomEditor

### 5.1 注册

- `pptEditor.contribution.ts`：注册 `CustomEditorSelector` 匹配 `*.pptx`
- 注册为 `ICustomEditorService` 的 viewer 类型
- 文件位置：`wfm-ide/src/vs/workbench/contrib/uni/pptEditor/`

### 5.2 Webview 实现

- `pptEditorPane.ts`：Webview-based editor pane
- 加载 PPTist HTML/JS/CSS
- 通信协议：
  - 打开时：`loadPptist` message → 包含 PPTist JSON
  - 保存时：`pptistData` message → 包含编辑后的 JSON → 前端调用 `uni.pptist_to_pptx`
  - AI 生成时：`generatePpt` message → 触发 chat pane 的 recipe

### 5.3 模式切换

- 整体模式入口：Chat pane "生成 PPT" 按钮 → recipe_id `uni.pptx_generate`
- 精细模式入口：双击 `.pptx` 文件 → CustomEditor 自动激活
- 两者共享同一个 CustomEditor，通过 `mode` 属性区分

---

## 6. PPT 生成 recipe

- `recipe_id: "uni.pptx_generate"`
- Anthropic 引擎：多轮 tool-use loop → LLM 调 `uni.pptx_write`
- CrewAI 引擎（深度改造后）：PPT Designer agent + `uni.pptx_write`

---

## 7. 与 ARCH_AGENT_GATEWAY 的关系

- PPTX 工具遵循 ARCH §3.3 ToolGateway 规范（FQN、risk_tier、ToolPolicy）
- 引擎调用 PPTX 工具一律通过 `ToolHandle.invoke`（硬规范）
- HTTP 路由是 ToolProvider 的薄包装，与现有 workspace_ops 模式一致