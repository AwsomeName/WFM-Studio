# 浏览器自动化方案 — AI 操作网页

> 状态：方案 A 已落地（MCP HTTP → 主进程 IPC → 渲染进程 IPlaywrightService + IEditorService.openEditor）
> 日期：2026-05-24（落地）/ 2026-05-24（最初调研）

## 1. 场景

用户在 Chat 会话中告诉 AI 一个网址（如公司 OA），AI 替用户操作网页：登录、点击菜单、浏览视频。网页渲染在编辑器主区域内，而非外部浏览器。

## 2. 已有基础设施

| 组件 | 路径 | 作用 |
|---|---|---|
| 浏览器编辑器 | `wfm-ide/src/vs/workbench/contrib/browserView/electron-browser/browserEditor.ts` | 在编辑器标签页里渲染网页 |
| WebContentsView | `wfm-ide/src/vs/platform/browserView/electron-main/browserView.ts` | Electron 原生 Chromium 嵌入 |
| Playwright 服务 | `wfm-ide/src/vs/platform/browserView/node/playwrightService.ts` | 通过 CDP 直连内嵌浏览器（不启动外部 Chromium） |
| Agent 工具集 | `wfm-ide/src/vs/workbench/contrib/browserView/electron-browser/tools/` | 11 个工具，已注册到 `ILanguageModelToolsService` |
| Chat 集成 | `wfm-ide/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts` | 浏览器与 Chat 交互（元素检查 → 发送到 Chat） |

### 工具清单（11 个）

| Tool ID | 名称 | 功能 |
|---|---|---|
| `open_browser_page` | OpenBrowserTool | 打开 URL |
| `read_page` | ReadBrowserTool | 读取页面内容 |
| `screenshot_page` | ScreenshotBrowserTool | 截图确认 |
| `navigate_page` | NavigateBrowserTool | 导航到 URL |
| `click_element` | ClickBrowserTool | 点击元素 |
| `drag_element` | DragElementTool | 拖拽元素 |
| `hover_element` | HoverElementTool | 悬停 |
| `type_in_page` | TypeBrowserTool | 输入文字 |
| `run_playwright_code` | RunPlaywrightCodeTool | 执行任意 Playwright 代码 |
| `handle_dialog` | HandleDialogBrowserTool | 处理浏览器弹窗 |
| `open_browser_page_non_agentic` | OpenBrowserToolNonAgentic | 非 Agent 模式打开浏览器 |

工具受 `workbench.browser.enableChatTools` 配置项控制，关闭时仅保留非 Agent 模式的打开工具。

## 3. 架构：三层模型

```
┌─────────────────────────────────────────────────┐
│  Layer 1: 渲染层                                 │
│  Electron WebContentsView（原生 Chromium 实例）   │
│  嵌入在 VS Code 编辑器标签页中                    │
│  关键文件: platform/browserView/electron-main/    │
└──────────────────────┬──────────────────────────┘
                       │ CDP
┌──────────────────────▼──────────────────────────┐
│  Layer 2: 自动化层                               │
│  PlaywrightService 通过自定义 Transport 管道      │
│  把 CDP 消息通过 VS Code IPC 传给 WebContentsView │
│  不启动独立 Chromium，直接连接编辑器内浏览器       │
│  关键文件: platform/browserView/node/             │
└──────────────────────┬──────────────────────────┘
                       │ Tool Calls
┌──────────────────────▼──────────────────────────┐
│  Layer 3: Agent 层                               │
│  11 个工具已注册到 ILanguageModelToolsService     │
│  关键文件: contrib/browserView/electron-browser/  │
│           tools/browserTools.contribution.ts      │
└───────────────────────────────────────────────────┘
```

登录态支持三种 session 模式：`global`（跨工作区共享，关闭后保留，适合 OA）、`workspace`（按工作区隔离）、`ephemeral`（关闭即清除）。OA 场景推荐 `global`。

## 4. 关键问题：WFM Chat 无法调用浏览器工具

### 现状：两套隔离的工具系统

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│  VS Code 原生 Agent 路径     │     │  WFM Chat Agent 路径          │
│  (Copilot / AgentHost)      │     │                              │
│                             │     │  invoke()                    │
│  AgentHostSessionHandler    │     │    → claude CLI subprocess   │
│    → ILanguageModelToolsService │ │      --mcp-config            │
│      → browser tools ✓      │     │        → wfm_mcp_server only │
│                             │     │          → browser tools ✗   │
└─────────────────────────────┘     └──────────────────────────────┘
```

**WFM Chat Agent 的工作方式：**
- 注册为 `chatAgentService.registerDynamicAgent()` 的动态 Agent
- `invoke()` 调用 `wfmClaudeMainService.runTurn()`
- 主进程启动 `claude` CLI 子进程（`--output-format stream-json --mcp-config`）
- MCP 配置仅包含 `wfm_agents.agent_v2.wfm_mcp_server`（Python MCP 服务器）
- **从不读取 `ILanguageModelToolsService`**，不感知 VS Code 注册的任何工具

**为什么浏览器工具不可达：**
1. 浏览器工具注册在 VS Code 渲染进程的 `ILanguageModelToolsService`
2. `claude` CLI 子进程只能看到 MCP 配置中的工具
3. WFM Agent 从不读取 `request.userSelectedTools`，从不调用 `ILanguageModelToolsService`
4. 两套系统之间没有任何桥接

### 连通方案（三选一）

| 方案 | 思路 | 优点 | 缺点 |
|---|---|---|---|
| **A. MCP 桥接** | 写一个 `browser_mcp_server`（Node），把浏览器工具封装为 MCP 工具，加入 `--mcp-config` | 最小改动，复用现有 CLI 架构 | 需要新增 MCP 服务器进程 |
| **B. 双向桥接** | 让 `claude` CLI 能请求 VS Code 侧的工具调用（类似 `AgentHost._executeClientToolCall`） | 统一所有 VS Code 工具 | 改动大，需要自定义 CLI 协议 |
| **C. 放弃 CLI** | 在 `invoke()` 内直接用 `ILanguageModelToolsService` 处理工具调用，不走 CLI 子进程 | 最干净，工具完全统一 | 需要重写 WFM Agent 核心调用链 |

**推荐方案 A**：改动最小，且与现有 MCP 架构一致。核心工作是新建一个 MCP 服务器，将 Playwright/browser 操作暴露为 MCP tools。

### 已落地实现（2026-05-24）

实际采用的是方案 A 的精细化版本。我们没有新建独立 MCP 服务器进程，而是把现有的 `wfm_mcp_server` 里已经写好的 `browser_tools.py`（通过 `WFM_BROWSER_API_PORT` 走 HTTP）改造为：

```
Chat → claude CLI → wfm_mcp_server (Python)
   → browser_tools.py (HTTP POST)
   → BrowserApiServer (main process, platform/wfmClaude/electron-main/browserApiServer.ts)
     ── 只做 HTTP↔IPC 转换 ──
   → wfmBrowserBridge channel (IPC, getChannel via StaticRouter)
   → BrowserBridgeService (renderer, contrib/wfm/electron-browser/browserBridgeService.ts)
   → IPlaywrightService (sharedProcess via PlaywrightChannel)
     + IEditorService.openEditor({ resource: BrowserViewUri.forId(pageId) })
   → BrowserEditorResolver 创建 BrowserEditorInput → 主编辑区标签页
```

**关键效果**：
- `open` 之后页面会在主编辑区出标签页（BrowserEditorInput + WebContentsView），用户**看得见**网页内容，可以**手动点击/输入**（解决验证码、补完表单），与 AI 的 Playwright 自动化共存
- 所有命令（navigate/click/type/hover/read/screenshot/dialog/close）都走 Playwright（CDP），与上游 11 个工具同链路，行为一致
- screenshot 走 `IBrowserViewWorkbenchService.captureScreenshot`，从编辑器实际渲染像素抓，不会触发页面 flash

**`browser_read.body` 只包含可见文本（2026-05-25 追加）**：

之前 `_readPageContent` 用 `document.body.innerText` 拿 body 文本，这个 API 会把 `visibility:hidden` / `opacity:0` / 屏幕外定位的元素文本也包括进来。实际遇到的事故：bigmodel.cn 把滑块验证码组件预渲染在 DOM 里（"拖动下方拼图完成验证" / "安全验证"），但视觉上隐藏，只有触发风控才显示。Agent 拿到 body 看见这段文本就**正确地**推断"页面有滑块"，但用户看不到滑块 —— **从 Agent 视角看就是 IDE 在撒谎**。

修复：`_readPageContent` 改用 `TreeWalker` 遍历文本节点，对每个节点的祖先链做可见性检查（`display` / `visibility` / `opacity` / `getBoundingClientRect`），并缓存检查结果。只有真正会被用户看到的文本才进 body。Element 列表本来就有 `visible` 字段，不动。

**Chat ↔ Page 隐式绑定（2026-05-25 追加 / Phase 1）**：

之前的设计要求 Agent 在 context 里持续记忆 36-char `pageId` uuid 才能定位 tab，实践证明 Agent 容易记错、混淆，或在 `close+open` 循环里失忆 —— 表现为「Agent 自言自语滑块验证、用户看不到滑块」「同一站点 3 个僵尸 tab、不知道用哪个」等。

修复方法：每个 Chat session（== `claude` CLI 起的 wfm_mcp_server 子进程）在 `wfm_agents/agent_v2/browser_tools.py` 里维护 module-level 的 `_session: _BrowserSession`：
- `browser_open(url)` 自动 bind 当前 page
- 所有 mutating 工具的 `page_id` 改为 `Optional[str]`，默认 `None` 时走 `_session.resolve(None)` 取 current
- 传 explicit `page_id` 会 **同时 rebind**（用具体 pageId 调用 = "现在我把焦点放到这"）
- `browser_close` 命中当前 page 时自动 unbind
- 新工具：
  - `browser_switch(page_id)` — 显式切换 current（多 tab 并行时用）
  - `browser_current_page()` — 查询 + 自动清理"绑定到已关闭 tab"的孤儿状态
- `browser_list_pages` 返回里多了 `"current": <bound pageId or null>`，Agent 能比对 `current` vs `isActive` 自查"我操作的是不是用户看的"

效果：Agent 大多数情况下完全不需要传/记 pageId；真要 multi-tab 时也只需 `browser_switch` 一次。Phase 2（待定）会在 BrowserEditorInput 上加 "AI-bound" 视觉标记。

**click / type 各有"标准"与"native fallback"两套，AI 自选**（2026-05-24 追加）：
- `browser_click` (HTTP `/click`) → `page.locator(sel).click()`，走 Playwright 全套 actionability 检查；推荐先用
- `browser_click_native` (HTTP `/click_native`) → `page.evaluate(...)` 派发 `pointerdown/mousedown/mouseup/click` MouseEvent；当上面的标准方式因为 `<div role="button">`、被 fixed header 遮挡等情况超时时用
- `browser_type` (HTTP `/type`) → `page.locator(sel).fill()`，语义化、自动 clear + type
- `browser_type_native` (HTTP `/type_native`) → `page.evaluate(...)` 用 `HTMLInputElement.prototype` 的 value setter + 派发 `input`/`change`；专门解决 React/Vue 受控组件 + valueTracker（Ant Design / Element UI 等）拒绝接受 `locator.fill()` 的场景
- MCP 工具描述里已写明顺序：先标准，失败 fallback native，AI 模型自己看情况切换

**新增文件**：
- `wfm-ide/src/vs/workbench/contrib/wfm/common/browserBridge.ts` — 接口、channel name
- `wfm-ide/src/vs/workbench/contrib/wfm/electron-browser/browserBridgeService.ts` — 实现
- `wfm-ide/src/vs/workbench/contrib/wfm/electron-browser/browserBridge.contribution.ts` — DI + channel registration

**修改文件**：
- `workbench.desktop.main.ts` — 增 import（已登记 UPSTREAM_PATCHES）
- `code/electron-main/app.ts` — 增一行 `wfmClaudeService.attachIpcServer(mainProcessElectronServer)`（已登记 UPSTREAM_PATCHES）
- `platform/wfmClaude/electron-main/browserApiServer.ts` — 重写为 HTTP↔IPC 转发，删旧的裸 `IBrowserViewMainService` 调用
- `platform/wfmClaude/electron-main/wfmClaudeMainService.ts` — 删 `IBrowserViewMainService` 依赖、增 `attachIpcServer(server)` 方法

## 5. 已知限制

- **验证码**：图形验证码需要额外处理，AI 解验证码能力有限
- **Token 消耗**：复杂页面 accessibility tree 较大，消耗 context
- **桌面端专属**：WebContentsView 仅在 Electron 桌面端可用
- **文件下载**：浏览器内下载能力有限
- **弹窗/对话框**：部分浏览器弹窗可能被阻止（已有 `handleDialog` 工具缓解）

## 6. 下一步

1. **确认连通方案**：与用户确认选 A/B/C 哪个方案
2. **实现 `browser_mcp_server`**（若选 A）：Node MCP 服务器，调用 VS Code Extension API 操控浏览器
3. **更新 `_buildMcpConfigJson()`**：将新 MCP 服务器加入 WFM Agent 的 MCP 配置
4. **端到端测试**：在 WFM Chat 中输入"打开 oa.company.com"验证完整流程
