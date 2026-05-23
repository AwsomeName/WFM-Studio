# UPSTREAM_PATCHES — vscode 源码侵入式改动对账单

> 本文件记录所有对 `wfm-ide/` 下 **vscode 原有文件** 的修改。
> **每次升级 vscode 前打开本文件；升级中如有冲突，一定出现在这里登记过的文件里。**
> 新增的 Uni-Studio 自有代码（`contrib/uni/**`、新资源文件）不需要登记。

---

## 登记格式

每条改动按以下格式记录：

```markdown
### <文件路径>

- 改动类型：修改 / 注释 / 替换 / 新增 import 行
- 改动摘要：一两句说清楚改了什么
- 目的：为什么改
- 升级检查：下次 subtree pull 冲突时怎么处理
```

---

## 当前改动清单

### wfm-ide/src/vs/code/electron-browser/workbench/workbench.html

- 改动类型：修改（Content-Security-Policy `connect-src`）
- 改动摘要：在 `connect-src` 中增加 `http://127.0.0.1:*`、`http://localhost:*` 及对应 `ws://` 源
- 目的：Workbench 渲染层通过 `fetch` 调用 `IRequestService` 时受 HTML CSP 约束；Uni-Studio Agent 后端默认 `http://127.0.0.1:8765`，不放宽则请求被拦截并报 `Failed to fetch`
- 升级检查：若上游调整 CSP 结构，把上述四项合并进新的 `connect-src` 列表

### wfm-ide/src/vs/code/electron-browser/workbench/workbench-dev.html

- 改动类型：修改（同上）
- 改动摘要：与 `workbench.html` 一致，保证 `./scripts/code.sh` 开发态同样可连本地 Agent
- 目的：同上
- 升级检查：同上

### wfm-ide/product.json

- 改动类型：字段值修改
- 改动摘要：品牌字段替换为 Uni-Studio（`nameShort`/`nameLong`/`applicationName`/`dataFolderName`/`urlProtocol`/`win32MutexName`/`darwinBundleIdentifier`/`linuxIconName`）；删除 `defaultChatAgent` 中 Copilot 引用；增加 `extensionsGallery.serviceUrl`（便于 `builtInExtensions` 从 Marketplace 拉取 VSIX）；在 `builtInExtensions` 中内置 `MS-CEINTL.vscode-language-pack-zh-hans`（与当前 `package.json` 的 VS Code 次版本线兼容的 1.110.x 语言包 + `sha256` 为 **fetch 解压后** 正文的校验和）
- 目的：品牌化 + 发行版附带简体中文语言包资源
- 升级检查：对比上游新增字段（遥测、更新源、AI 配置等），保留我们定制的字段值；`subtree pull` 后核对 `builtInExtensions`/`extensionsGallery` 是否需随上游合并

### wfm-ide/src/main.ts

- 改动类型：修改 + 新增 import
- 改动摘要：`createDefaultArgvConfigSync` 默认模板含 `"locale": "zh-cn"`；`readArgvConfigSync` 在**已存在** `argv.json` 但缺少/空 `locale` 时用 `jsonEdit.setProperty` **合并写回** `zh-cn`（尽量保留 JSONC）；`ENOENT` 创建默认文件后**立即再读**，避免首轮启动内存里仍为 `{}`；失败时内存回退 `{ locale: 'zh-cn' }`
- 目的：老用户与环境也能「开箱即简体」声明，不要求手改配置文件
- 升级检查：`readArgvConfigSync` / `jsonEdit` 若上游重构，保留合并 locale + 首轮再读两条逻辑

### wfm-ide/src/vs/base/node/nls.ts

- 改动类型：修改
- 改动摘要：**去掉** `VSCODE_DEV` 与 `!commit` 触发的英文短路；在无 `product.commit` 时用固定段 `development` 作为语言包缓存路径子目录
- 目的：开发启动（`code.sh`）与 OSS 源码无 commit 时仍能解析并应用语言包，配合 `argv`/`zh-cn`
- 升级检查：`resolveNLSConfiguration` 条件与 `join(..., commitSegment)` 若上游重写，逐项合并；注意缓存目录语义变化（`development` vs 真实 commit）

### wfm-ide/src/vs/workbench/workbench.common.main.ts

- 改动类型：注释 import + 新增 import
- 改动摘要：
  - 注释（精简工作台）：terminal / debug / scm / testing 的 contribution import
  - 新增（Uni-Studio 模块）：`contrib/uni/browser/uni.contribution.js`
  - 后续新增：`contrib/uni/pptEditor/browser/pptEditor.contribution.js`、`contrib/uni/docGen/browser/docGen.contribution.js`
  - 新增（WFM CAD 浏览与审图）：`contrib/wfm/cadReview/browser/cadReview.contribution.js`（v0.2：webview 内嵌 cad-viewer + libredwg-web 真渲染 .dwg/.dxf；详见 `docs/ARCH_CAD_REVIEW.md`）
- 目的：裁剪不需要的开发者模块 + 挂载 Uni-Studio / WFM Studio 自己的模块
- 升级检查：确认注释和新增都还在；若上游重命名/删除我们依赖的模块路径，需调整

### wfm-ide/src/vs/workbench/browser/workbench.contribution.ts

- 改动类型：修改默认配置值
- 改动摘要：`workbench.secondarySideBar.defaultVisibility` 从 `'visibleInWorkspace'` 改为 `'visible'`
- 目的：让 AI 对话面板默认可见（不需要先打开工作区）
- 升级检查：若上游重命名此配置键，跟着改

### wfm-ide/src/vs/workbench/contrib/terminal/browser/terminal.contribution.ts

- 改动类型：注释 registration
- 改动摘要：注释 `AgentHostTerminalContribution` 注册（line ~69）
- 目的：关闭 VS Code 内置 AgentHost 子系统告警（与本项目的 Agent 无关）
- 升级检查：确认注释还在；若上游重构此注册方式，需重新定位

### wfm-ide/package.json

- 改动类型：新增 devDependencies
- 改动摘要：增加 `@mlightcad/cad-simple-viewer`、`@mlightcad/data-model`、`@mlightcad/three-renderer`、`@mlightcad/libredwg-web`、`three`、`esbuild`，仅用于 `scripts/build-cad-viewer.mjs` 把 vendor 打成 `contrib/wfm/cadReview/browser/media/cad-viewer.iife.js`（v0.2 真渲染）
- 目的：CAD viewer vendor 打包；运行时不依赖这些包（webview 直接 `<script>` 加载 IIFE 产物）
- 升级检查：若上游 vscode 调整 devDependencies 列表导致冲突，照表合并即可；若 cad-simple-viewer 改 worker 配置，同步改 `scripts/build-cad-viewer.mjs` 与 `contrib/wfm/cadReview/browser/cadViewerEditor.ts` 中 `workerUrls` 注入

### wfm-ide/resources/darwin/code.icns

- 改动类型：二进制替换
- 改动摘要：替换为 Uni-Studio icon
- 目的：品牌化
- 升级检查：上游若重命名该文件，跟着改名

### wfm-ide/resources/win32/code.ico

- 改动类型：二进制替换
- 同上

### wfm-ide/resources/linux/code.png

- 改动类型：二进制替换
- 同上

### wfm-ide/src/vs/workbench/contrib/chat/browser/chatParticipant.contribution.ts

- 改动类型：注释 import
- 改动摘要：注释掉 12 个因原始 Chat panel 注册（38–81 行）被注释后而变为未使用的 import 符号（`Codicon`、`KeyCode`/`KeyMod`、`localize2`、`ContextKeyExpr`、`registerIcon`、`ViewPaneContainer`、`IViewContainersRegistry`/`IViewDescriptor`/`ViewContainer`/`ViewContainerLocation`、`ChatViewContainerId`、`ChatViewPane`），保留 `localize`、`IContextKeyService`、`IViewsRegistry`/`ViewExtensions`、`ChatViewId` 等仍被下游代码使用的符号
- 目的：TS 开启 `noUnusedLocals`，这些死 import 导致编译失败（12 errors），进而整个 chat contribution 链路在 workbench 启动时无法注册，WFM 对话面板 body 空白
- 升级检查：若上游重构此文件，确认注释掉的 import 与注释掉的注册代码仍对应；若上游删除注释块，一并删除对应注释掉的 import

### wfm-ide/src/vs/sessions/sessions.common.main.ts

- 改动类型：注释 import（2 处）
- 改动摘要：
  - 注释 `./contrib/welcome/browser/welcome.contribution.js` —— Microsoft "Welcome to Agents" sign-in 引导（GitHub/Google/Apple/GHE）
  - 注释 `./contrib/accountMenu/browser/account.contribution.js` —— Sessions 窗口的账户/登录侧栏（依赖 IDefaultAccountService + 同上 OAuth 链路）
- 目的：剥离 Microsoft Copilot Sessions 子窗口里的云端账户体系。本项目用本地 Claude CLI，不需要它
- 升级检查：上游若新增 import 行，按位置插回；若 welcome / accountMenu 拆分到新文件，对新文件做同样注释

### wfm-ide/src/vs/workbench/contrib/chat/electron-browser/chat.contribution.ts

- 改动类型：注释 import + 注释 registration
- 改动摘要：注释 `OpenAgentsWindowAction` 的 import（line ~48）与 `registerAction2(OpenAgentsWindowAction)`（line ~230）
- 目的：去掉 `workbench.action.openAgentsWindow` 命令注册。这个命令是 Microsoft Copilot Agents 子窗口的唯一入口；不注册即 (1) Command Palette 找不到、(2) Chat 标题栏菜单不会出 "Open Agents Application" 项、(3) `agentSessionsBanner` 的 `canShowAgentsBanner` 由于检测不到 command 自动返回 false，所有 welcome 页面里的「Try the new Agents app」横幅一起消失
- 升级检查：若上游把 `OpenAgentsWindowAction` 拆到新模块，对新文件做同样注释；若 banner / tip 的检测逻辑不再依赖此 command，需补充其他屏蔽手段

### wfm-ide/src/vs/workbench/contrib/chat/browser/chatTipCatalog.ts

- 改动类型：注释 entry + 注释未用 import
- 改动摘要：注释掉 `tip.openAgentsWindow` 这一条 ChatTip 配置块（含 buildMessage / when / excludeWhenCommandsExecuted / dismissWhenCommandsClicked）；同时注释掉因此 entry 移除而变为未用的 `ProductQualityContext` import
- 目的：聊天面板里不再向用户推荐打开 Microsoft Agents 子窗口（命令本身已经在 chat.contribution.ts 不再注册，tip 点进去也是无效命令，干脆拿掉）
- 升级检查：若上游新增其他 tip 引用 `ProductQualityContext`，把 import 注释打开

### wfm-ide/src/vs/code/electron-main/app.ts

- 改动类型：注释 if 分支
- 改动摘要：`openFirstWindow` 中针对 `process.isEmbeddedApp || (args['agents'] && quality !== 'stable')` 触发 `windowsMainService.openAgentsWindow(...)` 的整个 if 块用 `// 原始：...` 注释保留
- 目的：禁掉 Sessions Window 入口。Microsoft Copilot Agents Application 的 Sessions Window（`vs/sessions/electron-browser/sessions.html`）是一个**只为 Copilot Agents app 做的简化工作台**：左侧 Sidebar 直接挂 "Sessions / Customizations / Agents / Skills / Hooks / MCP / Plugins"，中央是 Chat Bar（"Copilot CLI" + "Default Approvals"），右侧 AuxiliaryBar 是专属的 "Files / Changes" 视图。该窗口加载 `sessions.common.main.ts` 而非 `workbench.common.main.ts`，因此 wfm 的 cadReview / docxViewer / htmlPreview / settings / wfm.contribution / wfmClaudeAgent 全部不会注册——表现就是布局左右颠倒、点 .dwg 直接进 BinaryFileEditor "binary or unsupported encoding" fallback、Explorer 右键菜单空白
- 升级检查：上游若把 sessions window 入口拆到别处或重命名（例如把 `openAgentsWindow` 改成 `openCopilotApp`），跟随重定位注释

### wfm-ide/src/vs/platform/windows/electron-main/windowsMainService.ts

- 改动类型：字段值改写
- 改动摘要：`createWindow` 计算 `isSessionsWindow` 时由「workspace.configPath === environmentMainService.agentSessionsWorkspace」改写为常量 `false`，原表达式以 `// 原始: ...` 形式保留
- 目的：兜底关闭 Sessions Window。即使用户磁盘上残留 `agentSessionsWorkspace.code-workspace`（被早期的 OpenAgentsWindow Action 触发后写入用户态），下次启动也强制走 `workbench.html` 而不是 `sessions.html`。配合 `app.ts` 同步改动构成「app 入口不进 + 即便进了也走普通 workbench」双保险。`windowImpl.ts` line 1212 的 `else if (configuration.isSessionsWindow)` 现在永远不命中
- 升级检查：上游若把 `isSessionsWindow` 改为函数或挪到别处，沿用同样常量化处理

### wfm-ide/src/vs/workbench/contrib/chat/browser/chat.contribution.ts

- 改动类型：注释 import + 注释 registerWorkbenchContribution2（共两组共 5 行）
- 改动摘要：
  - 注释 `import { ChatSetupContribution, ChatTeardownContribution } from './chatSetup/chatSetupContributions.js'`
  - 注释 `import { ChatStatusBarEntry } from './chatStatus/chatStatusEntry.js'`
  - 注释三条对应的 `registerWorkbenchContribution2(...)`：`ChatSetupContribution`、`ChatTeardownContribution`、`ChatStatusBarEntry`
- 目的：彻底剥离 Microsoft Copilot 在 ChatUI 里的登录/账户体系入口
  1. `ChatSetupContribution` 注册了 `workbench.action.chat.triggerSetup` / `triggerSetupForceSignIn` / `triggerSetupFromAccounts` / `signInIndicator`（钛色 "Sign In" 按钮挂在 `MenuId.TitleBarAdjacentCenter`）/ `triggerSetupAnonymousWithoutDialog` / `triggerSetupSupportAnonymous` / `UpgradePlanAction` / `EnableOveragesAction`，是 GitHub OAuth 登录、Copilot Pro 升级、扩展安装弹窗、AccountsContext 菜单 "Sign in to use AI features..." 的总入口。还会监听 `IExtensionsWorkbenchService` 同步 GitHub.copilot 安装状态，并注册 `ChatSetupExtensionUrlHandler` 接收 `vscode://github.copilot-chat/?...` 类型回调
  2. `ChatTeardownContribution` 通过 `chat.disableAIFeatures` 设置联动启用/禁用 GitHub.copilot 扩展，再 `setPartHidden(AUXILIARYBAR)`。WFM 没有 Copilot 扩展，相关逻辑无意义
  3. `ChatStatusBarEntry` 是右下角状态栏 "Sign In" / "Manage Copilot" 入口（依赖 `IChatEntitlementService.sentiment`），WFM 不需要
- 联动假设：`contrib/wfm/electron-browser/wfmClaudeAgent.contribution.ts` 已通过 `ChatContextKeys.Setup.completed/installed/hidden=...`、`Entitlement.signedOut=false` 把所有 ChatSetup 类 `when` 子句压成 false。`agentTitleBarStatusWidget.ts` 中残留的 `CHAT_SETUP_ACTION_ID` 引用是字符串常量分支（仅在 `signedOut=true` 时走 sign-in 分支），由我们的 ctx 兜底跳过；该命令未注册时即使被 `executeCommand` 也只是静默 noop
- 升级检查：上游若把 `ChatSetupContribution` / `ChatTeardownContribution` / `ChatStatusBarEntry` 拆分到新模块或改名，对应注释三处都要重新定位；如果 `agentTitleBarStatusWidget` 改成强依赖 `triggerSetup` 命令存在（例如 precondition 检查 command 注册），需要补充一个 noop CommandsRegistry.registerCommand 占位

---

## 变更日志（每次修改或升级时追加一条）

- 2026-05-23 永久关闭 Microsoft Copilot Sessions Window 入口：`code/electron-main/app.ts` 注释掉 `openFirstWindow` 里 `openAgentsWindow` 那段 if；`platform/windows/electron-main/windowsMainService.ts` 把 `isSessionsWindow` 常量化为 `false`。修复用户截图中"左侧 Sessions / Customizations、中央 Chat bar 带 Copilot CLI、右侧 Files/Changes"的反向布局，以及 .dwg 双击进 BinaryFileEditor 的现象。同时新增 `contrib/wfm/browser/wfm.contribution.ts` 通用「发送到对话」右键 Action（任意非目录文件 → 添加到 Chat 面板 attachmentModel）
- 2026-05-23 剥离 ChatUI 登录/账户/订阅入口：`chat/browser/chat.contribution.ts` 注释 `ChatSetupContribution` / `ChatTeardownContribution` / `ChatStatusBarEntry` 三组贡献的 import 与 `registerWorkbenchContribution2`。覆盖 `workbench.action.chat.triggerSetup*` 命令族、TitleBar "Sign In" 按钮、AccountsContext "Sign in to use AI features..." 菜单项、`chat.disableAIFeatures` 联动 Copilot 扩展启停、状态栏 Copilot 入口。原有 `wfmClaudeAgent.contribution.ts` 的 ctx 兜底（Setup.completed=true / signedOut=false / installed=true）继续生效，`agentTitleBarStatusWidget` 走默认 Toggle Chat 路径
- 2026-05-23 剥离 Microsoft Copilot "Agents" 子窗口与登录引导：`sessions.common.main.ts` 注释 welcome / accountMenu；`chat/electron-browser/chat.contribution.ts` 注释 `OpenAgentsWindowAction` 注册；`chatTipCatalog.ts` 注释 `tip.openAgentsWindow`。理由：本项目用本地 Claude CLI，不接 GitHub/Google/Apple OAuth
- 2026-05-09 S2：完成 ARCH_CAD_REVIEW v0.2 落地。前端新增 `cadViewerEditor.ts` / `cadViewerEditorInput.ts` / `cadViewerMessages.ts` / `media/{viewer.html-inline,viewer.js,viewer.css,VENDOR.md}`；删除 `dxfEditor.ts` / `dxfEditorInput.ts` / `media/dxfPreview.css`。`common/wfmAgentClient.ts` 加 `IWfmChatExtras` / `submitExternalChat` / `onExternalChatSubmission`；`browser/wfmAgentClientService.ts` 实现外部投递；`browser/wfmChatViewPane.ts` 订阅外部投递并复用 `runChat()`。后端 `cad/__init__.py` 加 `summarize_dxf_text`，`routes/chat.py` 加 `dxf_text` / `dxf_source_uri` 字段（`viewer_inline` 优先于 `workspace_file`）。`docs/ARCH_CAD_REVIEW.md` v0.2 + `wfm-ide/scripts/build-cad-viewer.mjs` + `wfm-ide/build/cad-viewer-entry.mjs` 配套
- 2026-05-09 ARCH_CAD_REVIEW v0.2：CAD 审图链路重构 —— 后端 ODA 整组下线（删 `wfm_agents/cad/converter.py`、`wfm_agents/routes/cad.py`、`server.py` 中 `cad.router` 注册、`__init__.py` 三个 ODA symbol export、`tests/test_cad.py` 两个 ODA 测试 class）；前端 `contrib/wfm/cadReview/browser/` 改为 cad-viewer（MIT）+ libredwg-web（GPL-3）webview，关联 .dxf + .dwg 双扩展；删 `wfm.cad.convertToDxf` 命令、Explorer 右键菜单与 `convertDwgToDxf` 客户端接口。`workbench.common.main.ts` 中的 import 路径 `contrib/wfm/cadReview/browser/cadReview.contribution.js` 不变（contribution 文件名保留，内部实现整改）
- 2026-05-09 `workbench.common.main.ts` 新增 `contrib/wfm/cadReview/browser/cadReview.contribution.js`（CAD 审图最小闭环 v0.1：DWG → DXF + DXF 预览编辑器 + Explorer 右键命令；v0.2 实现重构，import 路径保持不变）
- 2026-05-07 `main.ts`：`argv.json` 缺省/空 `locale` 时合并写回 `zh-cn`，`ENOENT` 创建后立刻再读；`nls.ts`：dev 与无 `commit` 时仍走语言包（缓存段 `development`）
- 2026-05-07 `main.ts` 默认 `argv.json` 写入 `locale: zh-cn`；`product.json` 增加 `extensionsGallery` 与简体中文内置语言包条目
- 2026-04-20 放宽 workbench HTML CSP `connect-src`，允许 Agent 本地 HTTP/WS（`workbench.html` / `workbench-dev.html`）
- 2026-04-18 初始化本文件（Monorepo 整合完成，尚无具体定制）
