"""Structured CAD review (D2 下午).

The legacy ``wfm_agents.cad.recipes`` module produces a free-text Markdown
prompt; this package adds Pydantic schemas so the model returns a typed
:class:`CadReviewReport` via OpenAI Structured Outputs. The runner-side
recipe lives at :class:`wfm_agents.agent.recipes.cad_review.CadReviewRecipe`.
"""

from __future__ import annotations

from .schema import CadReviewReport, Citation, Issue, IssueSeverity, render_markdown

__all__ = [
    "CadReviewReport",
    "Citation",
    "Issue",
    "IssueSeverity",
    "render_markdown",
]
