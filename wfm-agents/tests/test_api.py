"""End-to-end HTTP tests using FastAPI TestClient.

2026-05-14 migration to SDK-native runner (see
``docs/ARCH_AGENT_SDK_NATIVE.md``):

* CAD review (inline ``dxf_text`` / workspace ``.dxf`` token) still goes
  through the legacy ``AgentGateway`` — those tests are unchanged.
* Plain chat now goes through :func:`wfm_agents.agent.runner.run_sync` with
  :class:`PlainChatRecipe`. The legacy ``engine`` / ``mode`` request fields
  are accepted-but-ignored on this path; one warning per request is logged.

Tests that pinned the **old behaviour** of legacy engine routes (CrewAI's
``[echo]`` template, MAF / AgenticX DevUI adapter responses, etc.) are
marked ``skip`` rather than deleted — they document the abandoned contract
and will be removed alongside the ``engines/`` directory cleanup milestone.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from wfm_agents.engines.devui_engine import DevUIBridgeError, DevUIEngine
from wfm_agents.routes.chat import select_default_engine
from wfm_agents.server import create_app

_LEGACY_ENGINE_SKIP_REASON = (
    "Legacy engine route (crewai/maf/agenticx) is a no-op on the SDK-native "
    "runner; will be removed alongside engines/ cleanup."
)


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app())


def test_health(client: TestClient) -> None:
    resp = client.get("/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "version" in body


@pytest.mark.skip(reason=_LEGACY_ENGINE_SKIP_REASON)
def test_chat_echo_via_crewai_engine(client: TestClient, tmp_path: Path) -> None:
    """显式 engine=crewai 曾走 CrewAI 的固定 echo 模板（已废弃）。"""
    resp = client.post(
        "/v1/chat",
        json={
            "workspace_root": str(tmp_path),
            "message": "hello",
            "engine": "crewai",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == "assistant"
    assert "[echo]" in body["content"]
    assert "hello" in body["content"]
    assert str(tmp_path.resolve()) in body["content"]
    assert body["workspace_root"] == str(tmp_path.resolve())
    assert body.get("trace_id")


def test_chat_rejects_missing_workspace(client: TestClient, tmp_path: Path) -> None:
    missing = tmp_path / "nope"
    resp = client.post(
        "/v1/chat",
        json={"workspace_root": str(missing), "message": "hi"},
    )
    assert resp.status_code == 400


@pytest.mark.skip(reason=_LEGACY_ENGINE_SKIP_REASON)
def test_chat_echo_mode_explicit_via_crewai(client: TestClient, tmp_path: Path) -> None:
    resp = client.post(
        "/v1/chat",
        json={
            "workspace_root": str(tmp_path),
            "message": "explicit",
            "mode": "echo",
            "engine": "crewai",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "[echo]" in body["content"]
    assert "explicit" in body["content"]


# --- 默认引擎切换回归（2026-05 切到 openai） ---


def test_default_engine_is_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WFM_DEFAULT_ENGINE", raising=False)
    assert select_default_engine() == "openai"


def test_default_engine_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WFM_DEFAULT_ENGINE", "crewai")
    assert select_default_engine() == "crewai"
    monkeypatch.setenv("WFM_DEFAULT_ENGINE", "  MAF  ")
    assert select_default_engine() == "maf"
    # 非法值回退默认
    monkeypatch.setenv("WFM_DEFAULT_ENGINE", "nope")
    assert select_default_engine() == "openai"


def test_chat_default_engine_missing_openai_key(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """默认 runner 路径下缺 API key 仍应清晰 400。"""
    monkeypatch.delenv("WFM_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    resp = client.post(
        "/v1/chat",
        json={"workspace_root": str(tmp_path), "message": "ping"},
    )
    assert resp.status_code == 400
    assert "OpenAI API Key" in resp.json()["detail"]


def _mock_run_result(text: str):
    """Build a lightweight mock that satisfies agent_v2.runner.run_chat."""
    return SimpleNamespace(final_output=text, new_items=[], raw_responses=[])


def test_chat_agent_v2_smoke(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """agent_v2 runner: mocked Runner.run_sync returns text."""
    monkeypatch.setenv("WFM_OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("WFM_AGENT_MODEL", "gpt-test")

    import agents

    monkeypatch.setattr(
        agents.Runner,
        "run_sync",
        lambda **_kw: _mock_run_result("agent_v2 ok"),
    )

    resp = client.post(
        "/v1/chat",
        json={"workspace_root": str(tmp_path), "message": "hi"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["content"] == "agent_v2 ok"


def test_chat_runner_ignores_legacy_engine_field(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:
    """Legacy ``engine`` field is accepted-but-ignored, warning gets logged."""
    import logging

    import agents

    monkeypatch.setenv("WFM_OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("WFM_AGENT_MODEL", "gpt-test")

    monkeypatch.setattr(
        agents.Runner,
        "run_sync",
        lambda **_kw: _mock_run_result("runner used"),
    )

    with caplog.at_level(logging.WARNING, logger="wfm_agents.routes.chat"):
        resp = client.post(
            "/v1/chat",
            json={
                "workspace_root": str(tmp_path),
                "message": "hi",
                "engine": "crewai",
            },
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["content"] == "runner used"
    assert any(
        "deprecated: ignoring legacy" in r.message
        for r in caplog.records
    )


@pytest.mark.skip(reason=_LEGACY_ENGINE_SKIP_REASON)
def test_chat_engine_maf_adapter(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(DevUIEngine, "_call_devui_response", lambda self, ctx: "maf-ok")
    resp = client.post(
        "/v1/chat",
        json={
            "workspace_root": str(tmp_path),
            "message": "hi",
            "engine": "maf",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["content"] == "maf-ok"


@pytest.mark.skip(reason=_LEGACY_ENGINE_SKIP_REASON)
def test_chat_engine_agenticx_minimal(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    # AgenticX now goes through the same DevUI adapter path.
    monkeypatch.setattr(DevUIEngine, "_call_devui_response", lambda self, ctx: "agenticx-ok")
    resp = client.post(
        "/v1/chat",
        json={
            "workspace_root": str(tmp_path),
            "message": "ping",
            "engine": "agenticx",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["content"] == "agenticx-ok"


@pytest.mark.skip(reason=_LEGACY_ENGINE_SKIP_REASON)
def test_chat_engine_maf_connect_error_code(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        DevUIEngine,
        "_call_devui_response",
        lambda self, ctx: (_ for _ in ()).throw(
            DevUIBridgeError("ENGINE_CONNECT_ERROR", "connect failed", status_code=502)
        ),
    )
    resp = client.post(
        "/v1/chat",
        json={
            "workspace_root": str(tmp_path),
            "message": "ping",
            "engine": "maf",
        },
    )
    assert resp.status_code == 502
    assert resp.json()["detail"].startswith("ENGINE_CONNECT_ERROR:")


@pytest.mark.skip(reason=_LEGACY_ENGINE_SKIP_REASON)
def test_chat_engine_maf_upstream_4xx_code(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        DevUIEngine,
        "_call_devui_response",
        lambda self, ctx: (_ for _ in ()).throw(
            DevUIBridgeError("ENGINE_UPSTREAM_4XX", "bad request", status_code=400)
        ),
    )
    resp = client.post(
        "/v1/chat",
        json={
            "workspace_root": str(tmp_path),
            "message": "ping",
            "engine": "maf",
        },
    )
    assert resp.status_code == 400
    assert resp.json()["detail"].startswith("ENGINE_UPSTREAM_4XX:")


@pytest.mark.skip(reason=_LEGACY_ENGINE_SKIP_REASON)
def test_chat_crewai_mode_requires_model(client: TestClient, tmp_path: Path) -> None:
    """显式 engine=crewai + mode=single 曾要求 WFM_CREWAI_MODEL（已废弃）。"""
    resp = client.post(
        "/v1/chat",
        json={
            "workspace_root": str(tmp_path),
            "message": "run crew",
            "mode": "single",
            "engine": "crewai",
        },
    )
    assert resp.status_code == 400
    assert "WFM_CREWAI_MODEL" in resp.json()["detail"]


def test_workspace_write_and_read(client: TestClient, tmp_path: Path) -> None:
    write = client.post(
        "/v1/workspace/write",
        json={
            "workspace_root": str(tmp_path),
            "path": "notes/hello.md",
            "content": "# hi\n",
        },
    )
    assert write.status_code == 200, write.text
    assert (tmp_path / "notes" / "hello.md").read_text() == "# hi\n"

    read = client.post(
        "/v1/workspace/read",
        json={"workspace_root": str(tmp_path), "path": "notes/hello.md"},
    )
    assert read.status_code == 200
    assert read.json()["content"] == "# hi\n"


def test_workspace_write_rejects_escape(client: TestClient, tmp_path: Path) -> None:
    resp = client.post(
        "/v1/workspace/write",
        json={
            "workspace_root": str(tmp_path),
            "path": "../../etc/wfm-pwn.txt",
            "content": "pwn",
        },
    )
    assert resp.status_code == 400
    assert "escape" in resp.json()["detail"]
