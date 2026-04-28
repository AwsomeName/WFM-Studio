"""End-to-end HTTP tests using FastAPI TestClient."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

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


def test_chat_engine_maf_not_installed(client: TestClient, tmp_path: Path) -> None:
    resp = client.post(
        "/v1/chat",
        json={
            "workspace_root": str(tmp_path),
            "message": "hi",
            "engine": "maf",
        },
    )
    assert resp.status_code == 400
    assert "ENGINE_NOT_INSTALLED" in resp.json()["detail"]


def test_chat_engine_agenticx_minimal(client: TestClient, tmp_path: Path) -> None:
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
    assert "[agenticx]" in body["content"]
    assert str(tmp_path.resolve()) in body["content"]


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
