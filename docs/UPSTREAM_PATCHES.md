# UPSTREAM_PATCHES — vscode 源码侵入式改动对账单

> 本文件记录所有对 `wfm-ide/` 下 **vscode 原有文件** 的修改。  
> **每次升级 vscode 前打开本文件；升级中如有冲突，一定出现在这里登记过的文件里。**  
> 新增的 WFM 自有代码（`contrib/wfm/**`、新资源文件）不需要登记。

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
- 目的：Workbench 渲染层通过 `fetch` 调用 `IRequestService` 时受 HTML CSP 约束；WFM 自建 Agent 后端默认 `http://127.0.0.1:8765`，不放宽则请求被拦截并报 `Failed to fetch`
- 升级检查：若上游调整 CSP 结构，把上述四项合并进新的 `connect-src` 列表

### wfm-ide/src/vs/code/electron-browser/workbench/workbench-dev.html

- 改动类型：修改（同上）
- 改动摘要：与 `workbench.html` 一致，保证 `./scripts/code.sh` 开发态同样可连本地 Agent
- 目的：同上
- 升级检查：同上

### wfm-ide/product.json

- 改动类型：字段值修改
- 改动摘要：品牌字段替换为 WFM Studio
- 目的：品牌化
- 升级检查：对比上游新增字段（遥测、更新源、AI 配置等），保留我们定制的字段值

### wfm-ide/src/vs/workbench/workbench.common.main.ts

- 改动类型：注释 import + 新增 import
- 改动摘要：
  - 注释（精简工作台）：terminal / debug / scm / testing 的 contribution
  - 新增（WFM 模块）：contrib/wfm/aiChat 等
- 目的：裁剪不需要的开发者模块 + 挂载 WFM 自己的模块
- 升级检查：确认注释和新增都还在；若上游重命名/删除我们依赖的模块路径，需调整

### wfm-ide/resources/darwin/code.icns

- 改动类型：二进制替换
- 改动摘要：替换为 WFM Studio icon
- 目的：品牌化
- 升级检查：上游若重命名该文件，跟着改名

### wfm-ide/resources/win32/code.ico

- 改动类型：二进制替换
- 同上

### wfm-ide/resources/linux/code.png

- 改动类型：二进制替换
- 同上

---

## 变更日志（每次修改或升级时追加一条）

- 2026-04-20 放宽 workbench HTML CSP `connect-src`，允许 WFM Agent 本地 HTTP/WS（`workbench.html` / `workbench-dev.html`）
- 2026-04-18 初始化本文件（Monorepo 整合完成，尚无具体定制）
