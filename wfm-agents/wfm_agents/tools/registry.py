"""Tool registry: merge providers into a frozen per-turn snapshot (ARCH §5.4)."""

from __future__ import annotations

from typing import Any, Protocol, Sequence, runtime_checkable

from ..gateway.session import SessionContext
from .spec import ToolResult, ToolSpec


@runtime_checkable
class ToolProvider(Protocol):
    """Builtin or MCP provider: specs + synchronous execute."""

    def list_tool_specs(self, ctx: SessionContext) -> list[ToolSpec]:
        """Return tools visible for this turn (snapshot source)."""
        ...

    def execute(self, fqn: str, args: dict[str, Any], ctx: SessionContext) -> ToolResult:
        ...


class ToolRegistry:
    """Immutable mapping fqn → provider + spec for one turn."""

    def __init__(
        self,
        specs: tuple[ToolSpec, ...],
        owner_by_fqn: dict[str, ToolProvider],
    ) -> None:
        self._specs = specs
        self._owner_by_fqn = owner_by_fqn

    @staticmethod
    def build(ctx: SessionContext, providers: Sequence[ToolProvider]) -> ToolRegistry:
        specs: list[ToolSpec] = []
        owner_by_fqn: dict[str, ToolProvider] = {}
        for provider in providers:
            for spec in provider.list_tool_specs(ctx):
                if spec.fqn in owner_by_fqn:
                    msg = f"duplicate tool fqn in registry: {spec.fqn!r}"
                    raise ValueError(msg)
                specs.append(spec)
                owner_by_fqn[spec.fqn] = provider
        return ToolRegistry(tuple(specs), owner_by_fqn)

    def snapshot(self) -> tuple[ToolSpec, ...]:
        """Frozen ToolSpec list for this turn."""
        return self._specs

    def find(self, fqn: str) -> ToolSpec | None:
        for spec in self._specs:
            if spec.fqn == fqn:
                return spec
        return None

    def owner(self, fqn: str) -> ToolProvider | None:
        return self._owner_by_fqn.get(fqn)
