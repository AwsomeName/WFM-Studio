#!/usr/bin/env bash
# WFM Studio — 一键开发启动器
#
# 默认行为：后台拉起 (1) wfm-agents 后端 + (2) wfm-ide 增量编译 + (3) OSS IDE。
# 脚本在启动成功后会退出，不会自动杀掉后台进程；停止请用 ./scripts/dev-stop.sh。
#
# 用法：
#   ./scripts/dev.sh                 一键全套
#   ./scripts/dev.sh --no-ide        只起后端 + watch（常用于后端调试）
#   ./scripts/dev.sh --no-watch      只起后端 + IDE（watch 已在另一个终端跑）
#   ./scripts/dev.sh --no-backend    只起 watch + IDE（后端你自己维护）
#   ./scripts/dev.sh --kill-port     如果 8765 被占，强杀后再启
#   ./scripts/dev.sh --port 8766     用别的端口启后端（前端默认写死 8765，别乱改）
#   ./scripts/dev.sh --tail          持续前台跟踪后台 log（Ctrl+C 停全部）
#   ./scripts/dev.sh -h | --help     本帮助
#
# 日志 / PID 文件统一在 .wfm-dev/ 下（已在根 .gitignore 排除）。

set -euo pipefail

# ───────── 路径常量 ─────────
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="$ROOT_DIR/wfm-agents"
IDE_DIR="$ROOT_DIR/wfm-ide"
RUN_DIR="$ROOT_DIR/.wfm-dev"
LOG_DIR="$RUN_DIR/logs"
PID_DIR="$RUN_DIR/pids"

AGENTS_LOG="$LOG_DIR/agents.log"
WATCH_LOG="$LOG_DIR/ide-watch.log"
IDE_LOG="$LOG_DIR/ide.log"
AGENTS_PID="$PID_DIR/agents.pid"
WATCH_PID="$PID_DIR/ide-watch.pid"

BACKEND_HOST="127.0.0.1"   # 固定 IPv4，避免 macOS localhost→::1 把 Electron net 打挂
BACKEND_PORT="${BACKEND_PORT:-8765}"

LAUNCH_BACKEND=1
LAUNCH_WATCH=1
LAUNCH_IDE=1
KILL_PORT=0
TAIL_LOGS=0

# ───────── 颜色 ─────────
if [[ -t 1 ]]; then
	C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YLW=$'\e[33m'; C_CYN=$'\e[36m'; C_DIM=$'\e[2m'; C_RST=$'\e[0m'
else
	C_RED=""; C_GRN=""; C_YLW=""; C_CYN=""; C_DIM=""; C_RST=""
fi

log()  { printf '%s[wfm-dev]%s %s\n' "$C_CYN" "$C_RST" "$*"; }
ok()   { printf '%s[wfm-dev]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_GRN" "$*" "$C_RST"; }
warn() { printf '%s[wfm-dev]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_YLW" "$*" "$C_RST" >&2; }
err()  { printf '%s[wfm-dev]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_RED" "$*" "$C_RST" >&2; }

# ───────── 参数解析 ─────────
while [[ $# -gt 0 ]]; do
	case "$1" in
		--no-backend)  LAUNCH_BACKEND=0 ;;
		--no-watch)    LAUNCH_WATCH=0 ;;
		--no-ide)      LAUNCH_IDE=0 ;;
		--kill-port)   KILL_PORT=1 ;;
		--port)        BACKEND_PORT="${2:?--port 需要一个端口号}"; shift ;;
		--tail)        TAIL_LOGS=1 ;;
		-h|--help)     awk 'NR==1{next} /^[^#]/{exit} {sub(/^#\s?/,""); print}' "$0"; exit 0 ;;
		*) err "未知参数: $1（--help 看支持的参数）"; exit 2 ;;
	esac
	shift
done

mkdir -p "$LOG_DIR" "$PID_DIR"

# ───────── 依赖检查 ─────────
require() {
	command -v "$1" >/dev/null 2>&1 || { err "缺少命令: $1 ($2)"; exit 1; }
}

require curl   "系统自带 curl 不应缺失"
require lsof   "系统自带 lsof 不应缺失"
[[ $LAUNCH_BACKEND -eq 1 ]] && require uv  "安装: curl -LsSf https://astral.sh/uv/install.sh | sh"
[[ $LAUNCH_WATCH -eq 1 || $LAUNCH_IDE -eq 1 ]] && require npm  "安装 Node 22 (见 wfm-ide/.nvmrc)"

# ───────── 端口冲突处理 ─────────
port_pids() {
	lsof -ti "tcp:$BACKEND_PORT" -sTCP:LISTEN 2>/dev/null || true
}

if [[ $LAUNCH_BACKEND -eq 1 ]]; then
	existing="$(port_pids)"
	if [[ -n "$existing" ]]; then
		if [[ $KILL_PORT -eq 1 ]]; then
			warn "端口 $BACKEND_PORT 被 pid=$existing 占用，按 --kill-port 强杀"
			# shellcheck disable=SC2086
			kill $existing 2>/dev/null || true
			sleep 1
			still="$(port_pids)"
			if [[ -n "$still" ]]; then
				# shellcheck disable=SC2086
				kill -9 $still 2>/dev/null || true
				sleep 1
			fi
		else
			err "端口 $BACKEND_PORT 已被占用 (pid=$existing)"
			err "提示：重跑时加 --kill-port 强杀，或加 --no-backend 复用已在跑的后端"
			exit 1
		fi
	fi
fi

# ───────── 子进程跟踪 & 清理 ─────────
CHILDREN=()
TAIL_PIDS=()
STARTUP_DONE=0

cleanup() {
	local ec=$?
	log "收尾中 (exit=$ec) ..."
	# 先 SIGTERM 子进程 + 它们的直接后代（处理 uvicorn --reload 的 worker、npm→node→gulp 链）
	for pid in "${CHILDREN[@]:-}"; do
		if kill -0 "$pid" 2>/dev/null; then
			pkill -TERM -P "$pid" 2>/dev/null || true
			kill -TERM "$pid" 2>/dev/null || true
		fi
	done
	sleep 1
	for pid in "${CHILDREN[@]:-}"; do
		if kill -0 "$pid" 2>/dev/null; then
			pkill -KILL -P "$pid" 2>/dev/null || true
			kill -KILL "$pid" 2>/dev/null || true
		fi
	done
	rm -f "$AGENTS_PID" "$WATCH_PID"
	log "done."
}

cleanup_tails() {
	for pid in "${TAIL_PIDS[@]:-}"; do
		kill -TERM "$pid" 2>/dev/null || true
	done
}

on_exit() {
	local ec=$?
	# 只在启动失败时自动清理；正常成功退出时保留后台进程。
	if [[ $ec -ne 0 || $STARTUP_DONE -eq 0 ]]; then
		cleanup
	else
		cleanup_tails
	fi
}

on_signal() {
	cleanup_tails
	cleanup
	exit 130
}

trap on_exit EXIT
trap on_signal INT TERM

# ───────── 1. 后端 ─────────
if [[ $LAUNCH_BACKEND -eq 1 ]]; then
	log "同步后端依赖 (uv sync --extra dev) ..."
	( cd "$AGENTS_DIR" && uv sync --extra dev ) >>"$AGENTS_LOG" 2>&1 \
		|| { err "uv sync 失败，详见 $AGENTS_LOG"; tail -n 40 "$AGENTS_LOG" >&2; exit 1; }

	log "启动后端 http://${BACKEND_HOST}:${BACKEND_PORT} (log: $AGENTS_LOG)"
	(
		cd "$AGENTS_DIR"
		exec uv run uvicorn wfm_agents.server:app --reload \
			--host "$BACKEND_HOST" --port "$BACKEND_PORT"
	) >>"$AGENTS_LOG" 2>&1 &
	BE_PID=$!
	echo "$BE_PID" > "$AGENTS_PID"
	CHILDREN+=("$BE_PID")

	log "等待 /v1/health ..."
	ready=0
	for _ in $(seq 1 30); do
		if curl -sfo /dev/null "http://${BACKEND_HOST}:${BACKEND_PORT}/v1/health"; then
			ready=1; break
		fi
		if ! kill -0 "$BE_PID" 2>/dev/null; then
			err "后端进程已退出，log 尾部："
			tail -n 40 "$AGENTS_LOG" >&2
			exit 1
		fi
		sleep 1
	done
	if [[ $ready -ne 1 ]]; then
		err "后端 30s 内未就绪，log 尾部："
		tail -n 40 "$AGENTS_LOG" >&2
		exit 1
	fi
	ok "后端就绪 (pid=$BE_PID)"
else
	log "跳过后端 (--no-backend)"
fi

# ───────── 2. IDE 增量编译 ─────────
if [[ $LAUNCH_WATCH -eq 1 ]]; then
	log "启动 IDE watch (log: $WATCH_LOG) — 首次编译要几分钟，耐心等"
	: > "$WATCH_LOG"
	(
		cd "$IDE_DIR"
		exec npm run watch
	) >>"$WATCH_LOG" 2>&1 &
	W_PID=$!
	echo "$W_PID" > "$WATCH_PID"
	CHILDREN+=("$W_PID")

	log "等待首次编译完成（日志里的 'Finished compilation'）..."
	start_ts=$SECONDS
	while :; do
		if grep -q "Finished compilation" "$WATCH_LOG" 2>/dev/null; then
			ok "watch 就绪 (pid=$W_PID, 耗时 $((SECONDS - start_ts))s)"
			break
		fi
		if ! kill -0 "$W_PID" 2>/dev/null; then
			err "watch 进程已退出，log 尾部："
			tail -n 40 "$WATCH_LOG" >&2
			exit 1
		fi
		if (( SECONDS - start_ts > 900 )); then
			err "watch 15 分钟还没出 'Finished compilation'，去 $WATCH_LOG 看看"
			exit 1
		fi
		sleep 3
	done
else
	log "跳过 watch (--no-watch)"
fi

# ───────── 可选：把后台 log 串到前台 ─────────
if [[ $TAIL_LOGS -eq 1 ]]; then
	if [[ $LAUNCH_BACKEND -eq 1 ]]; then
		( tail -n 0 -F "$AGENTS_LOG" 2>/dev/null | sed "s/^/${C_DIM}[agents]${C_RST} /" ) &
		TAIL_PIDS+=("$!")
	fi
	if [[ $LAUNCH_WATCH -eq 1 ]]; then
		( tail -n 0 -F "$WATCH_LOG" 2>/dev/null | sed "s/^/${C_DIM}[watch ]${C_RST} /" ) &
		TAIL_PIDS+=("$!")
	fi
fi

# ───────── 3. OSS IDE ─────────
if [[ $LAUNCH_IDE -eq 1 ]]; then
	log "启动 IDE (wfm-ide/scripts/code.sh，日志镜像到 $IDE_LOG)"
	log "  → 启动后后台进程保持运行；停服务请执行 ./scripts/dev-stop.sh"
	(
		cd "$IDE_DIR"
		exec ./scripts/code.sh
	) 2>&1 | tee "$IDE_LOG" || true
else
	log "跳过 IDE (--no-ide)"
fi

STARTUP_DONE=1
log "启动完成：agents pid=$(cat "$AGENTS_PID" 2>/dev/null || echo '-')，watch pid=$(cat "$WATCH_PID" 2>/dev/null || echo '-')"
log "停止命令：./scripts/dev-stop.sh"

if [[ $TAIL_LOGS -eq 1 ]]; then
	log "正在前台跟踪日志，按 Ctrl+C 停止全部"
	while :; do sleep 3600; done
fi
