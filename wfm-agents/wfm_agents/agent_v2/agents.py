"""Agent definitions for the v2 SDK runner.

Two agents mirror the legacy recipe-based dispatch:

* ``plain_chat_agent``  — free-text chat with builtin workspace tools.
* ``cad_review_agent``  — structured CAD review, outputs raw JSON text;
  the route layer parses it into CadReviewReport (GLM-5.1 wraps JSON in
  markdown code fences, so we avoid SDK ``output_type``).
"""

from __future__ import annotations

from agents import Agent

from .context import WfmAgentContext
from .tools import builtin_tools

# ── System prompts (same text as legacy recipes) ──────────────────────

_SYSTEM_ZH_PLAIN = (
    "你是 WFM Studio 桌面工作站里的助手。回答尽量简洁、准确，默认使用中文。"
    "如果用户的问题信息不足，直接说明你需要什么；不要臆造事实。"
)

_SYSTEM_ZH_CAD_REVIEW = (
    "你是一位资深 CAD 图纸审图工程师，专长于工业制造与船舶设计图纸。"
    "你将基于一份从 DXF 中抽取出来的结构化摘要给出审图意见。"
    "原则：1) 不臆造实体或数值，所有结论必须能在摘要里找到依据；"
    "2) 信息不足时坦率指出；3) 输出严格 JSON，不要用 markdown 包裹。"
    "severity 只能从 error / warning / info 三档里选。"
    "若摘要不足以判断某点，请把它列入 info_gaps，不要臆造。"
    "若能定位到具体实体，请填 citations.handle / layer / location；"
    "无法定位时 citations 留空。"
    "\n\n输出格式（严格 JSON）：\n"
    '{"summary":"总体评价","issues":[{"severity":"error|warning|info",'
    '"category":"分类","title":"问题标题","description":"详细描述",'
    '"suggestion":"建议","citations":[{"handle":"","layer":"","location":"","text":""}]}],'
    '"risks":["风险点"],"info_gaps":["信息缺口"]}'
)

# ── Agents ────────────────────────────────────────────────────────────

plain_chat_agent: Agent[WfmAgentContext] = Agent(
    name="wfm.plain_chat",
    instructions=_SYSTEM_ZH_PLAIN,
    tools=builtin_tools,
    tool_use_behavior="run_llm_again",
)

cad_review_agent: Agent[WfmAgentContext] = Agent(
    name="wfm.cad_review",
    instructions=_SYSTEM_ZH_CAD_REVIEW,
    tools=[],
    tool_use_behavior="run_llm_again",
)
