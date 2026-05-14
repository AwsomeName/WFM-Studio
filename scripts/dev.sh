#!/usr/bin/env bash
# WFM Studio — 一键开发启动器
#
# 默认行为：后台拉起 (1) wfm-agents 后端 + (2) AgenticX/MAF DevUI + (3) wfm-ide 增量编译 + (4) OSS IDE（Electron 工作台）。
# 脚本在启动成功后会退出，不会自动杀掉后台进程；停止请用 ./scripts/dev-stop.sh。
#
# 后端引擎（2026-05 已切到 openai 兼容上游，详见 docs/PLAN.md §8 与 wfm-agents/README.md）：
#   - 默认引擎 openai，由 wfm-agents/.env 配置 base_url + model + api_key
#   - 首次运行：`cp wfm-agents/.env.example wfm-agents/.env` 并填入 WFM_OPENAI_API_KEY
#   - 默认链路 DashScope + glm-5.1；要切 DeepSeek / 官方 OpenAI 改 .env 即可
#
# 用法：
#   ./scripts/dev.sh                 一键全套（工作台 + 后端 + DevUI）
#   ./scripts/dev-minimal.sh         最小闭环（等价 --no-agent-devuis，见 docs/PLAN.md §8.3）
#   ./scripts/dev.sh --no-agent-devuis  不启 18081/18082，仅工作台 + wfm-agents
#   ./scripts/dev.sh --smoke-chat       后端就绪后对 /v1/chat 做一次零成本 echo 探测（engine=crewai）
#   ./scripts/dev.sh --smoke-chat-real  用默认引擎（openai/glm-5.1 等）真调一次 LLM 验证 .env 与 key
#   ./scripts/dev.sh --no-ide        只起后端 + DevUI + watch（常用于无界面调试）
#   ./scripts/dev.sh --no-watch      只起后端 + DevUI + IDE（watch 已在另一个终端跑）
#   ./scripts/dev.sh --no-backend    只起 DevUI + watch + IDE（8765 自行维护）
#   ./scripts/dev.sh --kill-port     如果 8765 被占，强杀后再启
#   ./scripts/dev.sh --port 8766     用别的端口启后端（前端默认写死 8765，别乱改）
#   ./scripts/dev.sh --tail          持续前台跟踪后台 log（Ctrl+C 停全部）
#   ./scripts/dev.sh -h | --help     本帮助
#
# 若要先停再启、并自动强杀占用 8765 的旧进程：./scripts/wfm-up.sh（或 scripts/wfm-up.sh）

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

AGENTICX_PORT="${AGENTICX_PORT:-18081}"
MAF_PORT="${MAF_PORT:-18082}"
AGENTICX_PY="$ROOT_DIR/third_party/agents/agenticx/python"
MAF_PY="$ROOT_DIR/third_party/agents/maf/python"
AGENTICX_ENTITIES="$AGENTICX_PY/samples/02-agents/devui"
MAF_ENTITIES="$MAF_PY/samples/02-agents/devui"
AGENTICX_LOG="$LOG_DIR/agent-stack-agenticx-devui.log"
MAF_LOG="$LOG_DIR/agent-stack-maf-devui.log"
AGENTICX_PID_FILE="$PID_DIR/agenticx-devui.pid"
MAF_PID_FILE="$PID_DIR/maf-devui.pid"

BACKEND_HOST="127.0.0.1"   # 固定 IPv4，避免 macOS localhost→::1 把 Electron net 打挂
BACKEND_PORT="${BACKEND_PORT:-8765}"

LAUNCH_BACKEND=1
LAUNCH_AGENT_DEVUIS=1
LAUNCH_WATCH=1
LAUNCH_IDE=1
KILL_PORT=0
TAIL_LOGS=0
SMOKE_CHAT=0
SMOKE_CHAT_REAL=0

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
		--no-backend)       LAUNCH_BACKEND=0 ;;
		--no-agent-devuis)  LAUNCH_AGENT_DEVUIS=0 ;;
		--no-watch)         LAUNCH_WATCH=0 ;;
		--no-ide)           LAUNCH_IDE=0 ;;
		--kill-port)   KILL_PORT=1 ;;
		--port)        BACKEND_PORT="${2:?--port 需要一个端口号}"; shift ;;
		--tail)        TAIL_LOGS=1 ;;
		--smoke-chat) SMOKE_CHAT=1 ;;
		--smoke-chat-real) SMOKE_CHAT_REAL=1 ;;
		-h|--help)     awk 'NR==1{next} /^[^#]/{exit} {sub(/^#\s?/,""); print}' "$0"; exit 0 ;;
		*) err "未知参数: $1（--help 看支持的参数）"; exit 2 ;;
	esac
	shift
done

mkdir -p "$LOG_DIR" "$PID_DIR"

if [[ ( $SMOKE_CHAT -eq 1 || $SMOKE_CHAT_REAL -eq 1 ) && $LAUNCH_BACKEND -eq 0 ]]; then
	err "--smoke-chat / --smoke-chat-real 需要启动后端（勿与 --no-backend 同时使用）"
	exit 2
fi

# ───────── 依赖检查 ─────────
require() {
	command -v "$1" >/dev/null 2>&1 || { err "缺少命令: $1 ($2)"; exit 1; }
}

require curl   "系统自带 curl 不应缺失"
require lsof   "系统自带 lsof 不应缺失"

# pip --user 安装的 uv 常不在 PATH；与 restart-agent-stack.sh 行为一致。
ensure_uv() {
	if [[ -n "${UV_EXECUTABLE:-}" ]] && [[ -x "$UV_EXECUTABLE" ]]; then
		export PATH="$(dirname "$UV_EXECUTABLE"):$PATH"
		return 0
	fi
	if command -v uv >/dev/null 2>&1; then
		return 0
	fi
	local d cand
	for d in \
		"${HOME}/.local/bin" \
		"${HOME}/Library/Python/3.13/bin" \
		"${HOME}/Library/Python/3.12/bin" \
		"${HOME}/Library/Python/3.11/bin" \
		"${HOME}/Library/Python/3.10/bin" \
		"${HOME}/Library/Python/3.9/bin" \
		/opt/homebrew/bin \
		/usr/local/bin
	do
		cand="$d/uv"
		if [[ -x "$cand" ]]; then
			export PATH="$d:$PATH"
			log "已找到 uv（此前不在 PATH）：$cand"
			return 0
		fi
	done
	return 1
}

if [[ $LAUNCH_BACKEND -eq 1 || $LAUNCH_AGENT_DEVUIS -eq 1 ]]; then
	if ! ensure_uv; then
		err "缺少命令: uv"
		err "安装: curl -LsSf https://astral.sh/uv/install.sh | sh"
		err "或：export PATH=\"\$HOME/Library/Python/3.9/bin:\$PATH\" / UV_EXECUTABLE=/path/to/uv"
		exit 1
	fi
fi
[[ $LAUNCH_WATCH -eq 1 || $LAUNCH_IDE -eq 1 ]] && require npm  "安装 Node 22 (见 wfm-ide/.nvmrc)"

kill_port_listen() {
	local port="$1"
	local name="${2:-$port}"
	local pids
	pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
	if [[ -z "$pids" ]]; then
		return 0
	fi
	warn "端口 $port ($name)：结束 pid=$pids"
	# shellcheck disable=SC2086
	kill $pids 2>/dev/null || true
	sleep 1
	pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
	if [[ -n "$pids" ]]; then
		# shellcheck disable=SC2086
		kill -9 $pids 2>/dev/null || true
		sleep 1
	fi
}

health_wait() {
	local url="$1"
	local label="$2"
	local max="${3:-30}"
	local i
	for ((i = 1; i <= max; i++)); do
		if curl -sfo /dev/null "$url"; then
			ok "$label 就绪"
			return 0
		fi
		sleep 1
	done
	err "超时: $label ($url)"
	return 1
}

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
			err "提示：./scripts/dev-stop.sh（可停 dev 与 agent-stack 写的进程）或加 --kill-port 强杀，或 --no-backend 复用已在跑的后端"
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
	rm -f "$AGENTS_PID" "$WATCH_PID" "$AGENTICX_PID_FILE" "$MAF_PID_FILE"
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
	# .env 检查（默认引擎 openai 没 key 会 400；提示但不阻断，方便 --smoke-chat 走 crewai echo）
	if [[ ! -f "$AGENTS_DIR/.env" ]]; then
		warn "未找到 $AGENTS_DIR/.env"
		warn "默认引擎为 openai，缺 WFM_OPENAI_API_KEY 时所有真模型调用都会返回 400。"
		warn "首次配置：cp $AGENTS_DIR/.env.example $AGENTS_DIR/.env && \$EDITOR $AGENTS_DIR/.env"
	fi

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

	# --smoke-chat：零成本 echo 探针（强制 engine=crewai，走 CrewAIEngine 的纯字符串拼接，不调真模型）
	if [[ $SMOKE_CHAT -eq 1 ]]; then
		SMOKE_WS="$(mktemp -d)"
		SMOKE_JSON="$(mktemp)"
		SMOKE_OUT="$(mktemp)"
		printf '{"workspace_root":"%s","message":"ping","engine":"crewai"}' "$SMOKE_WS" >"$SMOKE_JSON"
		http_code=""
		if ! http_code="$(curl -sS --max-time 20 -o "$SMOKE_OUT" -w "%{http_code}" \
				-X POST "http://${BACKEND_HOST}:${BACKEND_PORT}/v1/chat" \
				-H "Content-Type: application/json" \
				--data-binary @"$SMOKE_JSON")"; then
			http_code="000"
		fi
		rm -f "$SMOKE_JSON"
		rm -rf "$SMOKE_WS"
		if [[ "$http_code" == "200" ]]; then
			ok "smoke: POST /v1/chat echo 成功 (http=$http_code, engine=crewai)"
			rm -f "$SMOKE_OUT"
		else
			err "smoke: POST /v1/chat 失败 (http=$http_code)，响应体："
			cat "$SMOKE_OUT" >&2 || true
			rm -f "$SMOKE_OUT"
			exit 1
		fi
	fi

	# --smoke-chat-real：用默认引擎（openai/glm-5.1 等）真调一次 LLM；验证 .env 与 API key
	if [[ $SMOKE_CHAT_REAL -eq 1 ]]; then
		SMOKE_WS="$(mktemp -d)"
		SMOKE_JSON="$(mktemp)"
		SMOKE_OUT="$(mktemp)"
		printf '{"workspace_root":"%s","message":"用一句话告诉我你是谁"}' "$SMOKE_WS" >"$SMOKE_JSON"
		http_code=""
		if ! http_code="$(curl -sS --max-time 90 -o "$SMOKE_OUT" -w "%{http_code}" \
				-X POST "http://${BACKEND_HOST}:${BACKEND_PORT}/v1/chat" \
				-H "Content-Type: application/json" \
				--data-binary @"$SMOKE_JSON")"; then
			http_code="000"
		fi
		rm -f "$SMOKE_JSON"
		rm -rf "$SMOKE_WS"
		if [[ "$http_code" == "200" ]]; then
			ok "smoke-real: POST /v1/chat 真模型回包 (http=$http_code)"
			log "  响应预览: $(head -c 240 "$SMOKE_OUT")"
			rm -f "$SMOKE_OUT"
		else
			err "smoke-real: POST /v1/chat 失败 (http=$http_code)，响应体："
			cat "$SMOKE_OUT" >&2 || true
			rm -f "$SMOKE_OUT"
			err "排查提示："
			err "  1) 检查 $AGENTS_DIR/.env 是否存在并填了 WFM_OPENAI_API_KEY"
			err "  2) 检查 WFM_OPENAI_BASE_URL / WFM_OPENAI_MODEL 是否匹配上游"
			err "  3) 看 $AGENTS_LOG 的尾部错误堆栈"
			exit 1
		fi
	fi
else
	log "跳过后端 (--no-backend)"
fi

# ───────── 2. AgenticX / MAF DevUI（浏览器） ─────────
if [[ $LAUNCH_AGENT_DEVUIS -eq 1 ]]; then
	if [[ ! -d "$AGENTICX_ENTITIES" ]]; then
		err "缺少目录: $AGENTICX_ENTITIES（先 subtree 拉取 third_party/agents/agenticx）"
		exit 1
	fi
	if [[ ! -d "$MAF_ENTITIES" ]]; then
		err "缺少目录: $MAF_ENTITIES（先 subtree 拉取 third_party/agents/maf）"
		exit 1
	fi
	kill_port_listen "$AGENTICX_PORT" "agenticx-devui"
	kill_port_listen "$MAF_PORT" "maf-devui"
	rm -f "$AGENTICX_PID_FILE" "$MAF_PID_FILE"

	log "启动 AgenticX DevUI → http://${BACKEND_HOST}:${AGENTICX_PORT} (log: $AGENTICX_LOG)"
	: >"$AGENTICX_LOG"
	(
		cd "$AGENTICX_PY"
		exec uv run devui "$AGENTICX_ENTITIES" --host "$BACKEND_HOST" --port "$AGENTICX_PORT" --no-open
	) >>"$AGENTICX_LOG" 2>&1 &
	AX_PID=$!
	echo "$AX_PID" >"$AGENTICX_PID_FILE"
	CHILDREN+=("$AX_PID")
	health_wait "http://${BACKEND_HOST}:${AGENTICX_PORT}/health" "AgenticX DevUI" 60 || {
		warn "AgenticX DevUI log 尾部："
		tail -n 30 "$AGENTICX_LOG" >&2
		exit 1
	}

	log "启动 MAF DevUI → http://${BACKEND_HOST}:${MAF_PORT} (log: $MAF_LOG)"
	: >"$MAF_LOG"
	(
		cd "$MAF_PY"
		exec uv run devui "$MAF_ENTITIES" --host "$BACKEND_HOST" --port "$MAF_PORT" --no-open
	) >>"$MAF_LOG" 2>&1 &
	MF_PID=$!
	echo "$MF_PID" >"$MAF_PID_FILE"
	CHILDREN+=("$MF_PID")
	health_wait "http://${BACKEND_HOST}:${MAF_PORT}/health" "MAF DevUI" 60 || {
		warn "MAF DevUI log 尾部："
		tail -n 30 "$MAF_LOG" >&2
		exit 1
	}
else
	log "跳过 AgenticX/MAF DevUI (--no-agent-devuis)"
fi

# ───────── IDE node_modules 预检 ─────────
# npm run watch 依赖 devDependencies（如 npm-run-all2）；缺装时会在子 shell 里报 command not found。
# 此外 vscode 的 postinstall 会并发为各扩展子包装依赖，曾在 ECONNRESET 时半装；这里抽查关键扩展。
if [[ $LAUNCH_WATCH -eq 1 || $LAUNCH_IDE -eq 1 ]]; then
	if [[ ! -x "$IDE_DIR/node_modules/.bin/npm-run-all2" ]]; then
		err "wfm-ide 缺少本地依赖：未找到可执行的 node_modules/.bin/npm-run-all2"
		err "请在 $(basename "$IDE_DIR") 目录执行一次：npm ci（或 npm install）"
		err "建议 Node 版本见 $IDE_DIR/.nvmrc（当前要求见本脚本对 npm 的提示）"
		exit 1
	fi
	# watch-copilot 走 extensions/copilot/.esbuild.ts，强依赖该子包自己的 node_modules
	# （glob@11 ESM 命名导出 vs. 上层老 glob CommonJS 的不兼容会让 watch 秒退）。
	if [[ ! -d "$IDE_DIR/extensions/copilot/node_modules/glob" ]]; then
		err "wfm-ide/extensions/copilot 缺少本地依赖（glob 等）"
		err "通常是 npm ci 期间网络抖动（ECONNRESET）导致 postinstall 半装"
		err "请执行：cd $IDE_DIR/extensions/copilot && npm ci"
		exit 1
	fi
fi

# ───────── 3. IDE 增量编译 ─────────
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
	if [[ $LAUNCH_AGENT_DEVUIS -eq 1 ]]; then
		( tail -n 0 -F "$AGENTICX_LOG" 2>/dev/null | sed "s/^/${C_DIM}[ax-dui]${C_RST} /" ) &
		TAIL_PIDS+=("$!")
		( tail -n 0 -F "$MAF_LOG" 2>/dev/null | sed "s/^/${C_DIM}[mf-dui]${C_RST} /" ) &
		TAIL_PIDS+=("$!")
	fi
fi

# ───────── 4. OSS IDE ─────────
if [[ $LAUNCH_IDE -eq 1 ]]; then
	log "启动 IDE (wfm-ide/scripts/code.sh，日志镜像到 $IDE_LOG)"
	log "  → 启动后后台进程保持运行；停服务请执行 ./scripts/dev-stop.sh"
	# Cursor / vscode 调起的 shell 会注入 ELECTRON_RUN_AS_NODE=1 与一组 VSCODE_*；
	# 它们会让 Electron 二进制变回纯 Node（process.type=undefined），
	# 触发 out/main.js 的 `import { app, Menu } from 'electron'` 报 named import missing。
	# 这里清掉再 exec code.sh，保证从 cursor 内置终端跑也能正常拉起。
	(
		cd "$IDE_DIR"
		unset ELECTRON_RUN_AS_NODE VSCODE_CODE_CACHE_PATH \
			VSCODE_CRASH_REPORTER_PROCESS_TYPE VSCODE_CWD VSCODE_ESM_ENTRYPOINT \
			VSCODE_HANDLES_UNCAUGHT_ERRORS VSCODE_IPC_HOOK VSCODE_NLS_CONFIG \
			VSCODE_PID VSCODE_PROCESS_TITLE
		exec ./scripts/code.sh
	) 2>&1 | tee "$IDE_LOG" || true
else
	log "跳过 IDE (--no-ide)"
fi

STARTUP_DONE=1
log "启动完成："
if [[ $LAUNCH_BACKEND -eq 1 ]]; then
	log "  wfm-agents  pid=$(cat "$AGENTS_PID" 2>/dev/null || echo '-')  http://${BACKEND_HOST}:${BACKEND_PORT}  GET /v1/health"
fi
if [[ $LAUNCH_AGENT_DEVUIS -eq 1 ]]; then
	log "  AgenticX  pid=$(cat "$AGENTICX_PID_FILE" 2>/dev/null || echo '-')  http://${BACKEND_HOST}:${AGENTICX_PORT}"
	log "  MAF DevUI pid=$(cat "$MAF_PID_FILE" 2>/dev/null || echo '-')  http://${BACKEND_HOST}:${MAF_PORT}"
fi
log "  IDE watch pid=$(cat "$WATCH_PID" 2>/dev/null || echo '-')"
log "停止命令：./scripts/dev-stop.sh"
log ""
log "最小闭环验收（docs/PLAN.md §8.3 Step D）："
log "  1) OSS 窗口内 Cmd+O 打开本地文件夹"
log "  2) 打开侧边 WFM 聊天面板 → 发送消息 → 应看到回复与工作区路径"
log "  3) （可选终端）curl POST /v1/chat 见下方"

if [[ $LAUNCH_BACKEND -eq 1 ]]; then
	log ""
	log "终端直接测试 chat（拷贝粘贴可用）："
	log "  WS=\$(pwd)  # 或任意已存在目录"
	log "  curl -s -X POST http://${BACKEND_HOST}:${BACKEND_PORT}/v1/chat \\"
	log "    -H 'Content-Type: application/json' \\"
	log "    -d \"{\\\"workspace_root\\\":\\\"\$WS\\\",\\\"message\\\":\\\"用一句话告诉我你是谁\\\"}\" \\"
	log "    | python3 -m json.tool"
	log ""
	log "  // 强制走 CrewAI 的零成本 echo（不耗 token）："
	log "  curl -s -X POST http://${BACKEND_HOST}:${BACKEND_PORT}/v1/chat \\"
	log "    -H 'Content-Type: application/json' \\"
	log "    -d \"{\\\"workspace_root\\\":\\\"\$WS\\\",\\\"message\\\":\\\"ping\\\",\\\"engine\\\":\\\"crewai\\\"}\""
fi

if [[ $LAUNCH_AGENT_DEVUIS -eq 0 ]]; then
	log ""
	log "提示：本会话未启动 DevUI (${AGENTICX_PORT}/${MAF_PORT})；若要 engine=maf/agenticx 请加参数：./scripts/dev.sh （含默认 DevUI）"
fi
log "一键最小闭环入口：./scripts/dev-minimal.sh"

if [[ $TAIL_LOGS -eq 1 ]]; then
	log "正在前台跟踪日志，按 Ctrl+C 停止全部"
	while :; do sleep 3600; done
fi
