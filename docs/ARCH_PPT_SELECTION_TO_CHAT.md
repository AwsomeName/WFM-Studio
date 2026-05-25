# PPT 选区发送到对话 — 架构设计

> 状态：已实现（v1）| 关联：`ARCH_DOC_SELECTION_TO_CHAT.md`（Word 版同构）、`ARCH_PPT_EDITOR.md`（远期 PPTist 精细编辑器）

## 1. 需求

在 WFM Studio 中打开 .pptx 文件后，用户可以：

- **拖选某个文本框里的文字** → 浮动栏「发送到对话」 / 右键「发送选中到对话」
- **右键点击形状本体（不选文字）** → 同上，引用整个形状
- **右键点击 slide 空白区** → 引用整页

引用以"结构化定位"形式出现在 Chat 输入框，Agent 收到能定位到具体 slide/shape/run。

交互对标 docxViewer "Word 选区送对话"，但 PPT 的"位置"是二维的（页 + 形状），且文本框内还有 run 粒度。

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│  .pptx 文件 (CustomEditorProvider + Webview)              │
│  ┌────────────────────────────────────────────────────┐  │
│  │  @aiden0z/pptx-renderer 渲染原生外观                │  │
│  │  渲染完成后 walk DOM + 比对 serializePresentation() │  │
│  │  注入：                                              │  │
│  │    data-wfm-slide-index   →  N (0-based)             │  │
│  │    data-wfm-shape-index   →  M (扁平展开 group 后的 │  │
│  │                                model node 索引)      │  │
│  │    data-wfm-shape-name    →  "Title 1" / "TextBox 4" │  │
│  │    data-wfm-shape-id      →  OOXML cNvPr@id          │  │
│  │    data-wfm-run-index     →  K (该形状内 <span> 顺序)│  │
│  │                                                       │  │
│  │  鼠标拖选/右键 → resolveSelection() 解析这些属性    │  │
│  └─────────────────┬──────────────────────────────────┘  │
└────────────────────┼─────────────────────────────────────┘
                     │ postMessage
                     ▼
┌──────────────────────────────────────────────────────────┐
│  EditorPane (PptxViewerEditor)                            │
│  把四维信息编码进 IRange                                   │
│    startLineNumber = slideIdx + 1     （1-based 页码）    │
│    endLineNumber   = slideIdx + 1                         │
│    startColumn     = shapeIdx + 1     （1-based）         │
│    endColumn       = runEnd + 1       （0 表示整选形状）  │
│  调用 widget.attachmentModel.addFile(uri, range)          │
└─────────────────┬─────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────┐
│  wfmClaudeAgent.contribution.ts:_stitchAttachments        │
│  检测 .pptx 扩展名 → 翻译为：                              │
│    [PPT 选区 · 汇报.pptx · 第 3 页 · 形状 #2 · 第 1 个 run]│
│  Agent 看到这条提示后调 `pptx_read` 按 slide 索引回读     │
└──────────────────────────────────────────────────────────┘
```

## 3. 模块清单

### 3.1 新增（全部在 `contrib/wfm/pptxViewer/`，符合 fork policy）

| 文件 | 作用 |
|---|---|
| `common/pptxViewer.ts` | 常量（editor id、扩展名、文件大小上限 80MB） |
| `browser/pptxViewer.contribution.ts` | 注册 EditorPane + EditorResolver（option 优先级）+ Explorer 右键 |
| `browser/pptxViewerEditor.ts` | EditorPane 主类，创建 webview、文件读取、消息桥接、选区→addFile 编码 |
| `browser/pptxViewerEditorInput.ts` | EditorInput 子类 |
| `browser/pptxViewerMessages.ts` | webview↔main 消息类型 |
| `browser/media/pptxViewer.css` | webview 内样式 |
| `browser/media/pptxViewer.js` | webview 内脚本：渲染、注入 data-*、选区/右键解析、浮动栏 |
| `browser/media/pptx-renderer.es.js` | @aiden0z/pptx-renderer 1.0.2 vendored 副本 (Apache-2.0) |
| `browser/media/pptx-renderer.LICENSE` | 上游 license 副本 |

### 3.2 修改（侵入式，已登记 `UPSTREAM_PATCHES.md`）

| 文件 | 改动 |
|---|---|
| `workbench.common.main.ts` | 新增一行 `import './contrib/wfm/pptxViewer/browser/pptxViewer.contribution.js'` |
| `wfmClaudeAgent.contribution.ts` | `_stitchAttachments` 把 `docxNotes` 重命名为通用 `officeNotes`，新增 `.pptx` 分支用 startColumn/endColumn 解码 shape/run |

## 4. 关键技术决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 渲染库 | **@aiden0z/pptx-renderer**（DOM + SVG，Apache-2.0） | DOM 文本可原生 select；452+ 视觉回归 case 保真度高；TypeScript 类型完整 |
| 渲染模式 | `renderMode: 'list'` + `windowed: true` | 大 PPT 不一次性挂载全部，节省内存 |
| 形状识别 | 渲染后 walk DOM × `serializePresentation()` 双匹配（bbox 中心距离） | aiden0z 默认不注入 data-shape-id；用 bbox 匹配比 fork 库源码低维护成本 |
| 选区编码 | 复用 `addFile(uri, range)` 的 `IRange` 四个字段 | 不改 chip 渲染层；现有 `attachmentModel` 流程直接复用，未来要更花哨可以独立 `attachPptSelection` 通道 |
| EditorPriority | `option` | 不抢双击。和现有 omni-viewer 共存，用户右键"使用 … 打开"选 "WFM PPT 预览"才走我们 |
| 视图操作 | 右键菜单 + 浮动栏并存 | 文本拖选弹浮动栏（轻），点形状右键弹菜单（带"第 X 页 · Title 1"提示） |

## 5. 关键风险与已知限制

| 风险 | 影响 | 缓解 |
|---|---|---|
| bbox 中心匹配可能给重叠形状打错标签 | 形状级引用准确率 < 100% | 距离阈值过滤（> max(w,h) 丢弃）；agent 同时拿到 `selectedText` 兜底 |
| master / layout 上的非占位 shape 会被渲染到 slide DOM 内 | 占用 candidates 位置 | 不会和 `model.nodes` 匹配上，自然丢弃 |
| SmartArt 需要 pdfjs-dist 才能渲染 | 复杂 SmartArt 显示红色虚线占位符 | MVP 接受，后续可按需加 pdfjs vendor |
| ES module bundle 2.5MB | 首次加载慢 | webview `retainContextWhenHidden: true`，文件切换不重载 |
| 旧 PPT (.ppt 二进制格式) 不支持 | 用户需先另存为 pptx | 后续可加提示；与 docxViewer 对 .doc 的处理一致 |

## 6. 与 ARCH_PPT_EDITOR.md 的关系

- 本文档（v1）的 pptxViewer 是**只读 + 选区识别**，目标是"send to chat"
- `ARCH_PPT_EDITOR.md` 的 PPTist 编辑器是**可编辑 + AI 双向编辑**，目标是"AI 改稿"
- 两者**互不干扰**：
  - pptxViewer 关联 `.pptx`，priority `option`
  - PPTist 编辑器实施时关联 `.pptx`，priority `default`（双击默认）
  - 当 PPTist 落地后，pptxViewer 仍可作为"快速预览+发送选区"通道存在，类似 VS Code 同时有 image preview 和 hex editor

## 7. 未来扩展（不在 v1 范围）

- chip 显示美化：当前显示成 `汇报.pptx:3:2`，未来通过自定义 chip metadata 显示 `汇报.pptx · 第3页 · 标题`
- 引用点击跳转：点击 chip 自动 reveal 到对应 slide 并高亮 shape
- 多 shape 选区：当前只支持单 shape；跨 shape 拖选时降级到 slide 级
- pdfjs vendor：开启 SmartArt 完整渲染
