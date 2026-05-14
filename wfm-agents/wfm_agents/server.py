"""FastAPI application entry point for wfm-agents."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .routes import admin, cad_review, chat, chat_stream, health, workspace_ops

_log = logging.getLogger(__name__)


def _load_env_file() -> None:
    """启动时加载 wfm-agents/.env（如存在）。

    使用 python-dotenv 时遵循其 ``override=False`` 默认：**shell env 优先**，
    保证生产/容器场景能用 env var 覆盖本地 .env。缺包则静默跳过（仅依赖
    shell env 也能跑）。
    """
    try:
        from dotenv import load_dotenv  # noqa: PLC0415
    except ImportError:
        return
    pkg_dir = Path(__file__).resolve().parent
    candidates = [
        pkg_dir.parent / ".env",  # wfm-agents/.env（推荐位置）
        pkg_dir.parent.parent / ".env",  # 仓库根 .env（备用）
    ]
    for env_path in candidates:
        if env_path.is_file():
            load_dotenv(env_path, override=False)
            _log.info("loaded env from %s", env_path)
            break


_load_env_file()


def create_app() -> FastAPI:
    app = FastAPI(
        title="WFM Agents",
        version=__version__,
        description="WFM Studio backend (Phase 3-Alpha minimal skeleton).",
    )

    # The Electron renderer loads from a `vscode-file://` origin; during local
    # dev we allow any origin. This should be tightened when we move to
    # Electron-managed subprocess + localhost-only binding.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(chat.router)
    app.include_router(chat_stream.router)
    app.include_router(cad_review.router)
    app.include_router(workspace_ops.router)
    app.include_router(admin.router)

    return app


app = create_app()
