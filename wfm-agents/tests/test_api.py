"""End-to-end HTTP tests using FastAPI TestClient."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wfm_agents.engines.devui_engine import DevUIBridgeError, DevUIEngine
from wfm_agents.server import create_app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app())


def test_health(client: TestClient) -> None:
    resp = client.get("/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "version" in body


def test_chat_echo(client: TestClient, tmp_path: Path) -> None:
    resp = client.post(
        "/v1/chat",
        json={"workspace_root": str(tmp_path), "message": "hello"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == "assistant"
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


def test_chat_echo_mode_explicit(client: TestClient, tmp_path: Path) -> None:
    resp = client.post(
        "/v1/chat",
        json={
            "workspace_root": str(tmp_path),
            "message": "explicit",
            "mode": "echo",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "[echo]" in body["content"]
    assert "explicit" in body["content"]


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


def test_chat_crewai_mode_requires_model(client: TestClient, tmp_path: Path) -> None:
    resp = client.post(
        "/v1/chat",
        json={
            "workspace_root": str(tmp_path),
            "message": "run crew",
            "mode": "single",
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
