# ARCH_XLSX_TOOLS — Excel 文件读写 MCP 工具

> **状态**：规格（实现前）
> **日期**：2026-05-24
> **分支**：`feat/xlsx-tools`
> **关联**：[ARCH_DOCX_REVIEW.md](ARCH_DOCX_REVIEW.md)（同类工具模式参考）、[`wfm_mcp_server.py`](../wfm-agents/wfm_agents/agent_v2/wfm_mcp_server.py)（MCP 工具注册入口）、[docs/samples/gen_test_data.py](samples/gen_test_data.py)（已有 openpyxl 测试数据生成脚本）

---

## 1. 目标与范围

### 1.1 目标

在 WFM Studio 聊天面板中支持 **Excel 文件（.xlsx）的读取与生成**，补齐 Claude Code 原生工具无法处理二进制 xlsx 格式的缺口。

### 1.2 首期场景

用户说："根据这份报价单帮我做预算表"。

完整链路：

```
1. 用户在聊天面板附加一份 .xlsx 报价单
2. Claude 调用 xlsx_read 解析报价单结构
3. Claude 理解数据后，生成预算表内容
4. Claude 调用 xlsx_write 输出 .xlsx 预算表
5. 用户在工作区打开生成的 Excel 文件
```

### 1.3 在范围内

- .xlsx 文件的读取（多 Sheet、合并单元格、公式值、样式提示）
- .xlsx 文件的生成（多 Sheet、表格、格式化、公式、列宽自适应）
- MCP 工具注册（`xlsx_read`、`xlsx_write`）

### 1.4 不在范围内

- .xls（旧二进制格式）支持
- 图表（Chart）生成
- 条件格式、数据验证、宏（VBA）
- Excel 文件的差异比较
- CSV 处理（已有 `workspace_read` / `workspace_write` 兜底）

---

## 2. 现状分析

### 2.1 各文件格式支持情况

| 格式 | 读取 | 写入 | 实现方式 |
|------|------|------|---------|
| .pdf | Claude Code 内置 Read 工具 | — | 原生支持 |
| .docx | MCP `docx_read` | MCP `docx_write` | python-docx（已引入） |
| .xlsx | **不支持** | **不支持** | Claude Code Read 工具返回 `binary file` 错误 |
| .csv | `workspace_read` | `workspace_write` | 纯文本 |
| .dxf/.dwg | MCP `cad_file_read` 等 | MCP `cad_export_dxf` | ezdxf（已引入） |

### 2.2 为什么需要 MCP 工具而非让 Claude Code 直接处理

Claude Code CLI 的 Read 工具对 .xlsx 文件返回错误：

```
This tool cannot read binary files. The file appears to be a binary .xlsx file.
```

xlsx 是 ZIP 压缩包内含 XML 的二进制格式，必须通过专门的库解析。

---

## 3. 数据流

### 3.1 读取流程（报价单输入）

```
用户附加 .xlsx 文件到聊天
    ↓
_stitchAttachments() → 生成 @报价单.xlsx（kind='file'，通过过滤 ✓）
    ↓
Claude CLI 收到 @报价单.xlsx 引用
    ↓
Claude CLI 自身无法读取，调用 MCP 工具 xlsx_read
    ↓
MCP Server (wfm_mcp_server.py) 执行 xlsx_read
    ↓
xlsx/parser.py 用 openpyxl 解析 → 返回 Markdown 文本
    ↓
Claude 理解报价单内容
```

### 3.2 写入流程（预算表输出）

```
Claude 理解报价单数据，规划预算表结构
    ↓
Claude 调用 MCP 工具 xlsx_write
    ↓
MCP Server 执行 xlsx_write
    ↓
xlsx/writer.py 用 openpyxl 生成 .xlsx 文件
    ↓
返回生成结果（文件路径、Sheet 数、行数等）
    ↓
用户在 IDE 中打开生成的文件
```

---

## 4. 新增依赖

### 4.1 openpyxl

| 项目 | 值 |
|------|-----|
| 包名 | `openpyxl` |
| 版本要求 | `>=3.1` |
| 体积 | ~2 MB |
| 类型 | 纯 Python，无系统级依赖 |
| 许可证 | MIT |
| 用途 | 读写 .xlsx 文件（Workbook / Worksheet / Cell 操作） |
| 能力 | 多 Sheet、合并单元格、公式读写、样式设置（字体/边框/对齐/填充）、数字格式、列宽行高 |

### 4.2 为什么选 openpyxl

| 备选 | 排除原因 |
|------|---------|
| xlrd / xlwt | 只支持旧版 .xls，不支持 .xlsx |
| pandas | 数据分析库，Excel IO 是附带功能；引入连带 numpy 等依赖 >50MB，违反项目"确认后再装大依赖"原则 |
| xlsxwriter | 只能写不能读，且无法修改已有文件 |
| pyexcel | 底层仍依赖 openpyxl，多一层抽象无必要 |

### 4.3 pyproject.toml 变更

```toml
dependencies = [
    "mcp>=1.26.0",
    "ezdxf>=1.3",
    "python-docx>=1.1",
    "build123d>=0.10.0",
    "trimesh>=4.12.2",
    "shapely>=2.0",
    "openpyxl>=3.1",        # ← 新增
]
```

---

## 5. 文件结构

```
wfm-agents/wfm_agents/
├── xlsx/                          # ← 新增模块
│   ├── __init__.py                # 导出 parse_xlsx, format_xlsx_content, write_xlsx_from_markdown
│   ├── parser.py                  # xlsx 读取与结构化
│   └── writer.py                  # Markdown → xlsx 生成
├── docx/                          # 已有，模式参考
│   ├── __init__.py
│   ├── parser.py
│   └── writer.py
├── agent_v2/
│   └── wfm_mcp_server.py          # 注册 xlsx_read + xlsx_write
└── ...
```

与 `docx/` 模块完全平行的结构。

---

## 6. 后端实现规格

### 6.1 xlsx_read — 读取工具

#### 6.1.1 MCP 工具签名

```python
@mcp.tool()
def xlsx_read(
    path: str,
    sheet: str | None = None,
    max_rows_per_sheet: int = 200,
) -> str:
    """Parse an .xlsx file, returning structured content as Markdown tables.

    Args:
        path: .xlsx file path (workspace-relative or absolute).
        sheet: Optional sheet name to read. Reads all sheets when None.
        max_rows_per_sheet: Maximum rows per sheet (default 200).
    """
```

#### 6.1.2 parser.py 核心函数

**`parse_xlsx(path, *, max_rows_per_sheet=200)`**

输入：xlsx 文件路径
输出：结构化 dict

```python
{
    "metadata": {
        "title": str,           # 工作簿标题（来自核心属性）
        "author": str,
        "created": str,
        "sheet_names": [str],   # 所有 sheet 名称列表
    },
    "sheets": [
        {
            "name": str,
            "col_count": int,
            "row_count": int,      # 数据行数（不含表头）
            "headers": [str],      # 第一行作为表头
            "rows": [[Cell]],      # 数据行矩阵
            "merged_ranges": [str],# 合并单元格范围描述，如 "A1:D1"
            "has_formulas": bool,  # 是否包含公式
            "truncated": bool,     # 是否因 max_rows 截断
        }
    ],
    "stats": {
        "sheets_total": int,
        "sheets_kept": int,
        "total_rows": int,
    }
}
```

#### 6.1.3 单元格值处理

每个单元格（Cell）返回一个 dict，包含：

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `value` | Any | 原始值（Python 类型） | `102000` |
| `formatted` | str | 显示文本（尊重数字格式） | `"102,000"` |
| `type` | str | 值类型标签 | `"number"` / `"text"` / `"date"` / `"formula"` |
| `formula` | str? | 公式文本（仅公式单元格） | `"=C2*D2"` |

#### 6.1.4 合并单元格处理

与 DOCX parser 的 `_expand_merged_cells()` 相同策略：

1. 识别所有合并范围（`worksheet.merged_cells.ranges`）
2. 取左上角单元格的值作为合并区域的统一值
3. 矩阵中所有合并位置填充该值

这样 Claude 收到的是完整的行列矩阵，不会有空洞。

#### 6.1.5 输出格式：Markdown

**`format_xlsx_content(content)`** 将结构化数据转为 Markdown 文本供 Claude 理解：

```markdown
## Sheet: 工程量清单

| 分段号 | 工序 | 材料规格 | 数量 | 单位 |
|--------|------|---------|------|------|
| HD01 | 钢板切割 | AH36 δ=12mm | 150 | 平方米 |
| HD01 | 钢板切割 | AH36 δ=16mm | 80 | 平方米 |
| ... | ... | ... | ... | ... |

> 合并单元格: A1:D1="标题行"
> 包含公式: 是（3 处）

---

## Sheet: 汇总

| 项目 | 数量 | 总价(元) |
|------|------|---------|
| 钢板切割 | 350 | `=SUM(工程量清单!D2:D4)` |
| ... | ... | ... |

> 共 2 个 Sheet，200 行数据。
```

关键设计决策：
- 公式单元格同时输出公式文本和计算值，Claude 能看到两者
- 合并单元格在表格后以注释形式标注，不影响表格结构
- 每个 Sheet 之间用 `---` 分隔

#### 6.1.6 安全限制

| 限制 | 值 | 说明 |
|------|-----|------|
| 最大文件大小 | 10 MB | 与 docx_read 一致 |
| 最大 Sheet 数 | 20 | 超出截断，返回前 20 个 |
| 最大行数/Sheet | 200（可配置） | 超出截断并标注 |
| 路径安全 | `resolve_within()` | 工作区边界校验 |

---

### 6.2 xlsx_write — 写入工具

#### 6.2.1 MCP 工具签名

```python
@mcp.tool()
def xlsx_write(
    path: str,
    sheets: str,
    template_path: str | None = None,
) -> str:
    """Create or overwrite an .xlsx file from Markdown table content.

    Args:
        path: Output .xlsx path (workspace-relative).
        sheets: JSON array of sheets. Each element is:
            {"name": "Sheet名称", "content": "Markdown表格文本"}
            Multiple sheets supported in one call.
        template_path: Optional template .xlsx to inherit column widths
            and number formats (workspace-relative).
    """
```

#### 6.2.2 为什么用 JSON sheets 而非单个 Markdown 字符串

与 `docx_write` 的设计不同，xlsx 需要支持多 Sheet。两种方案对比：

| 方案 | 输入格式 | 问题 |
|------|---------|------|
| 单个 Markdown | 用 `## Sheet名` 分隔 | 需要自己解析 Sheet 分隔逻辑，容易与内容中的 `##` 标题混淆 |
| JSON 数组 | `[{"name":"...", "content":"..."}]` | 结构清晰，每个 Sheet 独立，无歧义 |

选用 JSON 数组。Claude 生成 JSON 的能力足够可靠（当前 `docx_write` 的 `variables` 参数已要求 JSON 输入，实践证明可行）。

#### 6.2.3 writer.py 核心函数

**`write_xlsx_from_sheets(path, sheets_data, template_path=None)`**

处理流程：

```
1. 解析 sheets JSON → list[SheetDef]
2. 对每个 SheetDef:
   a. 创建 Worksheet，设置名称
   b. 用 Markdown lexer 解析 content 中的表格
   c. 写入表头行（加粗 + 背景色 + 边框）
   d. 写入数据行（边框 + 自动类型推断）
   e. 检测合计行，写入 SUM 公式
   f. 设置列宽（自适应内容长度）
3. 保存文件
4. 返回摘要字符串
```

#### 6.2.4 Markdown 表格解析

复用 [docx/writer.py](../wfm-agents/wfm_agents/docx/writer.py) 中的 Markdown lexer。xlsx writer 只关注 `table` 类型的 token，忽略 heading / paragraph 等。

从 `_lex_markdown()` 提取表格 token 的结构：

```python
_MdToken(type="table", payload={
    "headers": ["序号", "名称", "数量", "单价", "合价"],
    "rows": [
        ["1", "钢板A", "100", "4500", "=C2*D2"],
        ["", "合计", "", "", "=SUM(E2:E5)"],
    ]
})
```

#### 6.2.5 公式写入规则

Claude 生成的 Markdown 表格中，公式通过约定的语法表达：

| 语法 | 含义 | 写入方式 |
|------|------|---------|
| `=SUM(...)` | 普通公式 | 直接写入单元格 `cell.value = formula` |
| `=C2*D2` | 行内计算 | 直接写入 |
| 纯数字 `"4500"` | 数值 | `cell.value = 4500`（自动类型转换） |
| 含千分位 `"1,200"` | 格式化数字 | 去除逗号后写入数值，设数字格式 |
| 其他文本 | 文本 | `cell.value = text` |

**类型推断逻辑**（对每个单元格的文本内容）：

```
1. 以 "=" 开头 → 公式，直接写入
2. 能转为 int 或 float → 数值，写入数字
3. 去除千分位逗号后能转为 float → 数值 + 千分位格式
4. 其他 → 文本
```

#### 6.2.6 样式方案

| 元素 | 样式 | 说明 |
|------|------|------|
| 表头行 | 粗体、白字、深蓝背景（#2F5496）、居中 | 与 [gen_test_data.py](samples/gen_test_data.py) 已有样式一致 |
| 数据行 | 宋体 10pt、居中、细边框 | 标准工程表格样式 |
| 数值列 | 右对齐、千分位格式 `#,##0` | 货币列加 `¥#,##0.00` |
| 合计行 | 粗体、上方双线边框 | 视觉区分 |
| 列宽 | `max(内容最大字符数 × 1.2, 8)` 自适应 | 最小 8 字符宽 |
| 行高 | 默认 | 不单独设置 |

#### 6.2.7 模板继承

当提供 `template_path` 时：

1. 加载模板工作簿
2. 读取第一个 Sheet 的列宽数字格式配置
3. 将配置应用到输出工作簿的对应列
4. 不复制模板内容（只继承格式配置）

这比 `docx_write` 的模板继承简单，因为 Excel 模板主要是列格式，不需要清空内容再填充。

#### 6.2.8 安全限制

| 限制 | 值 | 说明 |
|------|-----|------|
| 路径安全 | `resolve_within()` | 输出文件必须在工作区内 |
| 后缀校验 | `.xlsx` | 拒绝其他后缀 |
| Sheet 数量上限 | 20 | 防止生成超复杂文件 |
| 行数上限/Sheet | 1000 | 防止生成超大文件 |

---

## 7. MCP 工具注册

在 [wfm_mcp_server.py](../wfm-agents/wfm_agents/agent_v2/wfm_mcp_server.py) 中，与现有 DOCX 工具平行的位置注册：

```python
# ── XLSX tools ──────────────────────────────────────────────────────

@mcp.tool()
def xlsx_read(path: str, sheet: str | None = None, max_rows_per_sheet: int = 200) -> str:
    ...

@mcp.tool()
def xlsx_write(path: str, sheets: str, template_path: str | None = None) -> str:
    ...
```

注册位置：在 `docx_write` 定义之后、`if __name__ == "__main__"` 之前，与 DOCX 工具组紧邻。

Claude Code 收到工具列表后，工具名前缀为 `mcp__wfm__xlsx_read` 和 `mcp__wfm__xlsx_write`。

---

## 8. 端到端场景验证

### 8.1 测试数据

项目已有测试数据（由 [gen_test_data.py](samples/gen_test_data.py) 生成）：

- `docs/samples/工程量清单_船体分段.xlsx` — 7 行数据，含"分段号/工序/材料规格/数量/单位"
- `docs/samples/单价参考表_2026.xlsx` — 6 行数据，含"工序/材料规格/综合单价"

### 8.2 预期对话

```
用户: @工程量清单_船体分段.xlsx @单价参考表_2026.xlsx
      根据这两份文件帮我做预算表

Claude: [调用 mcp__wfm__xlsx_read → 工程量清单]
Claude: [调用 mcp__wfm__xlsx_read → 单价参考表]
Claude: [分析两表数据，匹配工序和材料规格，计算预算金额]
Claude: [调用 mcp__wfm__xlsx_write → 生成 预算表.xlsx]

输出: 已生成 预算表.xlsx，包含:
  - Sheet "预算明细": 7 行，匹配单价 × 数量
  - Sheet "汇总": 按分段号汇总金额
  - 总预算: ¥150,600
```

### 8.3 验证要点

| 检查项 | 预期 |
|-------|------|
| xlsx_read 能正确解析两个测试文件 | Markdown 表格输出，合并单元格已展开 |
| Claude 能关联两份数据 | 根据工序+材料规格匹配单价 |
| xlsx_write 生成合法 .xlsx 文件 | Excel 可打开，公式可计算，样式正确 |
| 生成的文件在工作区内 | 路径通过 `resolve_within()` 校验 |

---

## 9. 实现顺序

| 步骤 | 内容 | 依赖 | 预估 |
|------|------|------|------|
| 1 | `pyproject.toml` 加入 `openpyxl>=3.1` | 无 | 5 分钟 |
| 2 | `xlsx/parser.py` — 解析 + 合并单元格 + 格式化输出 | 步骤 1 | 0.5 天 |
| 3 | `xlsx/writer.py` — Markdown 解析 + xlsx 生成 + 样式 + 公式 | 步骤 1 | 1 天 |
| 4 | `wfm_mcp_server.py` 注册两个工具 | 步骤 2, 3 | 0.5 天 |
| 5 | 端到端测试（测试数据验证） | 步骤 4 | 0.5 天 |

**总预估：2.5 ~ 3 天**
