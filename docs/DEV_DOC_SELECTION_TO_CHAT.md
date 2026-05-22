# Word 选区发送到对话 — 实现方案

> 基于 [ARCH_DOC_SELECTION_TO_CHAT.md](ARCH_DOC_SELECTION_TO_CHAT.md) 架构设计
> 遵循现有代码模式：EditorPane + Webview（参考 htmlPreview / cadReview），跨组件通信通过 IWfmAgentClientService 事件总线

## 1. 需要新增的文件

按照现有 `htmlPreview/` 和 `cadReview/` 的目录规范，新建 `docxViewer/` 子模块：

```
wfm-ide/src/vs/workbench/contrib/wfm/
  docxViewer/
    common/
      docxViewer.ts                          -- 常量：editor ID、文件扩展名、字节限制
    browser/
      docxViewer.contribution.ts             -- 注册 EditorPane + EditorResolver + Explorer 右键菜单
      docxViewerEditor.ts                    -- EditorPane 子类：创建 Webview，加载 docx-preview
      docxViewerEditorInput.ts               -- EditorInput 子类
      docxViewerMessages.ts                  -- Webview ↔ Main 进程消息类型定义
      docxSelectionHelper.ts                 -- 选区 → DocumentReference 转换逻辑
      media/
        docxViewer.css                       -- Webview 内样式（渲染区 + 浮动工具栏）
        docxViewer.js                        -- Webview 内脚本（选区追踪、浮动栏、postMessage）
        docx-preview.min.js                  -- 第三方库（docx-preview），打包进 Webview
```

需要修改的现有文件：

```
wfm-ide/src/vs/workbench/workbench.common.main.ts     -- 导入新 contribution
wfm-ide/src/vs/workbench/contrib/wfm/common/wfmAgentClient.ts          -- 新增接口方法
wfm-ide/src/vs/workbench/contrib/wfm/browser/wfmAgentClientService.ts  -- 实现新方法
wfm-ide/src/vs/workbench/contrib/wfm/browser/wfmChatViewPane.ts        -- 接收文档引用 + 渲染卡片
wfm-ide/src/vs/workbench/contrib/wfm/browser/media/wfmChat.css         -- 引用卡片样式
```

---

## 2. 实现步骤

### Step 1：常量与消息类型定义

**`common/docxViewer.ts`**

定义 EditorPane ID（如 `'wfm.docxViewer'`）、支持的扩展名（`.docx`）、文件大小上限。

**`browser/docxViewerMessages.ts`**

定义双向消息类型，遵循 htmlPreviewMessages.ts 的模式：

```typescript
// Main → Webview
interface DocxMainToWebviewMessage {
  type: 'load';            // 加载文档内容（传入 base64 或 ArrayBuffer）
  content: string;         // docx 文件的 base64 编码
  fileName: string;
}

// Webview → Main
interface DocxWebviewToMainMessage {
  type: 'ready';                                                              // Webview 加载完成
} | {
  type: 'selectionToChat';                                                    // 用户点击浮动栏发送
  payload: {
    startPara: number;
    endPara: number;
    selectedText: string;
  };
}
```

---

### Step 2：EditorInput

**`browser/docxViewerEditorInput.ts`**

- 继承 `EditorInput`，标记 `Readonly` 能力
- 持有 `resource: URI`（docx 文件路径）
- 参照 `htmlPreviewEditorInput.ts` 实现，基本照搬结构

---

### Step 3：EditorPane + Webview 渲染

**`browser/docxViewerEditor.ts`**

核心类 `DocxViewerEditor extends EditorPane`，参照 `htmlPreviewEditor.ts` 和 `cadViewerEditor.ts` 的模式：

1. **`createEditor()`**：创建 Webview 容器

2. **`setInput(input)`**：
   - 通过 `IFileService.readFile(input.resource)` 读取 docx 二进制内容
   - 转为 base64，通过 postMessage 发送给 Webview

3. **Webview HTML 模板**：
   ```html
   <html>
   <head>
     <script src="docx-preview.min.js"></script>
     <link rel="stylesheet" href="docxViewer.css">
   </head>
   <body>
     <div id="docx-container"></div>
     <div id="selection-toolbar" class="hidden">
       <button id="send-to-chat">发送到对话</button>
     </div>
     <script src="docxViewer.js"></script>
   </body>
   </html>
   ```

4. **消息监听**：注册 Webview 的 `onDidReceiveMessage`，处理 `selectionToChat` 事件

5. **段落跳转方法**（第二期）：`revealParagraph(index: number)` — 通过 Webview postMessage 让 JS 滚动到指定段落

---

### Step 4：Webview 内脚本（选区追踪 + 浮动工具栏）

**`browser/media/docxViewer.js`**

这是用户交互的核心，运行在 Webview 内：

```
流程：
1. 收到 load 消息 → 用 docx-preview 渲染到 #docx-container
2. 渲染完成后 → 遍历所有段落元素，注入 data-para-index
3. 监听 mouseup + selectionchange → 检测是否有文字选中
4. 有选区 → 计算浮动栏位置 → 显示「发送到对话」按钮
5. 无选区 / 点击空白 → 隐藏浮动栏
6. 用户点击「发送到对话」→ 构造 payload → postMessage 给 Main
```

关键逻辑：

```javascript
// 段落索引注入
function injectParagraphIndices() {
  const container = document.getElementById('docx-container');
  let paraIndex = 0;
  // docx-preview 渲染出的段落元素需要实际调试确认选择器
  const paragraphs = container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
  paragraphs.forEach(p => {
    p.setAttribute('data-para-index', String(paraIndex++));
  });
}

// 选区解析
function resolveSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;

  const anchor = findParaIndex(sel.anchorNode);
  const focus = findParaIndex(sel.focusNode);
  if (anchor === null || focus === null) return null;

  const startPara = Math.min(anchor, focus);
  const endPara = Math.max(anchor, focus);

  return {
    startPara,
    endPara,
    selectedText: sel.toString()
  };
}

// 向上查找 data-para-index
function findParaIndex(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el) {
    const idx = el.getAttribute('data-para-index');
    if (idx !== null) return parseInt(idx, 10);
    el = el.parentElement;
  }
  return null;
}

// 浮动栏定位
function positionToolbar(sel) {
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const toolbar = document.getElementById('selection-toolbar');
  toolbar.style.top = (rect.top - 40 + window.scrollY) + 'px';
  toolbar.style.left = (rect.left + rect.width / 2) + 'px';
  toolbar.classList.remove('hidden');
}
```

---

### Step 5：选区转换服务

**`browser/docxSelectionHelper.ts`**

将 Webview 传来的原始选区数据包装为完整的 `DocumentReference`：

```typescript
export interface DocumentReference {
  fileName: string;
  filePath: string;         // 文件 URI
  startPara: number;
  endPara: number;
  selectedText: string;
  displayLabel: string;     // "审图规范.docx · 第3-5段"
}

export function createDocumentReference(
  fileName: string,
  filePath: string,
  payload: { startPara: number; endPara: number; selectedText: string }
): DocumentReference {
  const range = payload.startPara === payload.endPara
    ? `第${payload.startPara + 1}段`
    : `第${payload.startPara + 1}-${payload.endPara + 1}段`;

  return {
    fileName,
    filePath,
    startPara: payload.startPara,
    endPara: payload.endPara,
    selectedText: payload.selectedText,
    displayLabel: `${fileName} · ${range}`,
  };
}
```

---

### Step 6：AgentClient 接口扩展

**修改 `common/wfmAgentClient.ts`**

新增接口定义：

```typescript
// 新增：文档引用事件
export interface IWfmDocSelectionAttach {
  fileName: string;
  filePath: string;
  startPara: number;
  endPara: number;
  selectedText: string;
  displayLabel: string;
}

// IWfmAgentClientService 接口新增：
attachDocSelection(ref: IWfmDocSelectionAttach): void;
readonly onExternalDocSelectionAttach: Event<IWfmDocSelectionAttach>;
```

**修改 `browser/wfmAgentClientService.ts`**

实现新方法，模式与现有 `attachFiles()` 完全一致：

```typescript
// 新增 Emitter
private readonly _onExternalDocSelectionAttach = new Emitter<IWfmDocSelectionAttach>();
readonly onExternalDocSelectionAttach = this._onExternalDocSelectionAttach.event;

attachDocSelection(ref: IWfmDocSelectionAttach): void {
  // 先确保 Chat 面板可见
  this.viewsService.openView(WFM_CHAT_VIEW_ID, true);
  // 触发事件，WfmChatViewPane 监听处理
  this._onExternalDocSelectionAttach.fire(ref);
}
```

---

### Step 7：Chat 面板接收与渲染

**修改 `browser/wfmChatViewPane.ts`**

1. **构造函数中订阅事件**：
   ```typescript
   this._register(agentClient.onExternalDocSelectionAttach(ref => {
     this.addDocSelectionAttachment(ref);
   }));
   ```

2. **新增 `addDocSelectionAttachment(ref)` 方法**：
   - 在 `attachmentsEl` 中插入一个文档引用卡片 DOM 节点
   - 卡片内容：文件图标 + `ref.displayLabel` + 文字预览（截取前 80 字，可展开）
   - 卡片右侧有 × 按钮可移除

3. **发送时携带引用**：
   - `onSend()` 收集当前 attachments 中所有 `DocumentReference`
   - 传入 `runChat()` → `agentClient.chatStream()` 的请求体
   - 后端 Agent 收到后可读取文件对应段落的内容

4. **消息气泡中渲染引用**：
   - 用户消息气泡顶部显示引用卡片（只读），下方显示用户输入的文字

---

### Step 8：注册与集成

**`browser/docxViewer.contribution.ts`**

参照 `htmlPreview.contribution.ts`，注册：

1. `DocxViewerEditor` 为 EditorPane
2. `DocxViewerEditorContribution` 注册 `.docx` 文件关联（`RegisteredEditorPriority.option`，双击默认用文本编辑器，右键可预览）
3. `DocxViewerEditorInputSerializer` 用于编辑器状态持久化
4. （可选）Explorer 右键「预览 Word 文档」Action

**修改 `workbench.common.main.ts`**

新增一行导入：
```typescript
import './contrib/wfm/browser/docxViewer.contribution.js';
```

---

## 3. CSS 样式

**`browser/media/docxViewer.css`**（Webview 内样式）

```css
/* 文档渲染区 */
#docx-container {
  padding: 20px 40px;
  background: white;
  box-shadow: 0 1px 4px rgba(0,0,0,0.1);
  margin: 16px auto;
  max-width: 800px;
  min-height: 100%;
}

/* 浮动工具栏 */
#selection-toolbar {
  position: absolute;
  transform: translateX(-50%);
  z-index: 1000;
  background: var(--toolbar-bg);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  padding: 4px;
  transition: opacity 0.15s;
}
#selection-toolbar.hidden { display: none; }
#selection-toolbar button {
  padding: 4px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
```

**`wfmChat.css` 新增**（Chat 面板内引用卡片样式）

```css
.wfm-chat-doc-ref {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  background: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 6px;
  border-left: 3px solid var(--vscode-textLink-foreground);
  margin-bottom: 6px;
  cursor: pointer;
}
.wfm-chat-doc-ref-label {
  font-size: 12px;
  color: var(--vscode-textLink-foreground);
  font-weight: 600;
}
.wfm-chat-doc-ref-preview {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  max-height: 60px;
  overflow: hidden;
}
```

---

## 4. 依赖项

| 依赖 | 用途 | 大小 |
|------|------|------|
| [docx-preview](https://github.com/VolodymyrBayworker/docxjs) | 在 Webview 中渲染 .docx | ~500KB (min) |

> docx-preview 是纯前端库，无需服务端，打包进 Webview 的 `localResourceRoots` 即可。

---

## 5. 实施顺序与预估

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **P1** | docxViewer EditorPane 骨架 + docx-preview 渲染 | 无 |
| **P2** | Webview 内选区追踪 + 浮动工具栏 | P1 |
| **P3** | AgentClient 接口扩展 + Chat 引用卡片渲染 | P2 |
| **P4** | 端到端联调：选区 → Chat → Agent 回复 | P3 |
| **P5（第二期）** | 标题层级解析、段落跳转、表格单元格粒度 | P4 |

---

## 6. 与现有代码的关系

| 现有模块 | 关系 |
|----------|------|
| `htmlPreview/` | 参考其 EditorPane + Webview 模式，照搬目录结构 |
| `cadReview/` | 参考其 Explorer 右键 → Agent 交互流程 |
| `wfmAgentClientService` | 新增 `attachDocSelection` 方法和事件，复用现有跨组件事件总线 |
| `wfmChatViewPane` | 新增文档引用卡片的接收和渲染逻辑 |
| `wfmChat.css` | 新增引用卡片样式 |
