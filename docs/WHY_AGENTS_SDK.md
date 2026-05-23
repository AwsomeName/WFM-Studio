# Why We Migrated to OpenAI Agents SDK

> ⚠️ **状态：已废弃（DEPRECATED, 2026-05-22）**
>
> 后端已从 OpenAI Agents SDK 迁移至 **Claude Code CLI + MCP 工具服务器**。本文仅作历史记录保留。
>
> 当前架构：`agent_v2/claude_runner.py` 通过子进程调用 `claude` CLI，工具通过 MCP 协议暴露（`wfm_mcp_server.py`）。所有 Agent 定义、Handoff 逻辑、`@function_tool`、`OpenAIProvider` 已移除。详见 [`wfm-agents/README.md`](../wfm-agents/README.md)。

## The Problem

WFM Studio's original agent layer (`wfm_agents/agent/`) was a hand-rolled
runner with its own recipe system, tool adapter, session store, and event
encoder. While functional, it had several drawbacks:

- **Custom orchestration loop** — the runner reimplemented turn management,
  tool-call dispatch, and streaming framing that every agent framework
  provides out of the box.
- **Tight coupling to one API shape** — the code spoke OpenAI Chat Completions
  directly, making it hard to switch models or test with the Responses API.
- **No structured output support** — CAD review needed JSON output, but the
  hand-rolled runner had no `output_type` mechanism; validation was ad-hoc.
- **Parallel maintenance** — every new capability (streaming, tool-use,
  guardrails) required writing orchestration code instead of declaring intent.

## The Solution: OpenAI Agents SDK

We replaced the custom runner with the [OpenAI Agents
SDK](https://github.com/openai/openai-agents-python), which gives us:

| Concern | Before (custom) | After (Agents SDK) |
|---|---|---|
| Agent definition | `Recipe` dataclass + runner switch | `Agent(name, instructions, tools)` |
| Tool registration | `ToolProvider` / `ToolSpec` adapter | `@function_tool` decorator |
| Sync execution | `runner.run_sync()` hand-coded loop | `Runner.run_sync()` |
| Streaming | Custom SSE encoder + async gen | `Runner.run_streamed()` + `stream_events()` |
| Config / model | `AgentConfig` dataclass | `RunConfig` + `OpenAIProvider` |
| Context passing | `SessionContext` dict | `RunContextWrapper[T]` typed context |
| Guardrails | None | Input/output guardrails (future) |

## Migration Path

1. **Step 2 (PoC)** — built `wfm_agents/agent_v2/` alongside the old runner,
   verified plain chat, tool calls, and CAD review end-to-end.
2. **Step 3 (cutover)** — switched `/v1/chat`, `/v1/chat/stream`,
   `/v1/cad/review` to agent_v2, deleted old runner code.

## What We Kept

- `wfm_agents/agent/config.py` — env-var config loading (API key, base URL,
  model, temperature). The SDK's `OpenAIProvider` consumes these values.
- All route handler contracts (`ChatRequest`, `ChatReply`, SSE wire format)
  are unchanged — the front-end needs zero modifications.

## GLM-5.1 Compatibility Notes

GLM-5.1 wraps JSON output in markdown code fences (` ```json...``` `),
which breaks the SDK's built-in `output_type` parsing. We work around this
with a manual `_parse_cad_review()` that strips fences before schema
validation. If a future model supports clean JSON output, we can re-enable
`output_type=CadReviewReport` on the agent definition.
