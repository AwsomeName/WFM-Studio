#!/usr/bin/env bash
# WFM Studio — 一键开发启动器（极简版）
#
# 后端已切到「本地 Claude Code CLI + stdio MCP」模式，无 FastAPI HTTP 服务。
# 这个脚本只负责：
#   1. wfm-ide 增量编译（npm run watch）
#   2. 拉起 OSS IDE（wfm-ide/scripts/code.sh）
#
# 用法：
#   ./scripts/dev.sh                只起 watch + IDE
#   ./scripts/dev.sh --no-ide       只起 watch（无界面调试用）
#   ./scripts/dev.sh --no-watch     只起 IDE（watch 已在另一个终端跑）
#   ./scripts/dev.sh --tail         前台跟踪 watch log（Ctrl+C 停全部）
#   ./scripts/dev.sh -h | --help    本帮助
#
# 停止：./scripts/dev-stop.sh

set -euo pipefail

# ───────── 路径常量 ─────────
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDE_DIR="$ROOT_DIR/wfm-ide"
RUN_DIR="$ROOT_DIR/.wfm-dev"
LOG_DIR="$RUN_DIR/logs"
PID_DIR="$RUN_DIR/pids"

WATCH_LOG="$LOG_DIR/ide-watch.log"
IDE_LOG="$LOG_DIR/ide.log"
WATCH_PID="$PID_DIR/ide-watch.pid"

LAUNCH_WATCH=1
LAUNCH_IDE=1
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
		--no-watch) LAUNCH_WATCH=0 ;;
		--no-ide)   LAUNCH_IDE=0 ;;
		--tail)     TAIL_LOGS=1 ;;
		-h|--help)  awk 'NR==1{next} /^[^#]/{exit} {sub(/^#\s?/,""); print}' "$0"; exit 0 ;;
		*) err "未知参数: $1（--help 看支持的参数）"; exit 2 ;;
	esac
	shift
done

mkdir -p "$LOG_DIR" "$PID_DIR"

# ───────── 依赖检查 ─────────
require() {
	command -v "$1" >/dev/null 2>&1 || { err "缺少命令: $1 ($2)"; exit 1; }
}

[[ $LAUNCH_WATCH -eq 1 || $LAUNCH_IDE -eq 1 ]] && require npm "安装 Node 22 (见 wfm-ide/.nvmrc)"

# 提醒：chat 后端依赖本地 claude CLI。缺时只 warn，不阻断启动。
if ! command -v claude >/dev/null 2>&1; then
	warn "未检测到本地 'claude' 命令；右侧对话面板将无法回复。"
	warn "安装：https://docs.claude.com/claude-code"
fi

# ───────── 子进程跟踪 & 清理 ─────────
CHILDREN=()
TAIL_PIDS=()
STARTUP_DONE=0

cleanup() {
	local ec=$?
	log "收尾中 (exit=$ec) ..."
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
	rm -f "$WATCH_PID"
	log "done."
}

cleanup_tails() {
	for pid in "${TAIL_PIDS[@]:-}"; do
		kill -TERM "$pid" 2>/dev/null || true
	done
}

on_exit() {
	local ec=$?
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

# ───────── IDE node_modules 预检 ─────────
if [[ $LAUNCH_WATCH -eq 1 || $LAUNCH_IDE -eq 1 ]]; then
	if [[ ! -x "$IDE_DIR/node_modules/.bin/npm-run-all2" ]]; then
		err "wfm-ide 缺少本地依赖：未找到可执行的 node_modules/.bin/npm-run-all2"
		err "请在 $(basename "$IDE_DIR") 目录执行一次：npm ci（或 npm install）"
		exit 1
	fi
fi

# ───────── IDE 增量编译 ─────────
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

# ───────── 可选：把 watch log 串到前台 ─────────
if [[ $TAIL_LOGS -eq 1 && $LAUNCH_WATCH -eq 1 ]]; then
	( tail -n 0 -F "$WATCH_LOG" 2>/dev/null | sed "s/^/${C_DIM}[watch ]${C_RST} /" ) &
	TAIL_PIDS+=("$!")
fi

# ───────── 强制同步 WFM 自研 webview 资源 (media/) ─────────
# watch 的 incremental 编译只搬动 .ts 出来的产物，src/**/media/*.{js,css,html,svg}
# 这类静态资源在 out/ 已存在同名旧文件时常常不会被覆盖，结果 webview 始终加载
# 旧版本（典型症状：你刚改完 webview JS 没生效）。
# 这里在 IDE 启动前用 rsync 把所有 contrib/wfm/**/media/ 强制同步到 out/。
WFM_IDE_SRC="$IDE_DIR/src/vs/workbench/contrib/wfm"
WFM_IDE_OUT="$IDE_DIR/out/vs/workbench/contrib/wfm"
if [[ -d "$WFM_IDE_SRC" && -d "$WFM_IDE_OUT" ]]; then
	log "同步 contrib/wfm/**/media/ 静态资源到 out/ ..."
	while IFS= read -r -d '' media_dir; do
		rel="${media_dir#"$WFM_IDE_SRC/"}"
		dst="$WFM_IDE_OUT/$rel"
		mkdir -p "$dst"
		rsync -a --delete \
			--exclude '*.ts' --exclude '*.tsx' \
			"$media_dir/" "$dst/"
	done < <(find "$WFM_IDE_SRC" -type d -name media -print0)
	ok "media/ 同步完成"
fi

# ───────── OSS IDE ─────────
if [[ $LAUNCH_IDE -eq 1 ]]; then
	log "启动 IDE (wfm-ide/scripts/code.sh，日志镜像到 $IDE_LOG)"
	log "  → 启动后后台进程保持运行；停服务请执行 ./scripts/dev-stop.sh"
	# Cursor / vscode 调起的 shell 会注入 ELECTRON_RUN_AS_NODE=1 与一组 VSCODE_*；
	# 它们会让 Electron 二进制变回纯 Node（process.type=undefined），
	# 触发 out/main.js 的 `import { app, Menu } from 'electron'` 报 named import missing。
	# 这里清掉再 exec code.sh，保证从 cursor 内置终端跑也能正常拉起。
	# 国内直连 github.com 经常 ECONNRESET，code.sh → preLaunch.ts → @electron/get
	# 拉 SHASUMS256.txt 会挂。这里默认走 npmmirror 镜像（含 zip + SHASUMS）。
	# 用户可在外层 export ELECTRON_MIRROR=... 覆盖。
	(
		cd "$IDE_DIR"
		unset ELECTRON_RUN_AS_NODE VSCODE_CODE_CACHE_PATH \
			VSCODE_CRASH_REPORTER_PROCESS_TYPE VSCODE_CWD VSCODE_ESM_ENTRYPOINT \
			VSCODE_HANDLES_UNCAUGHT_ERRORS VSCODE_IPC_HOOK VSCODE_NLS_CONFIG \
			VSCODE_PID VSCODE_PROCESS_TITLE
		export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://cdn.npmmirror.com/binaries/electron/}"
		exec ./scripts/code.sh
	) 2>&1 | tee "$IDE_LOG" || true
else
	log "跳过 IDE (--no-ide)"
fi

STARTUP_DONE=1
log "启动完成："
log "  IDE watch pid=$(cat "$WATCH_PID" 2>/dev/null || echo '-')"
log "停止命令：./scripts/dev-stop.sh"
log ""
log "Chat 验收："
log "  1) 在 IDE 内 Cmd+O 打开一个工作区"
log "  2) 点右侧 Chat 面板 → 发消息 → 应看到本地 claude CLI 流式回复"

if [[ $TAIL_LOGS -eq 1 ]]; then
	log "正在前台跟踪日志，按 Ctrl+C 停止全部"
	while :; do sleep 3600; done
fi
