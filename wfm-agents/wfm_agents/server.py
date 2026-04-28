"""FastAPI application entry point for wfm-agents."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .routes import admin, chat, chat_stream, health, workspace_ops


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
    app.include_router(workspace_ops.router)
    app.include_router(admin.router)

    return app


app = create_app()
