"""Shared DevUI-backed engine adapter for Agent Framework variants."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime, timezone
from os import getenv
from typing import Any, ClassVar
from urllib import error as urlerror
from urllib import request as urlrequest

from ..gateway.models import (
    DoneStreamEvent,
    ErrorStreamEvent,
    StreamEvent,
    TextDeltaStreamEvent,
    TurnResult,
)
from ..gateway.session import SessionContext
from ..observability import errors as err
from ..tools.handle import ToolHandle


class DevUIBridgeError(Exception):
    """Error raised when DevUI bridge fails with a normalized code."""

    def __init__(self, code: str, message: str, status_code: int = 502) -> None:
        self.code = code
        self.status_code = status_code
        super().__init__(message)


class DevUIEngine:
    """Calls a local Agent Framework DevUI server via OpenAI-compatible API."""

    engine_id: ClassVar[str] = "devui"
    env_base_url: ClassVar[str] = ""
    default_base_url: ClassVar[str] = "http://127.0.0.1:8080"
    env_entity_id: ClassVar[str] = ""
    default_entity_id: ClassVar[str] | None = None
    connect_timeout_s: ClassVar[float] = 8.0

    def run_turn(self, ctx: SessionContext, tools: ToolHandle) -> TurnResult:
        received_at = datetime.now(timezone.utc).isoformat()
        text = self._call_devui_response(ctx)
        return TurnResult(
            content=text,
            workspace_root=ctx.workspace_root,
            received_at=received_at,
            trace_id=ctx.trace_id,
            engine=self.engine_id,
            usage=None,
            tool_ledger=list(tools.ledger),
            finish_reason="stop",
        )

    async def stream_turn(
        self,
        ctx: SessionContext,
        tools: ToolHandle,
        *,
        tool_event_queue: asyncio.Queue[Any] | None = None,
        is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        loop = asyncio.get_running_loop()
        fut = loop.run_in_executor(None, self.run_turn, ctx, tools)
        while not fut.done():
            if is_disconnected is not None and await is_disconnected():
                ctx.cancel_event.set()
                break
            if tool_event_queue is not None:
                try:
                    raw = await asyncio.wait_for(tool_event_queue.get(), 0.05)
                    yield raw  # type: ignore[misc]
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(0.05)

        try:
            result: TurnResult = await fut
        except EngineNotInstalledError as exc:
            yield ErrorStreamEvent(
                type="error",
                code=err.ENGINE_NOT_INSTALLED,
                message=exc.hint,
                trace_id=ctx.trace_id,
            )
            return
        except Exception as exc:  # pragma: no cover - defensive
            yield ErrorStreamEvent(
                type="error",
                code=err.ENGINE_ERROR,
                message=f"{type(exc).__name__}: {exc}",
                trace_id=ctx.trace_id,
            )
            return

        if tool_event_queue is not None:
            while True:
                try:
                    raw = tool_event_queue.get_nowait()
                    yield raw  # type: ignore[misc]
                except asyncio.QueueEmpty:
                    break

        if result.content:
            yield TextDeltaStreamEvent(type="text_delta", delta=result.content)
        yield DoneStreamEvent(
            type="done",
            trace_id=ctx.trace_id,
            usage=result.usage,
            finish_reason=result.finish_reason,
        )

    def _call_devui_response(self, ctx: SessionContext) -> str:
        base_url = self._base_url()
        entity_id = self._entity_id()
        payload = {
            "metadata": {"entity_id": entity_id},
            "input": ctx.message,
        }
        req = urlrequest.Request(
            url=f"{base_url}/v1/responses",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=self.connect_timeout_s) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urlerror.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8")
            except Exception:  # pragma: no cover
                detail = str(exc)
            code = err.ENGINE_UPSTREAM_4XX if 400 <= exc.code < 500 else err.ENGINE_UPSTREAM_5XX
            status_code = 400 if 400 <= exc.code < 500 else 502
            raise DevUIBridgeError(
                code=code,
                status_code=status_code,
                message=f"{self.engine_id} DevUI 请求失败: HTTP {exc.code}: {detail}",
            ) from exc
        except urlerror.URLError as exc:
            raise DevUIBridgeError(
                code=err.ENGINE_CONNECT_ERROR,
                status_code=502,
                message=(
                    f"{self.engine_id} DevUI 不可达，请先启动服务并检查地址。"
                    f" 当前地址: {base_url}（可用 {self.env_base_url} 覆盖）"
                ),
            ) from exc

        text = self._extract_text(body)
        if text.strip():
            return text
        if body.get("error") in (None, {}):
            return (
                f"[{self.engine_id}] DevUI 实体 {entity_id!r} 返回空文本。"
                "请为该实体配置可用模型后重试。"
            )
        raise DevUIBridgeError(
            code=err.ENGINE_BAD_RESPONSE,
            status_code=502,
            message=(
                f"{self.engine_id} DevUI 返回空结果，请确认 entity_id={entity_id!r} 可用。"
                f" 可用 {self.env_entity_id} 覆盖。"
            ),
        )

    def _base_url(self) -> str:
        raw = (getenv(self.env_base_url) or self.default_base_url).strip()
        return raw.rstrip("/")

    def _entity_id(self) -> str:
        return (getenv(self.env_entity_id) or self.default_entity_id or "agent_weather").strip()

    @staticmethod
    def _extract_text(body: dict[str, Any]) -> str:
        top_level_text = body.get("output_text")
        if isinstance(top_level_text, str) and top_level_text.strip():
            return top_level_text.strip()

        output = body.get("output")
        if not isinstance(output, list):
            return ""
        chunks: list[str] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if not isinstance(part, dict):
                    continue
                text = part.get("text")
                if isinstance(text, str) and text:
                    chunks.append(text)
        return "".join(chunks).strip()
