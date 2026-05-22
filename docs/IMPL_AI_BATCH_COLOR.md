# 实现文档：AI 批量修改实体颜色

> 目标格式：DXF
>
> **本功能是通用的**——用户可以用自然语言指定任意识别条件和目标颜色，例如：
> - "把所有 SOUND 标记标红"
> - "把灯泡统一标红"
> - "把 PIPE 层全部改成黄色"
> - "把所有尺寸标注改成蓝色"
>
> AI 自行决定用哪些工具（文本提取、块提取、图层检查等）来识别目标实体，
> 最终输出 `handle → color` 映射，前端按映射批量修改。
> SOUND 标红只是本次验证用的具体 case。

## 一、总体流程

```
┌──────────────┐      ┌───────────────────┐      ┌──────────────┐
│  WFM Chat    │      │  wfm-agents       │      │  CAD Viewer  │
│  (用户输入)   │─────▶│  (AI + 工具)       │─────▶│  (前端渲染)   │
└──────────────┘      └───────────────────┘      └──────────────┘

步骤：
1. 用户在 Chat 中用自然语言描述需求（如 "把所有 SOUND 标记标红"）
2. Agent 调用已有工具分析 DXF，自行决定识别策略来定位目标实体
3. Agent 调用【新增工具】cad_modify_colors 生成修改指令
4. Agent 返回结构化指令（handle → color 映射）
5. Chat 面板通过 AgentClient 将指令转发给 CAD Viewer
6. Viewer 按指令批量修改实体颜色，渲染更新
7. Viewer 序列化 DXF 并通知 main 端保存
```

## 二、改动范围

| 层 | 文件 | 改动内容 |
|---|---|---|
| **wfm-agents** | `cad/tools.py` | 新增 `cad_modify_colors` 工具 |
| **wfm-agents** | `cad/parser.py` | 新增 DXF 实体颜色修改函数 |
| **wfm-agents** | `routes/chat.py` | SSE 事件中新增 `cad_edit` 类型 |
| **wfm-ide** | `common/wfmAgentClient.ts` | 回调接口新增 `onCadEdit` |
| **wfm-ide** | `cadReview/browser/cadViewerMessages.ts` | 新增 IPC 消息类型 |
| **wfm-ide** | `cadReview/browser/cadViewerEditor.ts` | 新增消息处理 + 文件保存 |
| **wfm-ide** | `cadReview/browser/media/viewer.js` | 新增实体颜色修改 + DXF 导出逻辑 |

## 三、后端改动（wfm-agents）

### 3.1 新增工具：`cad_modify_colors`

在 `wfm-agents/wfm_agents/cad/tools.py` 中新增：

```python
@function_tool
def cad_modify_colors(
    ctx: RunContextWrapper,
    path: str,
    instructions: list[dict],
) -> str:
    """
    批量修改 DXF 文件中指定实体的颜色。
    instructions 是一个 JSON 数组，每项包含：
      - handle: 实体的 DXF handle（十六进制字符串）
      - color: 目标颜色（ACI 颜色索引号，如 1=红, 2=黄, 3=绿, 5=蓝）
    修改后返回确认信息。
    """
```

**为什么用 ACI 颜色索引**：mlightcad 的 `AcCmColor` 内部用 ACI（AutoCAD Color Index），DXF 的 group code 62 也是 ACI。用索引号在 Agent → 前端传输最简单，无需 RGB 转换。常见值：1=红, 2=黄, 3=绿, 4=青, 5=蓝, 6=品红, 7=白/黑。

**为什么让后端改文件而不是只返回指令让前端改**：

两条路径都可行，但后端改更稳妥：
- ezdxf 修改后直接得到新的 DXF 文本，前端只需替换渲染
- 前端 mlightcad 的 `updateEntity()` API 虽然存在，但颜色属性修改的具体 API 位置需要额外探索
- 后端改完返回 `diff` 给前端，前端做一次 `loadDocument` 刷新即可

**实际决策：后端返回修改指令，前端执行。** 原因：
1. 前端已有完整的 DXF 加载 + 渲染链路
2. 避免前端重新解析整个文件（大 DXF 解析慢）
3. 前端可以逐个 `updateEntity()` 实现增量更新
4. 保存时用 `dxfOut()` 导出的是前端当前状态，天然包含修改

### 3.2 Agent 调用链

Agent 根据用户意图自主选择识别策略，以下列举几种典型场景：

**场景 A — 按文本内容匹配**（如 "把所有 SOUND 标记标红"）
```
Router Agent → handoff → CAD Review Agent
  │
  ├─ cad_extract_texts(path) → 找到所有含 "SOUND" 的 TEXT/MTEXT
  │  返回：[{handle: "1A3F", text: "NO.2C/H AFT.B.W.(P) SOUND", layer: "TEXT"}, ...]
  │
  ├─ cad_extract_blocks(path) → 找到名字含 "SOUND" 的块参照
  │  返回：[{name: "SOUND_SYMBOL", handle: "2B5C", instances: [...]}]
  │
  ▼
Agent 综合识别结果，输出修改指令：
  [{handle: "1A3F", color: 1}, {handle: "1A42", color: 1}, ...]
```

**场景 B — 按图层匹配**（如 "把 PIPE 层全部改成黄色"）
```
CAD Review Agent
  │
  ├─ cad_layer_inspect(path, layer="PIPE") → 获取 PIPE 层所有实体及其 handle
  │
  ▼
Agent 输出修改指令：
  [{handle: "3A01", color: 2}, {handle: "3A02", color: 2}, ...]
```

**场景 C — 按语义匹配**（如 "把灯泡统一标红"）
```
CAD Review Agent
  │
  ├─ cad_extract_blocks(path) → 查找块名含 LAMP/LIGHT 的块参照
  ├─ cad_extract_texts(path) → 查找含 "灯泡"/"LAMP" 的文本
  ├─ cad_layer_inspect(path, layer="LIGHT") → 查找 LIGHT 层实体
  │
  ▼
Agent 综合多维度结果，输出修改指令
```

所有场景最终产出的都是同一种结构：`handle → color` 映射。
识别策略完全由 AI 决定，不限于以上三种——只要工具能提取 handle，就能修改颜色。

### 3.3 SSE 事件格式

在现有 SSE 流中新增 `cad_edit` 事件类型：

```python
# 在 chat.py 的 stream_events 生成器中
yield {
    "type": "cad_edit",
    "data": {
        "source_uri": "file:///path/to/drawing.dxf",
        "modifications": [
            {"handle": "1A3F", "property": "color", "value": 1},
            {"handle": "1A42", "property": "color", "value": 1},
            # ...
        ],
        "summary": "已将 5 个实体的颜色修改为红色 (ACI 1)"
    }
}
```

`source_uri` 用于 main 端关联到正确的 CAD Viewer 实例（用户可能同时打开多个 DXF）。

## 四、前端改动（wfm-ide）

### 4.1 IPC 消息类型扩展

在 `cadViewerMessages.ts` 中新增：

**main → webview**：

```typescript
/** main 端下发 AI 修改指令，webview 执行颜色变更 */
export interface ICadApplyEditsMessage {
    readonly kind: 'applyEdits';
    /** 修改指令列表 */
    readonly modifications: ReadonlyArray<{
        readonly handle: string;
        readonly property: 'color';
        readonly value: number;  // ACI 颜色索引
    }>;
    /** 修改完成后是否自动保存 */
    readonly autoSave: boolean;
}
```

**webview → main**：

```typescript
/** webview 完成 AI 修改指令后的确认 */
export interface ICadEditsAppliedMessage {
    readonly kind: 'editsApplied';
    readonly count: number;
    readonly failed: number;
    /** 修改后的完整 DXF 文本（如果 autoSave=true） */
    readonly dxfText?: string;
    readonly sourceUri: string;
}
```

### 4.2 viewer.js 新增逻辑

#### 4.2.1 颜色修改函数

```javascript
/**
 * 按 handle 修改实体颜色。
 * 遍历 modelSpace 的 entities，匹配 handle 后修改 color 属性，
 * 再调用 view.updateEntity() 刷新渲染。
 */
function applyColorModifications(modifications) {
    const view = docManager?.curView;
    const db = docManager?.curDocument?.database;
    if (!view || !db) {
        return { applied: 0, failed: modifications.length };
    }

    // 构建 handle → color 的查找表
    const colorMap = new Map();
    for (const mod of modifications) {
        colorMap.set(mod.handle, mod.value);
    }

    let applied = 0;
    let failed = 0;

    // 遍历 modelSpace 实体
    const entities = db.tables.blockTable.modelSpace.entities;
    for (const entity of entities) {
        const handle = entity.objectId?.handle || entity.handle;
        if (handle && colorMap.has(handle)) {
            try {
                const aciColor = colorMap.get(handle);
                entity.color = new AcCmColor(aciColor);
                view.updateEntity(entity);
                applied++;
            } catch (err) {
                console.warn(LOG_PREFIX, 'updateEntity color failed', handle, err);
                failed++;
            }
        }
    }

    return { applied, failed };
}
```

> **注意**：具体的 `entity.color` setter 和 `AcCmColor` 构造方式需要验证。mlightcad 的 API 可能是 `entity.color = aciIndex` 或 `entity.setColor(aciIndex)` 或需要 `new AcCmColor().setACI(index)`。实现时先在浏览器 console 探测确认。

#### 4.2.2 消息分发扩展

在 `window.addEventListener('message', ...)` 的 switch 中新增：

```javascript
case 'applyEdits':
    handleApplyEdits(msg);
    break;
```

```javascript
function handleApplyEdits(msg) {
    const { modifications, autoSave } = msg;
    const result = applyColorModifications(modifications);

    let dxfText;
    if (autoSave) {
        dxfText = tryExportDxfText();
    }

    vscode.postMessage({
        kind: 'editsApplied',
        count: result.applied,
        failed: result.failed,
        dxfText: autoSave ? dxfText : undefined,
        sourceUri: currentDoc?.sourceUri,
    });
}
```

### 4.3 cadViewerEditor.ts 改动

#### 4.3.1 新增消息处理

在 `handleWebviewMessage` 的 switch 中新增：

```typescript
case 'editsApplied':
    this.handleEditsApplied(msg.count, msg.failed, msg.dxfText, msg.sourceUri);
    break;
```

```typescript
private async handleEditsApplied(
    count: number,
    failed: number,
    dxfText: string | undefined,
    sourceUri: string | undefined,
): Promise<void> {
    if (count > 0) {
        this.notificationService.notify({
            severity: Severity.Info,
            message: localize(
                'wfm.cad.viewer.editsApplied',
                "已修改 {0} 个实体的颜色{1}",
                count,
                failed > 0 ? `（${failed} 个失败）` : '',
            ),
        });
    }

    if (dxfText && sourceUri) {
        await this.saveDxfToFile(dxfText, sourceUri);
    }
}
```

#### 4.3.2 DXF 保存函数

```typescript
private async saveDxfToFile(dxfText: string, sourceUri: string): Promise<void> {
    try {
        const uri = URI.parse(sourceUri);
        const encoded = new TextEncoder().encode(dxfText);
        await this.fileService.writeFile(uri, VSBuffer.wrap(encoded));
        this.logService.info(`${LOG_PREFIX} DXF saved: ${sourceUri}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.notificationService.notify({
            severity: Severity.Error,
            message: localize(
                'wfm.cad.viewer.saveFailed',
                "保存 DXF 文件失败: {0}",
                message,
            ),
        });
    }
}
```

### 4.4 AgentClient 改动

在 `IWfmStreamCallbacks` 中新增：

```typescript
onCadEdit?(data: {
    sourceUri: string;
    modifications: Array<{ handle: string; property: string; value: number }>;
    summary: string;
}): void;
```

在 `WfmAgentClientService` 的 SSE 处理逻辑中，当收到 `type: 'cad_edit'` 事件时：
1. 调用 `callbacks.onCadEdit(data)`
2. `WfmChatViewPane` 收到后查找当前活跃的 `CadViewerEditor`
3. 通过 `webview.postMessage({ kind: 'applyEdits', ... })` 下发指令

### 4.5 关联路径：Chat → Viewer

这是最关键的一步——把 Agent 返回的修改指令路由到正确的 Viewer 实例。

```
WfmChatViewPane
  │ 收到 onCadEdit 回调
  │ data.sourceUri = "file:///path/to/drawing.dxf"
  ▼
查找当前 editor group 中打开的 CadViewerEditor
  │ 比较 editor.currentResourceUri === data.sourceUri
  ▼
editor.webview.postMessage({
    kind: 'applyEdits',
    modifications: [...],
    autoSave: true,
})
```

如果对应的 Viewer 没有打开（用户关闭了），则通知用户"请先打开对应的 CAD 文件"。

## 五、验证步骤

### 5.1 准备

1. 准备一份船舶 EID 图纸（DXF 格式），包含多种可识别的标记（如 SOUND、灯泡符号等）
2. 启动 wfm-agents 后端
3. 启动 wfm-ide，打开该 DXF 文件

### 5.2 测试 case

| # | 用户输入 | 预期识别方式 | 预期结果 |
|---|---|---|---|
| A | "把所有 SOUND 标记标红" | 文本内容 + 块名匹配 | 所有含 SOUND 的文本/块参照变红 |
| B | "把 PIPE 层全部改成黄色" | 按图层名匹配 | PIPE 层所有实体变黄 |
| C | "把灯泡统一标红" | 块名 + 文本 + 语义综合 | 灯泡相关实体变红 |

先跑通 case A 作为基线，再扩展 B、C。

### 5.3 验证标准

- [ ] Agent 自主选择合适的识别工具组合
- [ ] 修改指令中 handle 正确（对应到预期的实体）
- [ ] Viewer 中目标实体颜色实时变更
- [ ] 保存后的 DXF 用外部工具打开，颜色仍是目标值
- [ ] 未被指定的实体不受影响

## 六、风险与待确认项

| 项 | 风险等级 | 说明 |
|---|---|---|
| `entity.color` setter API | **中** | mlightcad 未在 d.ts 中明确暴露 color setter，需在浏览器 console 中探测 |
| `AcCmColor` 构造方式 | **中** | 可能需要 `setACI(index)` 而非直接构造函数传参 |
| `view.updateEntity()` 对颜色的支持 | **中** | 该 API 确认能更新颜色渲染（而非仅几何变更） |
| handle 匹配方式 | **低** | ezdxf 的 handle 与 mlightcad 解析后的 handle 是否一致 |
| 大图纸性能 | **低** | 遍历 modelSpace 实体列表在大图（>10万实体）时可能有延迟，但只在修改时触发一次 |
| DXF 保存后重新打开 | **低** | `dxfOut()` 导出后再解析，颜色属性是否完整保留 |

## 七、工作量估算

| 任务 | 估计时间 |
|---|---|
| 后端：新增 `cad_modify_colors` 工具 | 0.5 天 |
| 后端：SSE 事件中新增 `cad_edit` 类型 | 0.5 天 |
| 前端：IPC 消息类型 + viewer.js 颜色修改 | 1 天 |
| 前端：cadViewerEditor 保存 + AgentClient 路由 | 1 天 |
| 联调测试 | 1 天 |
| **合计** | **4 天** |
