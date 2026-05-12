# USAGE_CAD_VIEWER — CAD 预览与审图操作指南

> **面向**：日常使用者 / 试用者
> **关联架构**：[ARCH_CAD_REVIEW.md](ARCH_CAD_REVIEW.md)
> **版本**：随 v0.2 viewer（cad-simple-viewer + libredwg-web）一起发布。

WFM Studio 把 `.dwg / .dxf` 直接渲染在中央编辑区，不再依赖 ODA 后端。本文档只讲怎么用，不讲实现，遇到行为不符再去看 `ARCH_CAD_REVIEW.md`。

---

## 1. 打开文件

- **直接双击** Explorer 里的 `.dwg` / `.dxf` 文件即可。
- 编辑器 tab 标题是文件名，下方是 viewer 工具栏，再下面是画布。
- 文件 > 25 MB 会拒绝渲染并提示用桌面 CAD 拆图。
- 同一个文件再次双击会复用 webview，不重新解析。

> 想用普通文本编辑器看 .dxf 原文：在 Explorer 里 **Reopen With…** 选 `Text Editor` 即可。`.dwg` 是二进制，没有这个回退。

---

## 2. 鼠标 / 触控板操作

| 想做的事 | 鼠标操作 | trackpad 操作 |
|---|---|---|
| **缩放**（zoom） | 滚轮上下 | 双指上下 |
| **平移**（pan） | **右键拖动** ✅ 或 中键拖动 | **双指轻按 + 拖动**（系统右键）|
| **单选实体** | 左键点击 | 单指点击 |
| **框选实体（窗口）** | 左键 → 从左往右拖 | 单指 → 从左往右拖 |
| **穿越选择**（crossing） | 左键 → 从右往左拖 | 单指 → 从右往左拖 |
| **加选** | Cmd / Ctrl + 点击 | 同 |
| **取消单个** | Shift + 点击 | 同 |
| **清空选区** | Esc | Esc |

> 如果你只剩左键能用（笔记本第三方蓝牙鼠标常见情况），点 toolbar 的「**选择模式 / 平移模式**」按钮切到平移模式后，**左键拖动 = 平移**；切回去就重新是选择模式。

> ⚠️ 默认右键不会弹 contextmenu，那是被屏蔽的——webview 内右键拖动专门让出来给 pan。

---

## 3. 工具栏按钮

工具栏在画布顶部，从左到右：

| 按钮 | 行为 |
|---|---|
| 文件名 | 当前打开的文件名（仅展示） |
| **选择模式 / 平移模式** | 切换左键行为。当前模式高亮显示。 |
| ⤢ **回到全图**（Zoom Fit） | 缩放到包住所有可见实体的视图。 |
| **图层** | 打开右侧图层面板，勾选 / 取消勾选可冻结对应图层。 |
| **AI 审图**（蓝色） | 把当前图发到右侧"任务对话"，自动调用 `/v1/chat` 进行结构化审图。需要 viewer 已经把文件解析为 DXF 文本（DWG 会自动经 LibreDWG 转换）。 |

---

## 4. AI 审图

两条触发路径，**任选其一**：

### 4.1 从 viewer 触发

1. 在 viewer 工具栏点「**AI 审图**」
2. 右侧任务对话面板自动出现一条"用户消息 + assistant 回复"，标签为 `viewer: <filename>`
3. 默认 prompt：「请审一下当前 CAD 图（XXX），用通用方法逐项检查。」
4. 这条路径**不要求磁盘上有同名 .dxf**——viewer 内拿到的 DXF 文本直接走 IPC 上传。

### 4.2 从聊天触发

在右侧"任务对话"输入框打：

```
审一下 drawings/floor1.dxf
```

后端会从 workspace 里 lookup 同名 .dxf 文件再走 ezdxf 摘要——这条路径**只支持磁盘上的 .dxf**（v0.1 行为，向后兼容）。`.dwg` 文件想要审图必须走 4.1。

### 4.3 看回复

- assistant 回复是结构化的（图层 / 实体计数 / 文本块 / 标注 / 块定义 / 建议）。
- 标题"viewer: XXX"是来源标签，便于你区分同一个文件的多次审图。

---

## 5. 字体支持

### 5.1 字体引擎概览

`cad-simple-viewer` 自带 SHX 解析器（基于 `@mlightcad/shx-parser`），并支持三种字体格式：

| 类型 | 含义 | 性能 |
|---|---|---|
| `shx` | AutoCAD 原生 SHX 二进制，运行时解析为矢量路径 | 中等 |
| `mesh` | 预处理过的 WOFF Web 字体（mlightcad 自己烘焙） | **快** |
| `ttf` | 标准 TTF / OTF | 快 |

WFM Studio 本地 vendor 了 mlightcad 官方 [`cad-data`](https://gitlab.com/mlightcad/cad-data) 仓库的全套字体（约 29 MB，88 个文件），打开任何 dwg/dxf 文件 **不会**再去外网拉字体，离线也 100% 可用。

### 5.2 字体覆盖范围

vendor 的字体集合包括但不限于：

| 类别 | 字体清单（部分） |
|---|---|
| **西文 SHX** | `txt`, `simplex`, `complex`, `italic`, `monotxt`, `romans`, `romant`, `romand`, `romanc`, `gothice/g/i`, `isocp/2/3`, `isoct/2/3`, `scriptc`, `scripts`, `times`, `bold` |
| **中文 SHX** | `hztxt` (gbk), `gbcbig` (gbk), `gbenor`, `gbeitc`, `chineset` (big5), `zjdz` (gbk) |
| **韩文 SHX** | `whgdtxt`, `whgtxt`, `whtgtxt`, `whtmtxt` (euc-kr) |
| **日文 SHX** | `extfont`, `extfont2`, `bigfont` (shift-jis) |
| **工程符号 SHX** | `syastro`, `symap`, `symath`, `symeteo`, `symusic`, `special` |
| **西文 mesh** | `arial`, `tahoma`, `verdana` |
| **中文 mesh** | `simhei` (黑体), `simsun` (宋体), `simkai` (楷体), `SJQY` |
| **TTF** | `gdt` (几何尺寸符号) |

完整清单见 `wfm-ide/src/vs/workbench/contrib/wfm/cadReview/browser/media/fonts/fonts.json`。

### 5.3 字体别名（fallback）

部分图纸引用了不在官方字体库里的字体（典型如 `swissl.shx`、`hzdx.shx` 等设计院/天正自定义字体）。WFM Studio 在 `fonts.json` 里给这类字体配置了 alias，自动 fallback 到视觉最接近的内置字体：

| 原引用 | 走的字体 | 备注 |
|---|---|---|
| `swissl` | `arial.woff` | 西文细体，找 mesh 字体最接近 |
| `hzdx`、`hzfs`、`hzst`、`hzhei`、`hzkt`、`tssdeng`、`hztxtb`、`hzcjk`、`tssd` | `simhei.woff` | 中文/结构常用别名统一到黑体 mesh |
| 其他**未列入** fonts.json 的字体 | 走 viewer 内部默认 fallback（一般是 simhei） | 视觉肯定有差异，但**至少看得见** |

需要新增 alias 时编辑 `media/fonts/fonts.json`：

```json
{
  "file": "simhei.woff",
  "name": ["simhei", "黑体", "你的图字体名"],
  "type": "mesh"
}
```

### 5.4 仍然有缺失字体的提示？

如果右下角仍然弹出**黄色常驻通知**（形如「未识别字体 …（已用内置 fallback 渲染…）」），说明 cad-simple-viewer 在加载时触发了 `fonts-not-found` / `fonts-not-loaded`：该字体名既不在当前 `fonts.json` 映射里，也未落到可用的 `.shx`/`.woff`/`.ttf` 文件上。处理方式：

1. **临时绕过**：用桌面 CAD 软件把 dwg 里该 textstyle 的 `fileName` 改成已支持的字体（如 `simhei`），另存后再打开。
2. **永久解决**：把字体文件放进 `wfm-ide/.../media/fonts/`，编辑同目录 `fonts.json` 增加 `type: "shx"` / `"mesh"` / `"ttf"` 条目或把别名写进已有字体的 `name` 数组，**重启 IDE**。
3. **手头有原版 SHX**：直接放入 `media/fonts/`，并在 `fonts.json` 增加 `{"file":"xxx.shx","name":["xxx"],"type":"shx"}`（必要时加 `encoding` 字段，格式与 upstream [fonts.json](https://mlightcad.gitlab.io/cad-data/fonts/fonts.json) 一致）。
4. **走 AI 审图**：后端 `ezdxf` 摘要**不依赖 WebGL 字体**，文字实体仍可参与审图。

### 5.5 外部位图 / xref 不加载

`IMAGE` 实体引用的外部位图、外部参照（xref）默认不加载，也会在 toast 里报数量。这是设计如此，v0.2 不在范围。

### 5.6 Hatch 渲染

简单 hatch 支持；复杂自定义 hatch 可能渲染不完整或被简化（控制台会有 `Failed to convert hatch boundaries!` 日志，可忽略）。

### 5.7 旋转

2D viewer，**不支持视角旋转**——图纸固定从 +Z 看下去。这是设计如此，不是 bug。

---

## 6. 故障排查

### 6.1 黑屏 / 加载失败

打开 webview 的 DevTools（在画布上 **右键** 不行，因为我们屏蔽了；改用 **菜单 > 帮助 > 切换开发人员工具**，或快捷键 `Cmd+Opt+I`）查看 console。

常见 console 错误：

| 错误关键字 | 含义 | 处置 |
|---|---|---|
| `WfmCadBootstrap 未就绪` | vendor 的 `cad-viewer.iife.js` 没成功加载 | 在 `wfm-ide/` 跑 `node scripts/build-cad-viewer.mjs`，重启 IDE |
| `Failed to construct 'Worker'` | worker 跨域 | 已通过 blob URL fix，若仍出现请回 `viewer.js` 看 `rewriteWorkersToBlob` |
| `Database converter for file type 'DWG' isn't registered` | LibreDWG converter 没注册 | 同上：rebuild iife |
| `Evaluating a string as JavaScript violates Content Security Policy` | CSP 太紧 | `cadViewerEditor.ts` 里的 CSP 已含 `'unsafe-eval' blob:`，确认没人改回去 |

### 6.2 文件能解析但渲染不全

优先看右下角 toast（§5.4）：若列出字体名，按上文补 `fonts.json` 或 alias；若只提示外部位图/xref 数量，属于 §5.5 已知限制。少数情况是 Hatch / 自定义实体（§5.6）或 LibreDWG 对部分实体支持不完整。

### 6.3 viewer 把"AI 审图"按钮变灰

意味着 DXF 文本还没准备好：
- 如果是 `.dwg`，等 LibreDWG 解析（取决于文件大小 / 实体量，几秒到几十秒）。
- 一直灰，可能 LibreDWG 静默失败——重启该 tab，或者用桌面 CAD 软件先导出成 `.dxf` 再载入。

### 6.4 重启 viewer

关闭 CAD tab → 在 Explorer 重新双击文件即可。如果"操作提示浮层"已被关闭后想再看一次，**重启 IDE 窗口**会清掉 webview 的 state 并重新弹出。

---

## 7. 涉及的依赖（信息记录用）

| 包 | 用途 | License |
|---|---|---|
| `@mlightcad/cad-simple-viewer` | viewer 主引擎 | MIT |
| `@mlightcad/data-model` | DXF / DWG 数据模型 | MIT |
| `@mlightcad/libredwg-converter` | DWG → 内部模型 converter | GPL-3.0 |
| `@mlightcad/libredwg-web` | LibreDWG WASM | GPL-3.0 |
| `cad-data`（vendor 于 `media/fonts/`） | 离线字体清单与二进制（SHX / mesh / TTF） | 见 [upstream 仓库](https://gitlab.com/mlightcad/cad-data) |
| `three` | WebGL renderer | MIT |
| `ezdxf` (后端 wfm-agents) | DXF 摘要 | MIT |

GPL-3.0 viral 不构成项目障碍（项目本来就完全开源），见 [.cursor/rules/project-license.mdc](../.cursor/rules/project-license.mdc)。

---

## 8. 反馈

遇到 viewer 行为异常或新增需求：

- 优先把 webview console 日志（带 `[wfm-cad-viewer]` 前缀）粘到 issue 里
- 同时附上 toast 里的 missingFontNames（如果有）
- 如果是 viewer 渲染但桌面 CAD 看正常，把文件最小化裁剪后附上
