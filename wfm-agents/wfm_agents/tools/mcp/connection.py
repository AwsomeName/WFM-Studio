"""MCP stdio / SSE one-shot sessions (mcp package)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from mcp import ClientSession, types
from mcp.client.sse import sse_client
from mcp.client.stdio import StdioServerParameters, stdio_client

from .config import McpServerEntry

T = TypeVar("T")


async def with_mcp_session(
    server: McpServerEntry,
    fn: Callable[[ClientSession], Awaitable[T]],
) -> T:
    if server.transport == "stdio":
        if not server.command:
            msg = f"stdio mcp {server.id!r} requires 'command'"
            raise ValueError(msg)
        params = StdioServerParameters(
            command=server.command,
            args=list(server.args),
            env=server.env or None,
        )
        async with stdio_client(params) as streams:
            async with ClientSession(streams[0], streams[1]) as session:
                await session.initialize()
                return await fn(session)
    if server.transport == "sse":
        if not server.url:
            msg = f"sse mcp {server.id!r} requires 'url'"
            raise ValueError(msg)
        async with sse_client(server.url) as streams:
            async with ClientSession(streams[0], streams[1]) as session:
                await session.initialize()
                return await fn(session)
    msg = f"unknown transport: {server.transport!r}"
    raise ValueError(msg)


def mcp_result_to_data(result: types.CallToolResult) -> dict[str, Any]:
    return {
        "isError": result.isError,
        "content": [c.model_dump(mode="json", exclude_none=True) for c in result.content],
    }


def run_mcp_coro_in_thread(
    coro: Awaitable[T], *, thread_timeout_sec: float | None = None
) -> T:
    """Run async MCP call from sync code (MCP list/call) without a nested event loop on main."""
    import concurrent.futures

    def _runner() -> T:
        async def _go() -> T:
            if thread_timeout_sec is not None:
                return await asyncio.wait_for(coro, timeout=thread_timeout_sec)
            return await coro  # type: ignore[misc]

        return asyncio.run(_go())

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        return ex.submit(_runner).result()
