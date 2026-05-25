# PPTX 模块施工方案

> 状态：待实施 | 预估工期：1-2 天 | 优先级：P2

## 1. 背景与目标

### 核心场景

用户说："把这份 PPT 所有中文字体统一改为思源黑体，英文改 Arial，标题 28pt 正文 18pt"——Agent 能理解并执行。

### 现状

| 维度 | 状态 |
|------|------|
| 前端 PPT 预览 | 已有 omni-viewer 扩展（visual 渲染，非文本堆砌） |
| 后端 PPTX 操作 | 零代码——无 `python-pptx` 依赖、无 MCP 工具 |
| 参考实现 | DOCX 模块（`wfm_agents/docx/`）成熟可用，parser + writer + 2 MCP tools |

### 目标

补齐后端 PPTX 读写能力，新增 `pptx_read` + `pptx_write` 两个 MCP 工具，使 Agent 能解析 PPTX 结构、应用字体/字号修改规则。

---

## 2. 步骤 1：添加依赖

**文件**：`wfm-agents/pyproject.toml`

在 `dependencies` 数组中新增一行：

```toml
dependencies = [
    "mcp>=1.26.0",
    "ezdxf>=1.3",
    "python-docx>=1.1",
    "python-pptx>=1.0.0",    # ← 新增
    "build123d>=0.10.0",
    "trimesh>=4.12.2",
    "shapely>=2.0",
]
```

安装：`cd wfm-agents && uv sync`

---

## 3. 步骤 2：新建 `wfm_agents/pptx/` 模块

### 3.1 文件结构

```
wfm_agents/pptx/
├── __init__.py    # 导出公共 API
├── parser.py      # 读取 PPTX：提取结构 + 逐 run 字体信息
└── writer.py      # 修改 PPTX：应用字体/字号规则
```

### 3.2 `__init__.py`

```python
from .parser import parse_pptx, format_pptx_content, summarize_fonts
from .writer import apply_font_rules

__all__ = ["parse_pptx", "format_pptx_content", "summarize_fonts", "apply_font_rules"]
```

### 3.3 `parser.py` — 读取与解析

#### 常量

```python
_MAX_SLIDES = 100
_MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB
```

#### 公共函数

##### `parse_pptx(path: Path, *, max_slides=100) -> dict`

- 校验文件大小（> 20 MB 抛 `ValueError`）
- 用 `Presentation(str(path))` 打开
- 遍历 `prs.slides` → `slide.shapes` → paragraphs → runs
- 对每个 shape 识别 `placeholder_type`
- 对每个 run 提取 Latin / CJK / CS 字体、字号、粗斜体

返回结构：

```python
{
    "metadata": {
        "title": str, "author": str, "created": str,
        "slide_count": int, "slide_width_pt": float, "slide_height_pt": float
    },
    "slides": [{
        "index": int,
        "layout": str,                      # slide layout name
        "shapes": [{
            "shape_id": int,
            "shape_type": str,               # "placeholder" | "textbox" | "table" | "group" | ...
            "placeholder_type": str | None,   # "title" | "body" | "subtitle" | None
            "name": str,
            "paragraphs": [{
                "text": str,
                "runs": [{
                    "text": str,
                    "font": {
                        "latin": str,         # 显式字体名 或 "(inherited)"
                        "ea": str,            # 显式字体名 或 "(inherited)"
                        "cs": str,            # 显式字体名 或 "(inherited)"
                        "size_pt": float | str,  # 显式 pt 值 或 "(inherited)"
                        "bold": bool | None,
                        "italic": bool | None,
                    }
                }]
            }]
        }]
    }],
    "stats": {"slides_total": int, "shapes_total": int, "runs_total": int}
}
```

##### 关键技术点：CJK 字体读取与继承标注

python-pptx 的 `Font.name` 只读 `<a:latin>`。CJK 字体**必须通过 XML** 读取 `<a:ea>` 元素。

许多 run 并未显式设置字体，而是从 Slide Master / Layout 继承。为避免 LLM 看到全是 `None` 的困惑，标注继承状态：

```python
from pptx.oxml.ns import qn

_INHERITED = "(inherited)"

def _get_font_info(run, slide_layout) -> dict:
    rPr = run._r.get_or_add_rPr()

    # Latin
    latin_el = rPr.find(qn("a:latin"))
    latin = latin_el.get("typeface") if latin_el is not None else None

    # CJK / EA
    ea_el = rPr.find(qn("a:ea"))
    ea_typeface = ea_el.get("typeface") if ea_el is not None else None

    # Complex Script
    cs_el = rPr.find(qn("a:cs"))
    cs_typeface = cs_el.get("typeface") if cs_el is not None else None

    # 如果 XML 中无显式字体，尝试从 theme 获取默认值
    if latin is None:
        latin = _get_theme_font(slide_layout, "latin") or _INHERITED
    if ea_typeface is None:
        ea_typeface = _get_theme_font(slide_layout, "ea") or _INHERITED
    if cs_typeface is None:
        cs_typeface = _get_theme_font(slide_layout, "cs") or _INHERITED

    size_pt = run.font.size.pt if run.font.size else None

    return {
        "latin": latin,
        "ea": ea_typeface,
        "cs": cs_typeface,
        "size_pt": size_pt if size_pt is not None else _INHERITED,
        "bold": run.font.bold,
        "italic": run.font.italic,
    }


def _get_theme_font(slide_layout, script_type: str) -> str | None:
    """从 slide layout 的 theme 中获取默认字体。"""
    try:
        theme = slide_layout.slide_master.element
        # 查找 <a:majorFont> / <a:minorFont> 下的对应 script 元素
        font_scheme = theme.find(".//" + qn("a:fontScheme"))
        if font_scheme is None:
            return None
        # 默认取 minor font（正文用）
        minor = font_scheme.find(qn("a:minorFont"))
        if minor is None:
            return None
        tag_map = {"latin": qn("a:latin"), "ea": qn("a:ea"), "cs": qn("a:cs")}
        el = minor.find(tag_map[script_type])
        return el.get("typeface") if el is not None else None
    except Exception:
        return None
```

返回结构中字体字段语义：实际字体名 = 显式设置值，`"(inherited)"` = 从 theme/master 继承。

##### `_classify_placeholder(shape) -> str | None`

通过 `shape.placeholder_format.type` 映射 `PP_PLACEHOLDER` 枚举：

| 枚举值 | 返回 |
|--------|------|
| `TITLE` / `CENTER_TITLE` | `"title"` |
| `SUBTITLE` | `"subtitle"` |
| `BODY` | `"body"` |
| 非占位符 shape | `None` |

##### `format_pptx_content(content: dict, *, max_slides_preview: int = 30) -> str`

将解析结果格式化为 Markdown 供 LLM 阅读。超过 `max_slides_preview` 时截断，末尾提示剩余页数：

```markdown
# Presentation: 项目汇报
5 张幻灯片, 960×540 pt

---

## Slide 1 (Layout: Title Slide)

### Shape: "Title 1" [placeholder: title]
Run: "项目汇报" — Latin: Calibri, CJK: 微软雅黑, 32pt, bold

### Shape: "Subtitle 2" [placeholder: subtitle]
Run: "2024年度总结" — Latin: Calibri, CJK: 微软雅黑, 18pt
```

当幻灯片超过 `max_slides_preview` 时，末尾追加：

```markdown
... (剩余 70 张幻灯片已省略，共 100 张)
```

对每张幻灯片内的 runs，如果单页 run 数超过 20 个，仅显示前 20 个并提示剩余数量。

##### `summarize_fonts(content: dict) -> dict`

提取去重字体清单：

```python
{
    "fonts": {
        "latin": {"Calibri": 42, "Arial": 5},
        "ea": {"微软雅黑": 30, "宋体": 17}
    },
    "sizes": {
        "unique": [14.0, 18.0, 24.0, 32.0, 44.0],
        "min": 14.0, "max": 44.0
    },
    "total_runs": 47
}
```

#### 需处理的边界情况

- **表格 shape**：通过 `shape.table.iter_cells()` 遍历每个 cell 的 paragraphs/runs
- **组合 shape**：通过 `shape.shapes` 递归处理子 shape
- **空 paragraph / 空 run**：跳过
- **无 text_frame 的 shape**：跳过
- **超过 max_slides**：截断，在 stats 中记录

### 3.4 `writer.py` — 字体修改

#### 核心函数

##### `apply_font_rules(path: Path, font_rules: list[dict], output_path: Path | None = None, *, dry_run: bool = False) -> dict`

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | `Path` | 源 PPTX 文件 |
| `font_rules` | `list[dict]` | 字体规则列表（见下方 schema） |
| `output_path` | `Path \| None` | 另存路径，默认覆盖源文件 |
| `dry_run` | `bool` | 预览模式：只计算将要修改的内容，不写文件。默认 `False` |

**返回**：

正常模式：`{"slides": int, "shapes_affected": int, "runs_modified": int}`

dry_run 模式：`{"would_modify": [{"slide": int, "shape": str, "field": str, "old": str, "new": str}, ...], "total_changes": int}`

#### 字体规则 Schema

```json
[
  {
    "scope": "title",
    "latin": "Arial",
    "ea": "思源黑体",
    "size_pt": 28
  },
  {
    "scope": "body",
    "latin": "Arial",
    "ea": "思源黑体",
    "size_pt": 18,
    "include_tables": true
  },
  {
    "scope": "textbox",
    "ea": "思源黑体",
    "slide_range": [2, null]
  }
]
```

每条规则的字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | `str` | 是 | `"title"` \| `"body"` \| `"subtitle"` \| `"textbox"` \| `"all"` |
| `latin` | `str` | 否 | Latin 字体名称 |
| `ea` | `str` | 否 | East Asian / CJK 字体名称 |
| `cs` | `str` | 否 | Complex Script 字体名称（阿拉伯语/希伯来语等） |
| `size_pt` | `float` | 否 | 字号（pt） |
| `bold` | `bool` | 否 | 加粗 |
| `italic` | `bool` | 否 | 斜体 |
| `slide_range` | `[int\|null, int\|null]` | 否 | 幻灯片范围过滤，`null` 表示不限。例：`[2, null]` = 从第 2 页到最后 |
| `include_tables` | `bool` | 否 | 是否作用于表格内文本，默认 `false` |

scope 匹配逻辑：

| scope | 匹配条件 |
|-------|---------|
| `"title"` | `placeholder_type == "title"` |
| `"body"` | `placeholder_type == "body"` |
| `"subtitle"` | `placeholder_type == "subtitle"` |
| `"textbox"` | 非占位符且有文本的 shape（自由文本框） |
| `"all"` | 所有有文本的 shape |

#### 关键实现：`_apply_rule_to_run(run, rule) -> bool`

**设置 CJK / CS 字体必须操作 XML**——python-pptx 的 `Font.name` 只写 `<a:latin>`：

```python
def _apply_rule_to_run(run, rule: dict) -> bool:
    from pptx.util import Pt
    from pptx.oxml.ns import qn
    from lxml import etree

    rPr = run._r.get_or_add_rPr()
    modified = False

    # Latin 字体
    if rule.get("latin"):
        modified |= _set_font_element(rPr, qn("a:latin"), rule["latin"])

    # CJK 字体 — 核心操作
    if rule.get("ea"):
        modified |= _set_font_element(rPr, qn("a:ea"), rule["ea"])

    # CS (Complex Script) 字体 — 阿拉伯语/希伯来语等
    if rule.get("cs"):
        modified |= _set_font_element(rPr, qn("a:cs"), rule["cs"])

    # 字号
    if rule.get("size_pt") is not None:
        new_size = Pt(rule["size_pt"])
        if run.font.size != new_size:
            run.font.size = new_size
            modified = True

    # bold / italic
    if rule.get("bold") is not None and run.font.bold != rule["bold"]:
        run.font.bold = rule["bold"]
        modified = True
    if rule.get("italic") is not None and run.font.italic != rule["italic"]:
        run.font.italic = rule["italic"]
        modified = True

    return modified


def _set_font_element(rPr, tag, typeface: str) -> bool:
    """通用设置字体 XML 元素，返回是否修改。"""
    from lxml import etree

    el = rPr.find(tag)
    if el is not None:
        if el.get("typeface") != typeface:
            el.set("typeface", typeface)
            return True
    else:
        el = etree.SubElement(rPr, tag)
        el.set("typeface", typeface)
        return True
    return False
```

#### 主流程

1. `Presentation(str(path))` 打开
2. 遍历 slides（按 `slide_range` 过滤）→ shapes → paragraphs → runs
3. 对每个 shape 判断 `placeholder_type`，处理表格和组合 shape
4. 对每个 run 找到第一条 scope 匹配的规则，调用 `_apply_rule_to_run`
5. 如果 `dry_run=True`，收集变更清单但不保存，直接返回 `would_modify`
6. 否则保存到 `output_path`（默认覆盖）
7. 覆盖保存时的安全机制：先写临时文件，成功后替换原文件，避免写入中途异常导致文件损坏

#### 递归遍历：`_walk_shapes`

```python
_MAX_GROUP_DEPTH = 10

def _walk_shapes(shapes, callback, depth=0):
    if depth > _MAX_GROUP_DEPTH:
        return
    for shape in shapes:
        callback(shape)
        if shape.shape_type == MS_SHAPE_TYPE.GROUP:
            _walk_shapes(shape.shapes, callback, depth + 1)
```

#### slide_range 过滤逻辑

```python
def _in_slide_range(slide_index: int, rule: dict) -> bool:
    sr = rule.get("slide_range")
    if sr is None:
        return True
    lo, hi = sr[0], sr[1]  # None 表示不限
    if lo is not None and slide_index < lo:
        return False
    if hi is not None and slide_index > hi:
        return False
    return True
```

---

## 4. 步骤 3：注册 MCP 工具

**文件**：`wfm-agents/wfm_agents/agent_v2/wfm_mcp_server.py`

在文件末尾 `if __name__ == "__main__":` 前添加。

### 4.1 `pptx_read`

```python
# ── PPTX tools ──────────────────────────────────────────────────────

@mcp.tool()
def pptx_read(path: str, detail_level: str = "summary") -> str:
    """Read and parse a .pptx file, returning structured content with font info.

    Use to understand current fonts, sizes, and structure before editing with pptx_write.

    Args:
        path: .pptx file path (workspace-relative).
        detail_level: "summary" (default) — Markdown overview with per-run font info;
            "fonts_only" — deduplicated font inventory only;
            "full" — complete structured JSON.
    """
    import json  # noqa: PLC0415
    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415
    from ..pptx import parse_pptx, format_pptx_content, summarize_fonts  # noqa: PLC0415

    root = _root()
    try:
        target = resolve_within(root, path)
    except WorkspaceViolation as exc:
        return f"Error: {exc}"

    if not target.is_file():
        return f"Error: 文件不存在: {path}"
    if target.suffix.lower() != ".pptx":
        return f"Error: 仅支持 .pptx 文件: {path}"

    try:
        content = parse_pptx(target)
    except Exception as exc:
        return f"Error: PPTX 解析失败: {exc}"

    if detail_level == "fonts_only":
        return json.dumps(summarize_fonts(content), ensure_ascii=False)
    if detail_level == "full":
        return json.dumps(content, ensure_ascii=False, default=str)
    return format_pptx_content(content)
```

### 4.2 `pptx_write`

```python
@mcp.tool()
def pptx_write(
    path: str,
    font_rules: str | None = None,
    output_path: str | None = None,
    dry_run: bool = False,
) -> str:
    """Edit a .pptx file by applying font/style rules.

    Preserves all layout, images, shapes, and animations — only modifies text formatting.

    Args:
        path: Source .pptx file path (workspace-relative).
        font_rules: JSON array of font rule objects. Each rule:
            - scope: "title" | "body" | "subtitle" | "textbox" | "all"
            - latin: Latin font name (optional)
            - ea: East Asian/CJK font name (optional)
            - cs: Complex Script font name (optional)
            - size_pt: Font size in points (optional)
            - bold: true/false (optional)
            - italic: true/false (optional)
            - slide_range: [start, end] slide index filter, null=unbounded (optional)
            - include_tables: whether to affect text inside tables (optional, default false)
        output_path: Save to different file (workspace-relative). Default: overwrite source.
        dry_run: If true, return a preview of changes without modifying the file.

    Example:
        font_rules='[{"scope":"title","latin":"Arial","ea":"思源黑体","size_pt":28},
                     {"scope":"body","latin":"Arial","ea":"思源黑体","size_pt":18}]'
    """
    import json  # noqa: PLC0415
    from ..workspace import resolve_within, WorkspaceViolation  # noqa: PLC0415
    from ..pptx.writer import apply_font_rules  # noqa: PLC0415

    root = _root()
    try:
        src = resolve_within(root, path)
    except WorkspaceViolation as exc:
        return f"Error: {exc}"

    if not src.is_file():
        return f"Error: 文件不存在: {path}"
    if src.suffix.lower() != ".pptx":
        return f"Error: 仅支持 .pptx 文件: {path}"
    if not font_rules:
        return "Error: 需要提供 font_rules 参数"

    try:
        rules = json.loads(font_rules)
    except json.JSONDecodeError as exc:
        return f"Error: font_rules JSON 解析失败: {exc}"
    if not isinstance(rules, list) or not rules:
        return "Error: font_rules 必须是非空 JSON 数组"

    for i, rule in enumerate(rules):
        if not isinstance(rule, dict):
            return f"Error: font_rules[{i}] 必须是 JSON 对象"
        if "scope" not in rule:
            return f"Error: font_rules[{i}] 缺少 scope 字段"
        valid_keys = {"scope", "latin", "ea", "cs", "size_pt", "bold", "italic",
                      "slide_range", "include_tables"}
        unknown = set(rule) - valid_keys
        if unknown:
            return f"Error: font_rules[{i}] 含未知字段: {unknown}"

    dst = None
    if output_path:
        try:
            dst = resolve_within(root, output_path)
        except WorkspaceViolation as exc:
            return f"Error: {exc}"

    try:
        result = apply_font_rules(src, rules, output_path=dst, dry_run=dry_run)
        if dry_run:
            changes = result["would_modify"]
            preview = "\n".join(
                f"  - Slide {c['slide']} / {c['shape']}: {c['field']} "
                f"\"{c['old']}\" → \"{c['new']}\""
                for c in changes[:20]
            )
            suffix = f"\n  ... 共 {len(changes)} 处变更" if len(changes) > 20 else ""
            return f"dry_run 预览:\n{preview}{suffix}"
        return (f"PPTX 已修改: {result['slides']} 页幻灯片, "
                f"{result['shapes_affected']} 个形状受影响, "
                f"{result['runs_modified']} 个文本段已更新")
    except Exception as exc:
        return f"Error: PPTX 修改失败: {exc}"
```

### 4.3 设计决策

| 决策 | 理由 |
|------|------|
| `pptx_read` 有 3 种 detail_level | "fonts_only" 响应最小，适合统一字体场景；"full" 适合精确判断 |
| `font_rules` 用 JSON 字符串 | 与 `docx_write` 的 `variables` 参数模式一致 |
| scope 增加 `"textbox"` 和 `slide_range` | 实际场景中大量自由文本框需要单独处理，且用户常需按页范围过滤 |
| 继承字体标注为 `"(inherited)"` | 避免 LLM 看到全 `None` 困惑，同时回溯 theme 获取默认值 |
| 覆盖前写临时文件再替换 | 防止写入中途异常导致源文件损坏 |
| `dry_run` 预览模式 | 用户可在正式修改前确认变更清单 |
| Group shape 递归深度限制 10 层 | 防止畸形 PPTX 导致栈溢出 |
| `format_pptx_content` 分页截断 | 100+ 页的 PPTX 输出过长，截断后 LLM 可逐页查询 |
| scope 用 placeholder_type 匹配 | `PP_PLACEHOLDER` 枚举是区分标题/正文的标准机制 |
| CJK / CS 字体用 XML 操作 | `Font.name` 只影响 `<a:latin>`，这是 python-pptx 的已知限制 |

---

## 5. 端到端交互示例

用户说："把这份 PPT 所有中文字体统一改为思源黑体，英文改 Arial，标题 28pt 正文 18pt"

**第一步**：Agent 调用 `pptx_read` 了解当前字体

```
pptx_read(path="汇报.pptx", detail_level="fonts_only")
```

返回：
```json
{
  "fonts": {"latin": {"Calibri": 42, "Arial": 5}, "ea": {"微软雅黑": 30, "宋体": 17}},
  "sizes": {"unique": [14.0, 18.0, 24.0, 32.0, 44.0]},
  "total_runs": 47
}
```

**第二步**：Agent 先 dry_run 预览变更

```
pptx_write(
    path="汇报.pptx",
    font_rules='[{"scope":"title","latin":"Arial","ea":"思源黑体","size_pt":28},{"scope":"body","latin":"Arial","ea":"思源黑体","size_pt":18}]',
    dry_run=true
)
```

返回：
```
dry_run 预览:
  - Slide 1 / Title 1: ea "微软雅黑" → "思源黑体"
  - Slide 1 / Title 1: latin "Calibri" → "Arial"
  - Slide 1 / Title 1: size_pt "32.0" → "28.0"
  - Slide 2 / Content Placeholder 1: ea "宋体" → "思源黑体"
  ... 共 47 处变更
```

**第三步**：确认无误后正式执行

```
pptx_write(
    path="汇报.pptx",
    font_rules='[{"scope":"title","latin":"Arial","ea":"思源黑体","size_pt":28},{"scope":"body","latin":"Arial","ea":"思源黑体","size_pt":18}]'
)
```

返回：`"PPTX 已修改: 12 页幻灯片, 35 个形状受影响, 47 个文本段已更新"`

**第四步**：用户在 IDE 中用 omni-viewer 打开修改后的文件，直接预览效果。

---

## 6. 测试计划

### 测试文件

| 文件 | 内容 |
|------|------|
| `tests/test_pptx_parser.py` | parser 测试（参考 `test_docx_parser.py` 模式） |
| `tests/test_pptx_writer.py` | writer 测试 |

### parser 测试用例

用 python-pptx 编程创建临时 .pptx 文件：

1. **test_empty_presentation** — 空 PPTX，验证 metadata 和空 slides
2. **test_title_slide** — 标题+副标题，验证 placeholder_type 检测
3. **test_content_slide** — 正文占位符，验证 body 检测
4. **test_font_extraction** — 给 run 设置特定 Latin 和 CJK 字体，验证 ea/latin 都被正确读取
5. **test_inherited_font** — 不设置显式字体的 run，验证标注为 `"(inherited)"`
6. **test_textbox_shape** — 非占位符文本框，验证 placeholder_type 为 None
7. **test_table_shape** — 表格内的文本，验证通过 iter_cells 提取
8. **test_group_shape** — 组合形状内的文本，验证递归提取且深度超限后跳过
9. **test_multiple_slides** — 多张幻灯片，验证计数和索引
10. **test_file_size_limit** — mock 大文件，验证 ValueError
11. **test_summarize_fonts** — 多种字体混合，验证去重统计
12. **test_format_content** — 验证 Markdown 输出格式
13. **test_format_content_truncation** — 超过 max_slides_preview 时验证截断提示

### writer 测试用例

每个测试：创建 .pptx → apply rules → 重新 parse 验证：

1. **test_apply_cjk_font** — 设置 ea 规则，验证 `<a:ea typeface>` 被修改
2. **test_apply_latin_font** — 设置 latin 规则，验证 `<a:latin typeface>` 被修改
3. **test_apply_cs_font** — 设置 cs 规则，验证 `<a:cs typeface>` 被修改
4. **test_apply_size** — 设置 size_pt 规则，验证字号变更
5. **test_title_scope** — scope="title"，验证只有 title shape 被修改
6. **test_body_scope** — scope="body"，验证只有 body shape 被修改
7. **test_textbox_scope** — scope="textbox"，验证只有非占位符文本框被修改
8. **test_all_scope** — scope="all"，验证所有 shape 被修改
9. **test_multiple_rules** — 先 title 后 body，验证两条规则都生效
10. **test_slide_range** — slide_range=[2, 4]，验证只有第 2-4 页被修改
11. **test_include_tables** — include_tables=true，验证表格内文本被修改
12. **test_exclude_tables_default** — 默认不包含表格，验证表格内文本未被修改
13. **test_save_to_different_file** — 指定 output_path，验证源文件未被修改
14. **test_preserve_images** — 含图片的 PPTX，验证图片二进制不被破坏（对比 sha256）
15. **test_dry_run** — dry_run=True，验证文件未被修改且返回 would_modify 清单
16. **test_corrupt_rollback** — mock 写入异常，验证源文件未被损坏
17. **test_group_depth_limit** — 超过 10 层嵌套的组合形状，验证不崩溃

---

## 7. 文件修改清单

| 操作 | 文件 |
|------|------|
| 修改 | `wfm-agents/pyproject.toml` — 加 `python-pptx>=1.0.0` |
| 新建 | `wfm-agents/wfm_agents/pptx/__init__.py` |
| 新建 | `wfm-agents/wfm_agents/pptx/parser.py` |
| 新建 | `wfm-agents/wfm_agents/pptx/writer.py` |
| 修改 | `wfm-agents/wfm_agents/agent_v2/wfm_mcp_server.py` — 加 pptx_read + pptx_write |
| 新建 | `wfm-agents/tests/test_pptx_parser.py` |
| 新建 | `wfm-agents/tests/test_pptx_writer.py` |

---

## 8. 验证方式

1. `cd wfm-agents && uv sync` — 安装依赖成功
2. `cd wfm-agents && uv run pytest tests/test_pptx_parser.py tests/test_pptx_writer.py -v` — 测试全绿
3. 启动 MCP server，用 Claude Code CLI 调用 `pptx_read` 读取一个真实 .pptx 文件，确认返回结构正确
4. 调用 `pptx_write` 应用字体规则，用 omni-viewer 打开修改后文件确认字体已变更
