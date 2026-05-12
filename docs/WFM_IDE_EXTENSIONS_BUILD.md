# WFM Studio（wfm-ide）：内置插件与编译流程说明

面向开发者。说明 VS Code fork（`wfm-ide/`）里「预制插件」「编译」「开发 / 打包」「用户安装插件」分别在哪里、是否持久化，以及如何把自己的插件打进产物。

更细的 fork 维护流程见 [VSCODE_UPSTREAM.md](./VSCODE_UPSTREAM.md)；上游裁剪守则见仓库 `.cursor/rules/wfm-ide-fork-policy.mdc`。

---

## 1. 开发模式 vs 打包模式

| 模式 | 典型用法 | 含义 |
|------|-----------|------|
| **开发模式** | `npm run watch` + `./scripts/code.sh` | 不产出完整安装包；/workbench 与部分扩展增量编译，便于调试。 |
| **打包模式** | `npm run gulp compile-extensions-build` 及整套打包流水线 | 生成可分发的产物（内含内置扩展目录等）。 |

---

## 2. 两类插件存放位置（内置 vs 用户安装）

**内置插件**（仓库源码扩展、`product.json` 里列出的预制扩展打包结果）在 IDE **安装包内部**（例如 macOS 下应用包内的 `Resources/app/extensions/`）。

**用户通过 Marketplace「安装」的插件**写在用户数据目录下，与本仓库编译产物分离。以当前 `wfm-ide/product.json` 中的 `dataFolderName` 为准（例如 `.vscode-oss`），扩展通常在：

`~/.vscode-oss/extensions/`（路径会因产品与操作系统略有差异）。

因此：**重装或重新编译 IDE 一般不会删掉用户已安装的插件**；内置与用户扩展是两套路径。

---

## 3.「下次编译」时，哪些东西会参与？

### 3.1 用户在 IDE 里安装的插件（用户目录下）

**不参与编译**，也不会自动打进官方打包脚本产出的「内置扩展」集合；运行时由 IDE 从用户扩展目录加载。

### 3.2 `product.json` 中 `builtInExtensions` 列出的预制扩展

**会参与打包阶段的内置扩展集合**。构建脚本会先尝试使用缓存目录下的已解压版本；若 `package.json` 中的版本与 `product.json` 声明的版本一致，则复用缓存，不必重复下载。版本变更时会重新拉取并对照 `sha256`。

实现入口可参考：`wfm-ide/build/lib/builtInExtensions.ts`、`wfm-ide/build/lib/extensions.ts`。

### 3.3 仓库内 `wfm-ide/extensions/<name>/` 自带源码的扩展

每次完整打包流程会按策略重新打包这些扩展（开发模式下多为增量编译）。具体逻辑（esbuild / vsce 列表、`native` 与普通扩展分流等）见 `wfm-ide/build/lib/extensions.ts`。

---

## 4. 想要「预制」插件——是否需要把源码放进仓库？

**不一定。**常见有两种做法：

### 4.1 第三方已有扩展（推荐：配置驱动，不写进 `extensions/`）

在 **`wfm-ide/product.json`** 的 **`builtInExtensions`** 数组中增加一条记录（含 `name`、`version`、`sha256`、`metadata` 等）。可选：

- 配置 **`extensionsGallery.serviceUrl`** 后从 Marketplace 拉取对应版本的 VSIX；
- 或使用 **`vsix`** 字段指向仓库内的 VSIX 文件路径（适合内网或固定离线包），仍配合 **`sha256`** 校验。

构建时会解压 VSIX 并写入内置扩展输出目录。**无需**把扩展源码完整拷贝进 `extensions/`。

### 4.2 自有扩展（源码在仓库）

将扩展放到 **`wfm-ide/extensions/<your-extension>/`**，具备与其它内置扩展类似的结构（`package.json`、`tsconfig.json`，多数还会有 `esbuild.mts` 等）。打包流水线会扫描 `extensions/*/package.json` 并纳入内置扩展打包。

**fork 策略提醒**：`.cursor/rules/wfm-ide-fork-policy.mdc` 要求**新业务优先写在** `wfm-ide/src/vs/workbench/contrib/wfm/**`，避免在上游目录散落定制。**仅在确实需要以 Extension Host + `vscode.*` API 形态交付时**，再考虑放在 `extensions/`（可用清晰前缀例如 `wfm-*` 与上游扩展区分）。

---

## 5. 一句话对照

- **用户安装的插件**：在用户目录，**不参与**内置扩展编译，**一般不因重编 IDE 而丢失**。
- **预制内置插件**：要么 **`builtInExtensions` + VSIX/Marketplace**，要么 **`extensions/` 源码参与打包**。
- **自有 UI / 深度集成**：优先 **`contrib/wfm/`**，而不是默认堆进 `extensions/`。

---

## 6. 相关脚本与文件（便于检索）

| 用途 | 位置 |
|------|------|
| 预制扩展清单、`extensionsGallery` | `wfm-ide/product.json` |
| 扩展打包与本地 / Marketplace 流 | `wfm-ide/build/lib/extensions.ts` |
| 预制扩展下载与缓存判断 | `wfm-ide/build/lib/builtInExtensions.ts` |
| gulp 任务：编译 / watch / `compile-extensions-build` | `wfm-ide/build/gulpfile.extensions.ts` |
| npm：`download-builtin-extensions`、`compile-extensions-build` 等 | `wfm-ide/package.json` |
