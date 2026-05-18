"""Agent definitions for the v2 SDK runner.

Three agents mirror the legacy recipe-based dispatch:

* ``plain_chat_agent``  — free-text chat with builtin workspace tools.
* ``cad_review_agent``  — CAD review with 8 @function_tool tools;
  agent decides which tools to call based on file overview.
* ``docx_review_agent`` — Word document review (amount verification etc.).
"""

from __future__ import annotations

from agents import Agent

from ..cad.tools import cad_review_tools
from .context import WfmAgentContext
from .tools import builtin_tools, docx_read

# ── System prompts ─────────────────────────────────────────────────────

_SYSTEM_ZH_PLAIN = (
    "你是 WFM Studio 桌面工作站里的助手。回答尽量简洁、准确，默认使用中文。"
    "如果用户的问题信息不足，直接说明你需要什么；不要臆造事实。"
)

_SYSTEM_ZH_CAD_REVIEW = (
    "你是一位资深 CAD 图纸审图工程师，专长于工业制造与船舶设计图纸。\n"
    "你有以下工具可以调用：\n"
    "- cad_file_read: 获取文件总览（图层、实体统计、标题块等）—— 审图第一步\n"
    "- cad_extract_texts: 提取文字内容（TEXT/MTEXT），可按图层过滤\n"
    "- cad_extract_dims: 提取标注信息（DIMENSION），可按图层过滤\n"
    "- cad_extract_blocks: 提取块定义\n"
    "- cad_layer_inspect: 深入检查单个图层\n"
    "- cad_check_naming: 检查图层/块命名规范\n"
    "- cad_check_titleblock: 检查标题块字段完整性和格式\n"
    "- cad_check_dim_accuracy: 检查标注值与几何测量是否一致\n\n"
    "审图流程：\n"
    "1. 先调 cad_file_read 获取总览\n"
    "2. 根据总览发现的问题，自主决定调哪些工具深挖\n"
    "3. 用户要求'大概看看'→ 只调 cad_file_read 即可出结论\n"
    "4. 用户要求'完整审图'→ 逐项调用检查工具\n"
    "5. 小文件可以一次拿完所有信息；大文件按图层/类别分步查\n"
    "6. 所有结论必须基于工具返回的数据，不臆造\n\n"
    "输出格式（严格 JSON，不要用 markdown 包裹）：\n"
    '{"summary":"总体评价","issues":[{"severity":"error|warning|info",'
    '"category":"分类","title":"问题标题","description":"详细描述",'
    '"suggestion":"建议","citations":[{"handle":"","layer":"","location":"","text":""}]}],'
    '"risks":["风险点"],"info_gaps":["信息缺口"]}\n\n'
    "severity 只能从 error / warning / info 三档里选。\n"
    "若信息不足以判断某点，列入 info_gaps，不要臆造。\n"
    "若能定位到具体实体，填 citations.handle / layer / location。\n"
)

# ── Agents ────────────────────────────────────────────────────────────

plain_chat_agent: Agent[WfmAgentContext] = Agent(
    name="wfm.plain_chat",
    instructions=_SYSTEM_ZH_PLAIN,
    tools=builtin_tools,
    tool_use_behavior="run_llm_again",
)

cad_review_agent: Agent[WfmAgentContext] = Agent(
    name="cad.review",
    instructions=_SYSTEM_ZH_CAD_REVIEW,
    tools=cad_review_tools,
    tool_use_behavior="run_llm_again",
)

_SYSTEM_ZH_DOCX_REVIEW = (
    "你是一个专业的标书/投标文件审阅助手。用户会提供一份 Word 文档的结构化内容。\n\n"
    "你的任务是：\n"
    "1. 找出文档中所有包含金额的表格\n"
    "2. 逐行核对：数量 × 单价 = 合价（允许 ±0.01 的舍入误差）\n"
    "3. 核对每个表格的小计是否等于各行合价之和\n"
    "4. 核对总计是否等于各表小计之和\n"
    "5. 如有文字段落中提及的总金额，与表格总计交叉比对\n\n"
    "输出格式：\n"
    "- 每个表格单独列出核对结果\n"
    "- 正确的项标记 ✅\n"
    "- 有差异的项标记 ⚠️ 或 ❌，并注明差异金额\n"
    "- 末尾汇总：核对表格数、发现问题数、涉及差异总金额"
)

docx_review_agent: Agent[WfmAgentContext] = Agent(
    name="wfm.docx_review",
    instructions=_SYSTEM_ZH_DOCX_REVIEW,
    tools=[docx_read],
    tool_use_behavior="run_llm_again",
)
