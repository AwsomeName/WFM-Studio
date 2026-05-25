# PPT 选区发送到对话 — 开发记录

> 状态：v1 已实现 | 关联：`ARCH_PPT_SELECTION_TO_CHAT.md`

## 怎么用

1. 在 Explorer 里**右键 .pptx 文件** → 选 **"预览 PPT 文档"**（或通过"使用 … 打开" → "WFM PPT 预览"）
2. PPT 在编辑器中渲染（list mode，所有页一列纵向排列，windowed 挂载）
3. 三种触发方式：
   - **拖选文本框里的文字** → 浮动栏「发送到对话」
   - **右键文本/形状** → 上下文菜单（标题显示 `第 3 页 · Title 1 · "项目汇报"`）→ 「发送选中到对话」
   - **右键 slide 空白处** → 引用整页
4. Chat 输入框出现 chip（形如 `汇报.pptx:3:2`）
5. 用户在 chip 下方输入需求："把这个标题润色一下"
6. Agent 收到的 prompt 自动加了一行结构化提示：
   ```
   @汇报.pptx
   [PPT 选区 · 汇报.pptx · 第 3 页 · 形状 #2 · 第 1 个 run（文本片段）]
   
   把这个标题润色一下
   ```
7. Agent 调 `pptx_read`（待实现，见 `IMPL_PPTX_MODULE.md`）按 slide/shape 索引回读原文，调 `pptx_write` 应用修改

## 编码方案

```typescript
// pptxViewerEditor.ts:handleSelectionToChat
const startLineNumber = slideIndex + 1;   // 1-based 页码
const endLineNumber   = slideIndex + 1;
const startColumn     = shapeIndex + 1;    // shape 在该 slide 中的扁平 model index
const endColumn       = runEnd + 1;        // 0 = 整选形状，>0 = 文本选区终点 run index
widget.attachmentModel.addFile(URI.parse(this.currentResource), {
  startLineNumber, startColumn, endLineNumber, endColumn,
});
```

Agent 侧（`wfmClaudeAgent.contribution.ts:_stitchAttachments`）通过文件扩展名识别为 `.pptx`，解码并翻译为人类语义。

## 编译 & 验证

```bash
cd wfm-ide
npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck 2>&1 | grep pptxViewer
# 应输出空，表示无类型错误
```

启动 dev 模式：
```bash
./scripts/code.sh
```

冒烟测试用例（手动）：
1. 任找一份 .pptx，Explorer 右键 → "预览 PPT 文档"
2. 看到 PPT 渲染，鼠标 hover 形状会有蓝色边框
3. 选中标题文字 → 浮动栏出现 → 点"发送到对话" → Chat chip 出现
4. 右键标题（不拖选）→ 菜单显示 `第 1 页 · Title 1`
5. 点击发送 → Chat 出现 chip → 输入"把这个标题改成 'XX 项目年度汇报'" → 确认 prompt 里附加了 `[PPT 选区 …]` 提示

## 已知坑

- **形状识别基于 bbox 中心距离**：极少数情况下重叠形状可能打错标签，可通过点击形状本身（非文本）的右键看 chip 提示是否对得上来验证。
- **SmartArt / 复杂动画**：渲染会变成红色虚线占位符。后续可补 pdfjs-dist。
- **.ppt（旧二进制格式）不支持**：用户需另存为 pptx。
- **大文件 (>80MB)**：直接报错。要打开请提高 `PPTX_VIEWER_BYTE_LIMIT`。

## 依赖

| 依赖 | 版本 | License | 大小 |
|---|---|---|---|
| @aiden0z/pptx-renderer | 1.0.2 | Apache-2.0 | 2.5MB ES |
| └── echarts | ^6 (内嵌) | Apache-2.0 | ~1.4MB |
| └── jszip | ^3.10 (内嵌) | MIT/GPL-3 | 小 |
| pdfjs-dist | （未引入） | Apache-2.0 | - |

库以**源码 vendoring** 形式放在 `contrib/wfm/pptxViewer/browser/media/pptx-renderer.es.js`，便于 webview localResourceRoots 加载，不需要 npm 安装。
