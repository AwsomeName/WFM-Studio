"""CAD review structured-output schema.

Owned by ``wfm_agents.cad.review`` (not ``agent/recipes``) so other future
artefacts (e.g. an Issue persistence layer, an HTTP report endpoint) can
import the same models without depending on the runner.

Design notes
------------

* ``Citation.handle`` is the DXF entity handle (hex string) — guarantees a
  stable round-trip back to the source for an Issue-反标 view (L3 / 后续期).
* ``IssueSeverity`` is intentionally a 3-value enum to keep the prompt
  surface small and the post-processor's markdown render trivial.
* ``CadReviewReport`` is **closed** (``extra="forbid"``) so a typo from the
  upstream model surfaces as a Pydantic ValidationError the runner can
  recover from via the Structured Outputs degradation path (D2 晚).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

IssueSeverity = Literal["error", "warning", "info"]


class Citation(BaseModel):
    """A pointer back into the DXF for one piece of evidence."""

    model_config = ConfigDict(extra="forbid")

    handle: str | None = Field(
        default=None,
        description="DXF entity handle (hex). 留空表示该条来自摘要级聚合而非具体实体。",
    )
    layer: str | None = Field(default=None, description="实体所在图层名。")
    location: str | None = Field(
        default=None,
        description="人类可读的位置描述，例如 '右下角 A0 标题栏 / X≈420,Y≈280'。",
    )
    text: str | None = Field(
        default=None,
        description="被引用的实体文本或标注内容（如有）。",
    )


class Issue(BaseModel):
    """One審图意見."""

    model_config = ConfigDict(extra="forbid")

    severity: IssueSeverity = Field(
        ..., description="error / warning / info；只能从这三个里选。"
    )
    category: str = Field(
        ..., description="问题分类（图层、标注、文字、规范、命名…）。"
    )
    title: str = Field(..., description="一行能看明白问题是什么。")
    description: str = Field(..., description="详细描述，含为什么是问题。")
    suggestion: str | None = Field(
        default=None, description="建议的修改方式；可空。"
    )
    citations: list[Citation] = Field(
        default_factory=list, description="支持本条结论的实体引用，可空。"
    )


class CadReviewReport(BaseModel):
    """Top-level structured审图报告."""

    model_config = ConfigDict(extra="forbid")

    summary: str = Field(..., description="总体评价（1~3 句话）。")
    issues: list[Issue] = Field(
        default_factory=list, description="按 severity 排序的关键问题列表。"
    )
    risks: list[str] = Field(
        default_factory=list,
        description="中长期可优化点（命名规范、图层组织等），每条一句话。",
    )
    info_gaps: list[str] = Field(
        default_factory=list,
        description="若摘要不足以判断，明确指出还需要哪些信息。",
    )


# --- Markdown rendering (老前端 0 改动) ------------------------------------


_SEVERITY_LABEL: dict[str, str] = {
    "error": "❌ error",
    "warning": "⚠️ warning",
    "info": "ℹ️ info",
}


def _render_citation(c: Citation) -> str:
    parts: list[str] = []
    if c.handle:
        parts.append(f"handle={c.handle}")
    if c.layer:
        parts.append(f"layer={c.layer}")
    if c.location:
        parts.append(c.location)
    if c.text:
        parts.append(f"“{c.text}”")
    return " / ".join(parts) if parts else "(摘要级，无具体实体)"


def render_markdown(report: CadReviewReport) -> str:
    """Render a :class:`CadReviewReport` to the same shape the legacy
    free-text审图 prompt produced.

    Keeps the front-end's existing renderer happy: it receives a markdown
    string in ``ChatReply.content`` exactly like before.
    """
    lines: list[str] = []
    lines.append("## 总体评价")
    lines.append(report.summary.strip() or "(无)")
    lines.append("")

    lines.append("## 关键问题")
    if not report.issues:
        lines.append("- (无)")
    for issue in report.issues:
        sev = _SEVERITY_LABEL.get(issue.severity, issue.severity)
        lines.append(f"- [{sev}] [{issue.category}] {issue.title}")
        lines.append(f"  - 描述：{issue.description}")
        if issue.suggestion:
            lines.append(f"  - 建议：{issue.suggestion}")
        if issue.citations:
            for cite in issue.citations:
                lines.append(f"  - 证据：{_render_citation(cite)}")
    lines.append("")

    lines.append("## 风险与建议")
    if report.risks:
        for r in report.risks:
            lines.append(f"- {r}")
    else:
        lines.append("- (无)")
    lines.append("")

    lines.append("## 信息缺口")
    if report.info_gaps:
        for g in report.info_gaps:
            lines.append(f"- {g}")
    else:
        lines.append("- (无)")

    return "\n".join(lines).rstrip() + "\n"
