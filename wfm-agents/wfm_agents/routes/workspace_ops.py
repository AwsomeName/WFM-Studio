"""Workspace file operations.

HTTP layer stays thin; shared I/O lives in `fs_ops`.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import fs_ops
from ..workspace import WorkspaceViolation, resolve_within, resolve_workspace_root

router = APIRouter(prefix="/v1/workspace", tags=["workspace"])


class WriteRequest(BaseModel):
    workspace_root: str = Field(..., description="Absolute workspace root.")
    path: str = Field(..., description="Path relative to workspace_root.")
    content: str = Field(..., description="UTF-8 text content to write.")
    overwrite: bool = Field(True, description="Whether to overwrite existing files.")


class WriteReply(BaseModel):
    written_path: str
    bytes_written: int


class ReadRequest(BaseModel):
    workspace_root: str
    path: str


class ReadReply(BaseModel):
    path: str
    content: str


@router.post("/write", response_model=WriteReply)
async def write(req: WriteRequest) -> WriteReply:
    try:
        root = resolve_workspace_root(req.workspace_root)
    except WorkspaceViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    root_s = str(root)
    try:
        result = fs_ops.write_text(
            root_s,
            req.path,
            req.content,
            overwrite=req.overwrite,
        )
    except WorkspaceViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return WriteReply(written_path=result.written_path, bytes_written=result.bytes_written)


@router.post("/read", response_model=ReadReply)
async def read(req: ReadRequest) -> ReadReply:
    try:
        root = resolve_workspace_root(req.workspace_root)
    except WorkspaceViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    root_s = str(root)
    try:
        content = fs_ops.read_text(root_s, req.path)
        target = resolve_within(root_s, req.path)
    except WorkspaceViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except IsADirectoryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return ReadReply(path=str(target), content=content)
