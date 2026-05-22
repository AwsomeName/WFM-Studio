"""Claude Code CLI runner — subprocess-based backend for WFM Chat.

Invokes the locally installed ``claude`` CLI with
``--output-format stream-json --verbose`` and maps the NDJSON output
to WFM's SSE event format so the IDE front-end works unchanged.

Session continuity is handled by ``--resume <session_id>``.
MCP tools (workspace, CAD, DOCX) are registered via ``--mcp-config``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from collections.abc import AsyncIterator
from pathlib import Path

from .sse import encode_sse

_log = logging.getLogger(__name__)

_SYSTEM_PROMPT = """\
You are WFM Studio's AI assistant.  You have access to WFM-specific MCP
tools (prefixed with mcp__wfm__) for reading/writing workspace files,
parsing CAD drawings (DXF/DWG), performing CAD reviews, and reading
Word documents (DOCX).

When the user asks about a CAD file, use the cad_file_read tool first
to get an overview, then drill down with cad_extract_texts,
cad_extract_dims, cad_layer_inspect, etc. as needed.

When the user asks about a Word document, use docx_read.

Always respond in the same language the user writes in (Chinese or English).
"""

# ── helpers ──────────────────────────────────────────────────────────


def _strip_mcp_prefix(name: str) -> str:
    prefix = "mcp__wfm__"
    if name.startswith(prefix):
        return name[len(prefix):]
    return name


def _build_mcp_config(workspace_root: str, cad_source_uri: str | None = None) -> str:
    env = {"WFM_WORKSPACE_ROOT": workspace_root}
    if cad_source_uri:
        env["WFM_CAD_SOURCE_URI"] = cad_source_uri
    return json.dumps(
        {
            "mcpServers": {
                "wfm": {
                    "command": sys.executable,
                    "args": ["-m", "wfm_agents.agent_v2.wfm_mcp_server"],
                    "type": "stdio",
                    "env": env,
                }
            }
        }
    )


def _summarize_output(content: str | list | None) -> str:
    if content is None:
        return ""
    text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
    if len(text) > 120:
        return text[:117] + "..."
    return text


def _extract_cad_modifications(content: str | list | None) -> list[dict] | None:
    if content is None:
        return None
    try:
        text = content if isinstance(content, str) else json.dumps(content)
        data = json.loads(text)
        if isinstance(data, dict) and "modifications" in data:
            return data["modifications"]
    except (json.JSONDecodeError, TypeError):
        pass
    return None


# ── streaming runner ─────────────────────────────────────────────────


async def run_chat_stream_claude(
    prompt: str,
    workspace_root: str,
    cad_source_uri: str | None = None,
    session_id: str | None = None,
    model: str | None = None,
) -> AsyncIterator[bytes]:
    model = model or os.getenv("WFM_CLAUDE_MODEL", "sonnet")

    args = [
        "claude",
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--system-prompt", _SYSTEM_PROMPT,
        "--mcp-config", _build_mcp_config(workspace_root, cad_source_uri),
        "--permission-mode", "bypassPermissions",
        "--model", model,
        "--max-budget-usd", "5.0",
    ]
    if session_id:
        args.extend(["--resume", session_id])

    _log.info("claude_runner: %s", " ".join(args[:6]) + " ...")

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=workspace_root,
    )
    proc.stdin.close()

    try:
        yield encode_sse({"type": "session", "session_id": session_id})

        pending_tool_names: dict[str, str] = {}

        async for line in proc.stdout:
            text = line.decode("utf-8").strip()
            if not text:
                continue
            try:
                event = json.loads(text)
            except json.JSONDecodeError:
                continue

            etype = event.get("type")

            if etype == "system" and event.get("subtype") == "init":
                sid = event.get("session_id")
                if sid:
                    yield encode_sse({"type": "session", "session_id": sid})

            elif etype == "assistant":
                for block in event.get("message", {}).get("content", []):
                    btype = block.get("type")
                    if btype == "thinking":
                        yield encode_sse({
                            "type": "thinking_delta",
                            "delta": block.get("thinking", ""),
                        })
                    elif btype == "text":
                        yield encode_sse({
                            "type": "text_delta",
                            "delta": block.get("text", ""),
                        })
                    elif btype == "tool_use":
                        tool_id = block.get("id", "")
                        raw_name = block.get("name", "")
                        tool_name = _strip_mcp_prefix(raw_name)
                        pending_tool_names[tool_id] = tool_name
                        yield encode_sse({
                            "type": "tool_call_started",
                            "id": tool_id,
                            "name": tool_name,
                            "args": json.dumps(block.get("input", {}), ensure_ascii=False),
                        })

            elif etype == "user":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "tool_result":
                        tool_id = block.get("tool_use_id", "")
                        content = block.get("content", "")
                        summary = _summarize_output(content)
                        yield encode_sse({
                            "type": "tool_call_done",
                            "id": tool_id,
                            "summary": summary,
                        })
                        if pending_tool_names.get(tool_id) == "cad_modify_colors":
                            mods = _extract_cad_modifications(content)
                            if mods:
                                yield encode_sse({
                                    "type": "cad_edit",
                                    "data": {
                                        "sourceUri": cad_source_uri,
                                        "modifications": mods,
                                        "summary": f"修改了 {len(mods)} 个实体颜色",
                                    },
                                })
                        pending_tool_names.pop(tool_id, None)

            elif etype == "result":
                if event.get("is_error"):
                    yield encode_sse({
                        "type": "error",
                        "error": event.get("result", "Unknown error"),
                    })
                else:
                    yield encode_sse({
                        "type": "done",
                        "session_id": event.get("session_id"),
                        "text": event.get("result", ""),
                    })
                break

    except asyncio.CancelledError:
        _log.info("claude_runner: stream cancelled")
    except Exception as exc:
        _log.error("claude_runner: %s", exc)
        yield encode_sse({"type": "error", "error": str(exc)})
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                proc.kill()


# ── sync runner ──────────────────────────────────────────────────────


async def run_chat_claude(
    prompt: str,
    workspace_root: str,
    cad_source_uri: str | None = None,
    session_id: str | None = None,
    model: str | None = None,
) -> str:
    final_text = ""
    async for frame in run_chat_stream_claude(
        prompt, workspace_root, cad_source_uri, session_id, model
    ):
        raw = frame.decode("utf-8")
        if not raw.startswith("data: "):
            continue
        data = json.loads(raw[6:])
        if data.get("type") == "done":
            final_text = data.get("text", "")
        elif data.get("type") == "error":
            raise RuntimeError(data.get("error", "Unknown error"))
    return final_text
