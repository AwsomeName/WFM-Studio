"""Tests for the CAD review case (DXF parser + chat detection).

v0.2 起 DWG -> DXF 转换链路（``ODAFileConverter`` / ``/v1/cad/convert``）已下线，
浏览器内由 LibreDWG WASM + cad-viewer 直接渲染。后端只负责 DXF 解析摘要 +
``/v1/chat`` 路由分支。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wfm_agents.cad import (
    cad_review_prompt,
    format_summary_text,
    summarize_dxf,
    summarize_dxf_text,
)
from wfm_agents.routes.chat import (
    _extract_dxf_candidates,
    _resolve_dxf_in_workspace,
)
from wfm_agents.server import create_app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app())


# Minimal AC1009-era DXF that ezdxf can parse: header + tables + entities
# + a single TEXT in modelspace. Keep stable for snapshotting in tests.
_MINIMAL_DXF = """\
0
SECTION
2
HEADER
9
$ACADVER
1
AC1009
0
ENDSEC
0
SECTION
2
TABLES
0
TABLE
2
LAYER
70
1
0
LAYER
2
PLAN
70
0
62
7
6
CONTINUOUS
0
ENDTAB
0
ENDSEC
0
SECTION
2
ENTITIES
0
TEXT
8
PLAN
10
0.0
20
0.0
40
2.5
1
HELLO
0
ENDSEC
0
EOF
"""


def _write_dxf(workspace: Path, name: str = "drawings/foo.dxf") -> Path:
    path = workspace / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_MINIMAL_DXF, encoding="utf-8")
    return path


# --- TestParserAndRecipe ------------------------------------------------------


class TestParserAndRecipe:
    def test_summarize_minimal_dxf(self, tmp_path: Path) -> None:
        dxf = _write_dxf(tmp_path)
        summary = summarize_dxf(dxf)

        assert summary["file"]["path"].endswith("foo.dxf")
        assert summary["layer_count"] >= 1
        layer_names = {layer["name"] for layer in summary["layers"]}
        # PLAN layer is what we wrote; ezdxf also auto-creates "0" so just
        # require the explicit one we authored.
        assert "PLAN" in layer_names
        # Our TEXT entity should be picked up by entity scanning.
        assert any(t["text"] == "HELLO" for t in summary["texts"])

    def test_summarize_dxf_text_parses_inline_string(self) -> None:
        # Same content, but as an in-memory string (viewer_inline 分支).
        summary = summarize_dxf_text(_MINIMAL_DXF, source_label="file:///x/foo.dxf")
        assert summary["file"]["path"] == "file:///x/foo.dxf"
        assert summary["layer_count"] >= 1
        assert any(layer["name"] == "PLAN" for layer in summary["layers"])
        assert any(t["text"] == "HELLO" for t in summary["texts"])

    def test_format_summary_includes_layer_block(self, tmp_path: Path) -> None:
        dxf = _write_dxf(tmp_path)
        text = format_summary_text(summarize_dxf(dxf))
        assert "图层" in text
        assert "'PLAN'" in text
        assert "HELLO" in text

    def test_cad_review_prompt_contains_user_question(self, tmp_path: Path) -> None:
        dxf = _write_dxf(tmp_path)
        prompt = cad_review_prompt(summarize_dxf(dxf), "请审一下消防分区")
        assert "请审一下消防分区" in prompt
        assert "DXF 摘要" in prompt
        assert "输出要求" in prompt


# --- TestChatExtraction -------------------------------------------------------


class TestChatExtraction:
    def test_extract_relative_token(self) -> None:
        out = _extract_dxf_candidates("帮我审一下 drawings/foo.dxf 看看")
        assert "drawings/foo.dxf" in out

    def test_extract_quoted_token(self) -> None:
        out = _extract_dxf_candidates("看看 'drawings/bar baz.dxf' 这张")
        # 我们只看到一个候选（不允许中间含空格），所以这里期望提取 baz.dxf
        # 至少要能找到一个以 .dxf 结尾的 token。
        assert any(c.endswith(".dxf") for c in out)

    def test_extract_no_token(self) -> None:
        assert _extract_dxf_candidates("hello world") == []

    def test_resolve_within_workspace(self, tmp_path: Path) -> None:
        dxf = _write_dxf(tmp_path)
        rel = dxf.relative_to(tmp_path).as_posix()
        resolved = _resolve_dxf_in_workspace(str(tmp_path), rel)
        assert resolved == dxf

    def test_resolve_rejects_outside_workspace(self, tmp_path: Path) -> None:
        # Path that escapes the workspace via ../
        assert _resolve_dxf_in_workspace(str(tmp_path), "../escape.dxf") is None

    def test_resolve_rejects_nonexistent(self, tmp_path: Path) -> None:
        assert _resolve_dxf_in_workspace(str(tmp_path), "ghost.dxf") is None


# --- TestChatRouting (HTTP, echo mode echoes the rewritten prompt) ------------


_LEGACY_CAD_ECHO_SKIP_REASON = (
    "Pinned the legacy crewai echo template that printed cad_review_prompt "
    "verbatim. After D2 下午 CAD review goes through CadReviewRecipe + the "
    "SDK-native runner; equivalent coverage now lives in "
    "tests/test_cad_review_recipe.py."
)


class TestChatRouting:
    @pytest.mark.skip(reason=_LEGACY_CAD_ECHO_SKIP_REASON)
    def test_echo_chat_includes_summary_when_dxf_referenced(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        _write_dxf(tmp_path)

        resp = client.post(
            "/v1/chat",
            json={
                "workspace_root": str(tmp_path),
                "message": "审一下 drawings/foo.dxf",
                "mode": "echo",
                # 显式 crewai 走 echo 模板（默认引擎自 2026-05 已切到 openai）
                "engine": "crewai",
            },
        )
        assert resp.status_code == 200, resp.text
        content = resp.json()["content"]

        # echo engine prints the message verbatim, so we should see the
        # cad_review_prompt scaffolding *and* the embedded summary text.
        assert "DXF 摘要" in content
        assert "PLAN" in content
        assert "HELLO" in content

    def test_chat_falls_back_when_dxf_not_in_workspace(
        self,
        client: TestClient,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Non-existent ``.dxf`` token must fall back to plain chat (no 422/4xx).

        Post agent_v2 migration the fallback goes through
        :func:`Runner.run_sync` rather than the legacy gateway,
        so we mock the Agents SDK ``Runner.run_sync``.
        """
        from types import SimpleNamespace

        import agents

        monkeypatch.setenv("WFM_OPENAI_API_KEY", "sk-test")
        monkeypatch.setenv("WFM_AGENT_MODEL", "gpt-test")

        monkeypatch.setattr(
            agents.Runner,
            "run_sync",
            lambda **_kw: SimpleNamespace(
                final_output="收到，但工作区里没有 imaginary.dxf。",
                new_items=[],
                raw_responses=[],
            ),
        )

        resp = client.post(
            "/v1/chat",
            json={
                "workspace_root": str(tmp_path),
                "message": "审一下 imaginary.dxf",
            },
        )
        assert resp.status_code == 200, resp.text
        content = resp.json()["content"]
        # CAD review prompt scaffolding never reaches the model — fallback path.
        assert "DXF 摘要" not in content


# --- TestChatInlineDxfText (v0.2: 浏览器 in-browser 解析后直接 POST 上来) ----


class TestChatInlineDxfText:
    @pytest.mark.skip(reason=_LEGACY_CAD_ECHO_SKIP_REASON)
    def test_inline_dxf_text_triggers_review(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # 工作区里没有 .dxf 文件；前端 viewer 把 DXF 文本附在请求里。
        resp = client.post(
            "/v1/chat",
            json={
                "workspace_root": str(tmp_path),
                "message": "请审一下这张图",
                "mode": "echo",
                "engine": "crewai",
                "dxf_text": _MINIMAL_DXF,
                "dxf_source_uri": "file:///fake/foo.dwg",
            },
        )
        assert resp.status_code == 200, resp.text
        content = resp.json()["content"]
        assert "DXF 摘要" in content
        # 摘要中应能看到我们写入的图层和文字
        assert "PLAN" in content
        assert "HELLO" in content
        # source_label 应当反映在摘要里
        assert "file:///fake/foo.dwg" in content

    @pytest.mark.skip(reason=_LEGACY_CAD_ECHO_SKIP_REASON)
    def test_inline_dxf_text_takes_priority_over_message_token(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        # 工作区里有一个完全不同的 .dxf，但用户在 viewer 里另开了一张，
        # 这种情况下应当走 inline 分支，而不是用工作区里那张。
        decoy = _write_dxf(tmp_path, name="decoy.dxf")
        decoy_text = decoy.read_text(encoding="utf-8")
        # 改一下 decoy 让它与 inline 不同（添加另一图层 DECOY）。
        decoy.write_text(decoy_text.replace("PLAN", "DECOY"), encoding="utf-8")

        resp = client.post(
            "/v1/chat",
            json={
                "workspace_root": str(tmp_path),
                "message": "审一下 decoy.dxf",
                "mode": "echo",
                "engine": "crewai",
                "dxf_text": _MINIMAL_DXF,
            },
        )
        assert resp.status_code == 200, resp.text
        content = resp.json()["content"]
        assert "DXF 摘要" in content
        # inline 的 PLAN 应当在；decoy 文件里的 DECOY 应当不在。
        assert "PLAN" in content
        assert "DECOY" not in content

    def test_inline_blank_dxf_text_returns_400(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        resp = client.post(
            "/v1/chat",
            json={
                "workspace_root": str(tmp_path),
                "message": "随便聊聊",
                "mode": "echo",
                "engine": "crewai",
                "dxf_text": "   \n\t  ",
            },
        )
        assert resp.status_code == 400, resp.text

    def test_inline_invalid_dxf_text_returns_422(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        resp = client.post(
            "/v1/chat",
            json={
                "workspace_root": str(tmp_path),
                "message": "审图",
                "mode": "echo",
                "engine": "crewai",
                "dxf_text": "this is not a dxf at all",
            },
        )
        assert resp.status_code == 422, resp.text
