#!/usr/bin/env bash
# WFM Studio — 停止 dev.sh 拉起的后台进程（极简版：只剩 ide watch）

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.wfm-dev/pids"
WATCH_PID="$PID_DIR/ide-watch.pid"

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
