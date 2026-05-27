# 浏览器自动化方案 V2 — 架构决策记录

> 状态：**讨论中 / 待拍板**（倾向方案 3：独立 Chrome for Testing + 主编辑区 screencast 预览）
> 日期：2026-05-25
> 前置文档：[ARCH_BROWSER_AUTOMATION.md](./ARCH_BROWSER_AUTOMATION.md)（方案 A 已落地）

## 1. 背景：为什么需要重新讨论

方案 A（MCP HTTP → IPC → Playwright attach Electron WebContentsView → 主编辑区标签页）已跑通，但在真实场景（如 bigmodel.cn 登录）反复出现以下问题：

| 现象 | 影响 |
|---|---|
| Agent 填了手机号，主编辑区输入框仍为空 | 用户认为「Agent 在撒谎 / 后台操作」 |
| 按钮点击点不准 | Agent 反复 retry，消耗 token |
| 有时 Agent 弹出独立 **Google Chrome for Testing** 窗口并在外部填表 | 用户看到两个浏览器，不知道看哪边 |
| 同一 URL 多个僵尸 tab，Agent 操作与用户所见 tab 不一致 | 已通过 Phase 1 session 绑定缓解，但未根治 |
| `browser_read.body` 曾包含隐藏 DOM 文本，Agent 误判滑块验证码存在 | 已修复（TreeWalker + 可见性过滤） |

**核心结论：最难受的不是「功能少」，而是「两种浏览器同时在场，没有稳定默认行为」。**

- 用户默认以为：**主编辑区 = Agent 正在操作的页面**
- 实际可能是：主编辑区 WebContentsView **或** 外部 Chrome for Testing **或** 两者各操作一半
- 这种混合模式比「始终内嵌」或「始终独立 Chromium」都更差

---

## 2. 现有方案 A 的架构回顾

```
Chat → claude CLI → wfm_mcp_server (Python)
  → browser_tools.py (HTTP)
  → BrowserApiServer (main process)
  → BrowserBridgeService (renderer)
  → IPlaywrightService (sharedProcess, CDP attach)
  → Electron WebContentsView + BrowserEditorInput（主编辑区标签页）
```

**设计初衷**：网页渲染在编辑器主区域内，用户可见、可手动干预（验证码），AI 通过 Playwright 自动化。

**实际瓶颈**：Playwright 的 attach 模式 + Electron CDP 子集 + VS Code Editor 抽象 + 网站反爬，四层叠加导致自动化不稳定。

---

## 3. 为什么主编辑区「效果差」

需区分三件事：**画面渲染**、**自动化控制**、**网站兼容性**。

### 3.1 画面渲染：通常不差

主编辑区使用 Electron `WebContentsView`，底层同样是 **Chromium 渲染引擎**。HTML/CSS/JS、字体、布局、动画在视觉上往往与 Chrome 相近。

若「看起来不对」，更常见原因是 viewport 尺寸、DPI 缩放、UA 分支，而非引擎本身弱。

### 3.2 自动化控制：明显更差

独立 Chrome for Testing 路径：

```
Playwright → 完整 CDP (WebSocket) → 独立 Chromium → 正常窗口焦点 → locator.click/fill
```

主编辑区路径：

```
Python MCP → HTTP → Main → IPC → Renderer → Playwright attach (自定义 CDP transport)
  → Electron WebContentsView → 还要激活 Editor 标签页
```

中间 **4 层进程/抽象**，每层都可能丢失或扭曲事件：

| 环节 | 问题 |
|---|---|
| Playwright attach Electron | CDP 是**子集**，非完整 Chrome DevTools Protocol |
| VS Code Editor 抽象 | page 在前台了，标签/焦点/键盘可能仍在 Chat 面板 |
| Electron sandbox | Input / Dialog / FileChooser 与真 Chrome 行为不一致 |
| 自定义 CDP transport | 错误序列化、超时语义与 launch 模式不同 |

表现：**不是画不出来，是 Agent 的点击/输入没稳定落到用户看到的 input 上。**

### 3.3 网站兼容性：嵌入式浏览器常被「歧视」

登录页（bigmodel.cn 等）常检测：

- `navigator.webdriver`
- 缺少 `window.chrome`
- plugins / languages 异常
- Electron 环境特征
- 输入事件是否像「真用户触发」

独立 Chrome for Testing 更像标准自动化浏览器；Electron attach 可能 **表面渲染正常，但 silently 忽略 `.value` 或 click**。

### 3.4 IDE 集成带来的「手感差」

- 快捷键被 IDE 拦截（Cmd+W、Cmd+P 等）
- 焦点在 Chat / 编辑器 / Browser 标签间跳转
- 无完整浏览器壳（地址栏、扩展、密码管理）
- popup 走 Electron `setWindowOpenHandler`，行为与 Chrome 不同
- 中文 IME 在嵌套 webview 中 composition 事件路径更绕

---

## 4. Playwright 与 Chromium 的关系

**Playwright 自带 Chromium**，但不是打进 npm/pip 包内：

1. 安装 `playwright` / `playwright-core`
2. 运行 `playwright install`（或 `playwright install chromium`）
3. 单独下载 **Google Chrome for Testing**，常见路径：
   - macOS：`~/Library/Caches/ms-playwright/chromium-xxxx/`
   - 或项目内：`.build/wfm-backend/browsers/chromium-xxxx/`（打包产物）

| 模式 | 行为 |
|---|---|
| `chromium.launch()` | 启动 Playwright 下载的 Chromium → **独立 OS 窗口** |
| `chromium.connectOverCDP(ws://...)` | 连接已存在的 Chromium → **不 launch** |

**本项目现状**：

- **主编辑区**：Electron WebContentsView + Playwright **attach**（自定义 transport）→ **不用** Playwright 下载的那份 Chromium
- **Agent 偶尔弹出的独立窗口**：若走 Python `playwright` + `launch()` → 用的是 **Playwright 自带 Chromium**

社区「丝滑」的 Playwright MCP 几乎全是 **launch 模式**，Agent 操作的是 MCP 自起的 Chromium，与 IDE 内嵌浏览器无关。

---

## 5. 能否把 Google Chrome for Testing 运行在主编辑区？

### 5.1 真嵌入（OS 级窗口父子）— 基本不可行

| 平台 | 可行性 |
|---|---|
| macOS | ❌ 不能把其他 app 的 NSWindow 嵌进 Electron NSView |
| Windows | ⚠️ `SetParent()` 理论上可行，焦点/DPI/IME 坑多 |
| Linux Wayland | ❌ XEmbed 已死 |

**结论**：不能把 Chrome for Testing 像 iframe 一样原生嵌进编辑区 DOM。

### 5.2 可行替代

| 方案 | 描述 | 跨平台 | 推荐度 |
|---|---|---|---|
| **方案 1** | 继续 Electron WebContentsView（升级现有） | ✅ | 中（自动化弱） |
| **方案 2** | 独立 Chromium 窗口几何对齐到编辑区（假嵌入） | ⚠️ macOS 脆 | 中 |
| **方案 3** | 独立 Chromium + 主编辑区 CDP screencast 预览 | ✅ | **高** |
| **方案 4** | OS 原生嵌入 Chrome for Testing 进程 | ❌ | 低 |

---

## 6. 架构选项对比（完整）

### 方案 A：物理嵌入（OS 窗口父子）

把外部 Chromium 的 OS 窗口塞进 WFM 窗口。**macOS 不可行**，跨平台维护地狱。**不建议。**

### 方案 B：CDP Screencast（工业标准）

独立 Chromium + `Page.startScreencast` 推 JPEG/PNG 到编辑区 `<canvas>`，用户操作 → `Input.dispatch*` 回传。

- Browserbase、Steel.dev、E2B、Anchor 等均采用此路
- 延迟 5–50ms 一般可接受
- **中文 IME** 在 CDP 层支持差，需 `Input.insertText` 或逃生通道
- 右键、拖拽、文件下载需逐个补

### 方案 C：双窗口 + 镜像预览（折中）

独立 Chromium 正常 launch，主编辑区只读 screencast；手动干预时切到外部窗口。RPA 工具常见范式。

### 方案 D：继续 Electron WebContentsView + Playwright attach（现状）

- ✅ 真嵌入、零串流、IME 完美
- ❌ CDP 子集、反爬、需 `browser_type_native` / stealth / `_revealPage` 等大量补丁
- ❌ 与外部 launch 模式混用时体验分裂

### 独立实现「类似 Playwright」？

| 层级 | 能否自研 | 说明 |
|---|---|---|
| 底层 CDP 控制（navigate/click/type/read/screenshot） | ✅ | 薄 wrapper 即可，项目已有 evaluate、native click/type 基础 |
| 上层 locator 自动等待、跨浏览器、trace 等 | ❌ | 不值得重造，ROI 极低 |

**建议**：自研 **BrowserController（薄 CDP 层）** 服务 MCP 8 个动作，而非重写 Playwright。

---

## 7. 决策倾向：方案 3（Screencast）

### 7.1 产品定位

> **Agent 浏览器 = 独立 Chrome for Testing（唯一真源）**
> **主编辑区 = Agent Browser 预览 pane（screencast 直播屏，非真 DOM）**
> **需要手动验证码时 = 一键聚焦真窗口，或 pane 内转发输入**

不再混用「主编辑区当真浏览器自动化目标」与「外部 Chromium launch」。

### 7.2 目标架构

```
┌─────────────────────────────────────────────┐
│  WFM Studio 主窗口                            │
│  ┌──────────────┬───────────────────────┐    │
│  │   Sidebar    │ EditorGroup            │    │
│  │              │  ┌──────────────────┐ │    │
│  │              │  │ AgentBrowserPane │ │    │  ← screencast 直播屏
│  │              │  │  <canvas>        │ │    │
│  │              │  │  + 输入转发       │ │    │
│  │              │  └──────────────────┘ │    │
│  └──────────────┴───────────────────────┘    │
└─────────────────────────────────────────────┘
              ▲   ▲
              │   │  CDP WebSocket
              │   │  Page.screencastFrame ↓
              │   │  Input.dispatch*      ↑
       ┌──────┴────────────────────┐
       │ Chrome for Testing        │   ← 独立进程，Playwright 全功能
       │ （可隐藏到屏幕外）         │
       └───────────────────────────┘

Chat → claude CLI → wfm_mcp_server → browser_tools.py
  → BrowserApiServer (HTTP，接口不变)
  → CDPController (新，替代 BrowserBridgeService 的 Playwright attach 路径)
  → Chrome for Testing
  → ScreencastBridge → AgentBrowserPane
```

### 7.3 六个实现模块

| # | 模块 | 职责 | 复杂度 |
|---|---|---|---|
| 1 | **ChromiumLauncher** (main) | launch Chrome for Testing，`--remote-debugging-port`，可选隐藏窗口 | 低 |
| 2 | **CDPController** | WebSocket 直连 CDP；8 动作 API；可保留 Playwright `connectOverCDP` | 中 |
| 3 | **ScreencastBridge** | `Page.startScreencast`，IPC 推帧到 renderer，15–30fps 自适应 | 中 |
| 4 | **AgentBrowserPane** (renderer) | 新 `AgentBrowserInput` + canvas；鼠标/键盘 → CDP Input | 中 |
| 5 | **焦点/IME 兜底** | `Input.insertText` + 「打开真窗口」逃生按钮 | 高 |
| 6 | **旧链路收尾** | Agent 不再走 WebContentsView 自动化；保留给用户手动浏览 | 低 |

**Python MCP 接口保持不变**（`browser_open/read/click/type/...`），仅底层实现切换。

### 7.4 需接受的取舍

| 项 | 后果 |
|---|---|
| pane 内不是真 DOM | 不能直接选中/复制/右键（除非另做） |
| 冷启动 | 首次 `browser_open` 约 1–2s |
| 中文 IME | 短期可能不完美，需逃生通道 |
| 额外内存 | 约 +200–400MB |
| 下载/弹窗 | 需 CDP `Browser.downloadProgress` / `Page.javascriptDialog` |
| 用户手动浏览 | 旧 `BrowserEditorInput` 可保留，与 Agent 浏览器分离 |

### 7.5 风险点

1. **`Input.insertText` 在 React 受控 input 上行为不一致** — 可能需逐字符 `dispatchKeyEvent`
2. **快速滚动时 JPEG 糊几帧** — 一般可接受
3. **拖拽/上传文件** — pane 内拖文件需 `Page.setFileInputFiles` + path 跨进程传递
4. **Cookie 持久化** — 需固定 `user-data-dir`，否则每次重新登录
5. **企业代理/证书** — 独立进程网络栈不归 Electron 管

预计上线后仍有 **2–3 周修边角**期。

### 7.6 工程量估计

| 阶段 | 内容 | 估时 |
|---|---|---|
| Step 1 | POC：launch + canvas screencast，不接 Agent | 1 天 |
| Step 2 | CDP 8 动作 + MCP 切底层，bigmodel 登录闭环 | 2 天 |
| Step 3 | 输入转发 + 「打开真窗口」逃生 | 2 天 |
| Step 4 | IME / 下载 / 多 tab / user-data-dir 持久化 | 按需 |
| **MVP 合计（Step 1–3，不含 IME）** | | **约 5 天** |
| **含 IME 等完整版** | | **5–9 天** |

---

## 8. 与方案 A 的关系

| 能力 | 方案 A（现状） | 方案 3（倾向） |
|---|---|---|
| Agent 浏览器真源 | Electron WebContentsView | Chrome for Testing |
| 主编辑区显示 | 真 WebContentsView 标签页 | screencast canvas |
| Playwright 模式 | attach（CDP 子集） | connectOverCDP / launch（完整） |
| 用户手动浏览网页 | 同 Agent 浏览器 | 可分离：旧 BrowserEditorInput 保留 |
| MCP 工具名 | `browser_*` | **不变** |
| 反爬/填表成功率 | 低（bigmodel 等） | 预期更高 |

**迁移策略**：方案 A 代码不立即删除；Agent 路径切到方案 3 后，WebContentsView 浏览器降级为「用户普通浏览」专用。

---

## 9. 待用户确认

1. **产品定位**：是否接受「Agent 浏览器永远是独立 Chrome for Testing，主编辑区 pane 只看不真摸（或有限转发）」？
2. **落地节奏**：
   - **C → A → B**：先审本文档 → Step 1 POC 看延迟/画质 → Step 2–3 换底层（推荐）
   - 或直接 Step 1–3 并行开发
3. **旧 BrowserEditorInput**：Agent 禁用后，是否仍保留给用户手动打开网页？

---

## 10. 相关文件（方案 A，供对照）

| 文件 | 作用 |
|---|---|
| `wfm-agents/wfm_agents/agent_v2/browser_tools.py` | Python MCP 工具 |
| `wfm-ide/src/vs/platform/wfmClaude/electron-main/browserApiServer.ts` | HTTP 入口 |
| `wfm-ide/src/vs/workbench/contrib/wfm/electron-browser/browserBridgeService.ts` | 渲染进程桥（方案 A 核心） |
| `wfm-ide/src/vs/platform/browserView/node/playwrightService.ts` | Playwright attach Electron |
| `wfm-ide/src/vs/platform/browserView/electron-main/browserView.ts` | WebContentsView |

方案 3 新增/替换预期位置：`contrib/wfm/` 下新增 AgentBrowserPane、CDPController、ChromiumLauncher、ScreencastBridge（具体路径待 Step 1 设计时定）。

---

## 11. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-05-25 | 初稿：汇总混合模式痛点、各方案对比、倾向方案 3 screencast |
