#!/usr/bin/env bash
# WFM Studio — 一键重启 IDE（保留 watch 增量编译）
#
# 我们这次大量改了 main 进程文件（app.ts / windowsMainService.ts /
# chat.contribution.ts ...），main 进程代码只在 Electron 启动时加载一次，
# 所以光靠 npm run watch 增量编译是不够的，必须重启 Electron 主进程。
#
# 默认行为：
#   1) 杀掉运行中的 WFM Studio Electron 进程（含 main / helper 子进程）
#   2) 保留还活着的 npm run watch（节省一次几分钟的全量编译）
#   3) 调用 ./scripts/dev.sh 重新拉起 IDE（watch 复用 / 不在则一并起）
#
# 用法：
#   ./scripts/dev-restart.sh                  轻量重启（默认，保留 watch）
#   ./scripts/dev-restart.sh --full           连 watch 一起停，全量重起
#   ./scripts/dev-restart.sh --tail           重启后前台跟 watch 日志
#   ./scripts/dev-restart.sh --reset-layout   清掉 dev user-data 的 workspaceStorage
#                                             （重置 sidebar / chat 面板等 UI 布局，
#                                              不影响 settings.json / 用户设置）
#   ./scripts/dev-restart.sh -h|--help        本帮助

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.wfm-dev"
PID_DIR="$RUN_DIR/pids"
WATCH_PID_FILE="$PID_DIR/ide-watch.pid"

FULL=0
TAIL=0
RESET_LAYOUT=0

if [[ -t 1 ]]; then
	C_CYN=$'\e[36m'; C_GRN=$'\e[32m'; C_YLW=$'\e[33m'; C_RED=$'\e[31m'; C_RST=$'\e[0m'
else
	C_CYN=""; C_GRN=""; C_YLW=""; C_RED=""; C_RST=""
fi
log()  { printf '%s[wfm-restart]%s %s\n' "$C_CYN" "$C_RST" "$*"; }
ok()   { printf '%s[wfm-restart]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_GRN" "$*" "$C_RST"; }
warn() { printf '%s[wfm-restart]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_YLW" "$*" "$C_RST" >&2; }
err()  { printf '%s[wfm-restart]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_RED" "$*" "$C_RST" >&2; }

while [[ $# -gt 0 ]]; do
	case "$1" in
		--full)         FULL=1 ;;
		--tail)         TAIL=1 ;;
		--reset-layout) RESET_LAYOUT=1 ;;
		-h|--help)      awk 'NR==1{next} /^[^#]/{exit} {sub(/^#\s?/,""); print}' "$0"; exit 0 ;;
		*) err "未知参数: $1（--help 看支持的参数）"; exit 2 ;;
	esac
	shift
done

# ───────── 第 1 步：停掉所有运行中的 IDE Electron 进程 ─────────
# 命中范围（按可执行文件路径精确匹配，避免误杀别的 Electron 应用）：
#   - 主进程： .build/electron/WFM Studio.app/Contents/MacOS/WFM Studio
#   - Helper：  .../WFM Studio Helper.app/Contents/MacOS/...
#   - Linux：    .build/electron/code-oss
#   - 同时清理还在前台等 IDE 退出的旧 dev.sh / code.sh 包装脚本
PATTERNS=(
	"wfm-ide/\.build/electron/.*WFM Studio"
	"wfm-ide/\.build/electron/code-oss"
	"wfm-ide/scripts/code\.sh"
	"$ROOT_DIR/scripts/dev\.sh"
)

log "停掉运行中的 IDE 进程..."
killed=0
for pat in "${PATTERNS[@]}"; do
	if pgrep -f "$pat" >/dev/null 2>&1; then
		pkill -TERM -f "$pat" 2>/dev/null || true
		killed=1
	fi
done

if [[ $killed -eq 1 ]]; then
	# 给 Electron 一秒优雅退出，剩下的 KILL
	sleep 1
	for pat in "${PATTERNS[@]}"; do
		pkill -KILL -f "$pat" 2>/dev/null || true
	done
	ok "IDE 进程已停止"
else
	log "未发现运行中的 IDE 进程"
fi

# ───────── 第 2 步：可选 —— 把 watch 也停掉 ─────────
if [[ $FULL -eq 1 ]]; then
	log "--full: 停掉 watch"
	if [[ -x "$ROOT_DIR/scripts/dev-stop.sh" ]]; then
		"$ROOT_DIR/scripts/dev-stop.sh" || true
	fi
fi

# ───────── 第 2.5 步：可选 —— 清 dev user-data 的 workspaceStorage ─────────
# dev 模式默认 user-data-dir = ~/Library/Application Support/code-oss-dev (mac)
# / ~/.config/Code - OSS Dev (linux)。清掉 workspaceStorage 子目录 = 让所有
# workspace 的 sidebar / panel / view layout 重置，但保留 settings.json / 主题等。
if [[ $RESET_LAYOUT -eq 1 ]]; then
	if [[ "$OSTYPE" == "darwin"* ]]; then
		DEV_USER_DATA="$HOME/Library/Application Support/code-oss-dev"
	else
		DEV_USER_DATA="$HOME/.config/Code - OSS Dev"
	fi
	WS_STORAGE_DIR="$DEV_USER_DATA/User/workspaceStorage"
	GLOBAL_STORAGE_FILE="$DEV_USER_DATA/User/globalStorage/state.vscdb"
	log "--reset-layout: 清 workspace 布局缓存"
	if [[ -d "$WS_STORAGE_DIR" ]]; then
		rm -rf "$WS_STORAGE_DIR"
		ok "  → 已删除 $WS_STORAGE_DIR"
	else
		log "  → workspaceStorage 目录不存在，跳过"
	fi
	# 全局 storage 里也可能存了上次 sessions window 残留的 sidebar 状态。
	# 备份后删除当前 db，让 vscode 重新生成；用户配置仍来自 settings.json。
	if [[ -f "$GLOBAL_STORAGE_FILE" ]]; then
		mv "$GLOBAL_STORAGE_FILE" "$GLOBAL_STORAGE_FILE.bak.$(date +%s)" || true
		ok "  → 已备份并重置 $GLOBAL_STORAGE_FILE"
	fi
fi

# ───────── 第 3 步：判断 watch 是否还活着 ─────────
WATCH_ALIVE=0
if [[ -f "$WATCH_PID_FILE" ]]; then
	wpid=$(cat "$WATCH_PID_FILE" 2>/dev/null || echo "")
	if [[ -n "$wpid" ]] && kill -0 "$wpid" 2>/dev/null; then
		WATCH_ALIVE=1
	fi
fi

# ───────── 第 4 步：调用 dev.sh 拉起 IDE ─────────
# 注意：set -u 下空数组 ${arr[@]} 展开会触发 "unbound variable"，
# 老 bash（macOS 自带的 3.2）无解；这里用显式分支组合命令行避免空数组展开。
if [[ $WATCH_ALIVE -eq 1 ]]; then
	ok "watch 仍在运行 (pid=$(cat "$WATCH_PID_FILE"))，本次只重启 IDE"
	if [[ $TAIL -eq 1 ]]; then
		exec "$ROOT_DIR/scripts/dev.sh" --no-watch --tail
	else
		exec "$ROOT_DIR/scripts/dev.sh" --no-watch
	fi
else
	log "watch 不在运行，dev.sh 将一并启动"
	if [[ $TAIL -eq 1 ]]; then
		exec "$ROOT_DIR/scripts/dev.sh" --tail
	else
		exec "$ROOT_DIR/scripts/dev.sh"
	fi
fi
