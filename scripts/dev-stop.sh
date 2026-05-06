#!/usr/bin/env bash
# WFM Studio — 停止 dev.sh / restart-agent-stack.sh 拉起的后台进程

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.wfm-dev/pids"
AGENTS_PID="$PID_DIR/agents.pid"
WATCH_PID="$PID_DIR/ide-watch.pid"
# dev.sh 写入（与 agent-stack 的 pids/agent-stack/ 不同）
AGENTICX_DEVUI_PID="$PID_DIR/agenticx-devui.pid"
MAF_DEVUI_PID="$PID_DIR/maf-devui.pid"
AGENT_STACK_DIR="$PID_DIR/agent-stack"
AGENT_STACK_AGENTICX_PID="$AGENT_STACK_DIR/agenticx-devui.pid"
AGENT_STACK_MAF_PID="$AGENT_STACK_DIR/maf-devui.pid"
AGENT_STACK_BACKEND_PID="$AGENT_STACK_DIR/backend.pid"

log() { printf '[wfm-dev-stop] %s\n' "$*"; }

kill_tree() {
	local pid="$1"
	if [[ -z "$pid" ]]; then
		return 0
	fi
	if ! kill -0 "$pid" 2>/dev/null; then
		return 0
	fi

	pkill -TERM -P "$pid" 2>/dev/null || true
	kill -TERM "$pid" 2>/dev/null || true
	sleep 1
	pkill -KILL -P "$pid" 2>/dev/null || true
	kill -KILL "$pid" 2>/dev/null || true
}

stopped_any=0

# restart-agent-stack.sh 写入 pids/agent-stack/，与 dev.sh 的 pids/*.pid 不同路径
if [[ -f "$AGENT_STACK_AGENTICX_PID" ]]; then
	pid="$(<"$AGENT_STACK_AGENTICX_PID")"
	log "stopping agent-stack AgenticX DevUI pid=$pid"
	kill_tree "$pid"
	rm -f "$AGENT_STACK_AGENTICX_PID"
	stopped_any=1
fi
if [[ -f "$AGENT_STACK_MAF_PID" ]]; then
	pid="$(<"$AGENT_STACK_MAF_PID")"
	log "stopping agent-stack MAF DevUI pid=$pid"
	kill_tree "$pid"
	rm -f "$AGENT_STACK_MAF_PID"
	stopped_any=1
fi
if [[ -f "$AGENT_STACK_BACKEND_PID" ]]; then
	pid="$(<"$AGENT_STACK_BACKEND_PID")"
	log "stopping agent-stack wfm-agents pid=$pid"
	kill_tree "$pid"
	rm -f "$AGENT_STACK_BACKEND_PID"
	stopped_any=1
fi

if [[ -f "$AGENTICX_DEVUI_PID" ]]; then
	pid="$(<"$AGENTICX_DEVUI_PID")"
	log "stopping dev.sh AgenticX DevUI pid=$pid"
	kill_tree "$pid"
	rm -f "$AGENTICX_DEVUI_PID"
	stopped_any=1
fi

if [[ -f "$MAF_DEVUI_PID" ]]; then
	pid="$(<"$MAF_DEVUI_PID")"
	log "stopping dev.sh MAF DevUI pid=$pid"
	kill_tree "$pid"
	rm -f "$MAF_DEVUI_PID"
	stopped_any=1
fi

if [[ -f "$AGENTS_PID" ]]; then
	pid="$(<"$AGENTS_PID")"
	log "stopping agents pid=$pid"
	kill_tree "$pid"
	rm -f "$AGENTS_PID"
	stopped_any=1
fi

if [[ -f "$WATCH_PID" ]]; then
	pid="$(<"$WATCH_PID")"
	log "stopping watch pid=$pid"
	kill_tree "$pid"
	rm -f "$WATCH_PID"
	stopped_any=1
fi

if [[ $stopped_any -eq 0 ]]; then
	log "no pid files found, nothing to stop."
else
	log "done."
fi
