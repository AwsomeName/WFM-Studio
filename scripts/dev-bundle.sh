#!/usr/bin/env bash
# WFM Studio — 生产 bundle 模式启动器（用于看到中文界面 / 演示 / 发布前验证）
#
# 与 ./scripts/dev.sh 的差异：
#   - dev.sh：watch 增量编译，单文件 transpile，localize() 不会被替换 → 界面永远英文（vscode 上游设计）
#   - dev-bundle.sh：先 transpile 单文件版本，再 bundle 渲染端 + nls-plugin 把 localize 替换为 index，
#                    用 production 方式启动 IDE（不设 VSCODE_DEV）→ 加载语言包 → 中文界面
#
# 流程拆解：
#   1. transpile 全量到 out/（保留 main.ts 的 dev 风格 ESM imports，否则 Electron 拒绝 bundle 后的 main.js）
#   2. bundle 到独立目录 .build/wfm-bundle/，含 NLS 替换与 nls.keys.json / nls.messages.json
#   3. 把 bundle 出的渲染端 / 扩展宿主 / worker 等覆盖到 out/，主进程 main.js / cli.js 保留 transpile 版
#   4. 同步 argv.json / languagepacks.json 到 production 数据目录
#   5. 启动 IDE（不带 VSCODE_DEV）→ bootstrap-esm 加载 NLS messages → 中文界面
#
# 用法：
#   ./scripts/dev-bundle.sh                  # 完整流程
#   ./scripts/dev-bundle.sh --skip-bundle    # 跳过编译，复用上次产物直接启动
#   ./scripts/dev-bundle.sh --no-ide         # 只编译，不启动 IDE
#   ./scripts/dev-bundle.sh --minify         # 带 minify+mangle-privates，更接近发布版
#   ./scripts/dev-bundle.sh -h | --help      # 本帮助
#
# 注意事项：
#   1. 此脚本会覆盖 wfm-ide/out/，watch 必须先停。要回 dev 模式，重新跑 ./scripts/dev.sh 即可。
#   2. 启动时不设 VSCODE_DEV=1，因此 IDE 用 ~/.vscode-oss/ 与 ~/Library/Application Support/code-oss/
#      作为数据目录（不是 -dev 后缀目录）。脚本会把 -dev 目录里的 argv.json/languagepacks.json 同步过去。
#   3. 退出 IDE 后用 ./scripts/dev-stop.sh 停后端 / DevUI（与 dev.sh 共用）。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDE_DIR="$ROOT_DIR/wfm-ide"
RUN_DIR="$ROOT_DIR/.wfm-dev"
LOG_DIR="$RUN_DIR/logs"
PID_DIR="$RUN_DIR/pids"
WATCH_PID="$PID_DIR/ide-watch.pid"

BUNDLE_LOG="$LOG_DIR/ide-bundle.log"
IDE_LOG="$LOG_DIR/ide-prod.log"

DO_BUNDLE=1
DO_LAUNCH=1
DO_MINIFY=0

if [[ -t 1 ]]; then
	C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YLW=$'\e[33m'; C_CYN=$'\e[36m'; C_RST=$'\e[0m'
else
	C_RED=""; C_GRN=""; C_YLW=""; C_CYN=""; C_RST=""
fi
log()  { printf '%s[wfm-bundle]%s %s\n' "$C_CYN" "$C_RST" "$*"; }
ok()   { printf '%s[wfm-bundle]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_GRN" "$*" "$C_RST"; }
warn() { printf '%s[wfm-bundle]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_YLW" "$*" "$C_RST" >&2; }
err()  { printf '%s[wfm-bundle]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_RED" "$*" "$C_RST" >&2; }

while [[ $# -gt 0 ]]; do
	case "$1" in
		--skip-bundle) DO_BUNDLE=0 ;;
		--no-ide)      DO_LAUNCH=0 ;;
		--minify)      DO_MINIFY=1 ;;
		-h|--help)     awk 'NR==1{next} /^[^#]/{exit} {sub(/^#\s?/,""); print}' "$0"; exit 0 ;;
		*) err "未知参数: $1（--help 看支持的参数）"; exit 2 ;;
	esac
	shift
done

mkdir -p "$LOG_DIR"

# ───────── 1. 停 watch（dev.sh 起的）─────────
if [[ -f "$WATCH_PID" ]]; then
	pid="$(<"$WATCH_PID")"
	if kill -0 "$pid" 2>/dev/null; then
		warn "检测到 watch 在跑 (pid=$pid)，bundle 会覆盖 out/，先停 watch"
		pkill -TERM -P "$pid" 2>/dev/null || true
		kill -TERM "$pid" 2>/dev/null || true
		sleep 1
		pkill -KILL -P "$pid" 2>/dev/null || true
		kill -KILL "$pid" 2>/dev/null || true
	fi
	rm -f "$WATCH_PID"
fi

# ───────── 2. 编译：transpile + bundle 合成 out/ ─────────
BUNDLE_TMP="$IDE_DIR/.build/wfm-bundle"
if [[ $DO_BUNDLE -eq 1 ]]; then
	log "step 2.1 — transpile 全量到 out/（保 main.ts dev 风格 ESM）"
	: >"$BUNDLE_LOG"
	start_ts=$SECONDS
	(
		cd "$IDE_DIR"
		exec node build/next/index.ts transpile --out out
	) >>"$BUNDLE_LOG" 2>&1 || {
		err "transpile 失败，log 尾部："
		tail -n 60 "$BUNDLE_LOG" >&2
		exit 1
	}

	log "step 2.2 — bundle 渲染端到 ${BUNDLE_TMP}（含 nls-plugin）"
	BUNDLE_ARGS=("build/next/index.ts" "bundle" "--out" ".build/wfm-bundle" "--target" "desktop" "--nls")
	if [[ $DO_MINIFY -eq 1 ]]; then
		BUNDLE_ARGS+=("--minify" "--mangle-privates")
		log "  开启 minify + mangle-privates"
	fi
	(
		cd "$IDE_DIR"
		exec node "${BUNDLE_ARGS[@]}"
	) >>"$BUNDLE_LOG" 2>&1 || {
		err "bundle 失败，log 尾部："
		tail -n 60 "$BUNDLE_LOG" >&2
		exit 1
	}

	if [[ ! -f "$BUNDLE_TMP/nls.keys.json" || ! -f "$BUNDLE_TMP/nls.messages.json" ]]; then
		err "bundle 完成但未生成 nls.keys.json / nls.messages.json"
		exit 1
	fi

	log "step 2.3 — 合并 bundle 产物到 out/（保留 transpile 版 main.js / cli.js）"
	# 拷贝 bundle 全部 .js / .css / .map / nls.* 等，但 main.js 和 cli.js 例外
	#   main.ts / cli.ts 走 transpile 单文件路径（依赖独立 vs/* .js 文件），bundle 后散落
	#   多处 `import { app } from "electron"` 在 ESM context 触发 named import 失败。
	(
		cd "$BUNDLE_TMP"
		# rsync 兼容性更好；目录拷贝时排除 main.* / cli.*
		rsync -a --exclude='main.js' --exclude='main.js.map' \
			--exclude='cli.js' --exclude='cli.js.map' \
			./ "$IDE_DIR/out/"
	) >>"$BUNDLE_LOG" 2>&1 || {
		err "rsync 合并失败，log 尾部："
		tail -n 60 "$BUNDLE_LOG" >&2
		exit 1
	}

	ok "编译完成（耗时 $((SECONDS - start_ts))s）"

	if [[ ! -f "$IDE_DIR/out/nls.keys.json" || ! -f "$IDE_DIR/out/nls.messages.json" ]]; then
		err "out/ 里仍缺 nls.keys.json / nls.messages.json"
		exit 1
	fi
else
	log "跳过编译（--skip-bundle），直接启动"
fi

# ───────── 3. 同步 argv.json / languagepacks.json 到 production 数据目录 ─────────
# 关键：production 模式的 userData 路径由 product.nameShort 决定（main.ts -> getUserDataPath）；
#       不是固定 'code-oss'。我们的 nameShort 是 "WFM Studio"，所以是 ~/Library/Application Support/WFM Studio/。
#       早期写错成 code-oss/，导致 NLS 读到空 languagepacks.json，界面 fallback 英文。
PRODUCT_NAME_SHORT=$(node -p "require('$IDE_DIR/product.json').nameShort")
ARGV_DEV="$HOME/.vscode-oss-dev/argv.json"
ARGV_PROD_DIR="$HOME/.vscode-oss"
ARGV_PROD="$ARGV_PROD_DIR/argv.json"
USER_DATA_DEV="$HOME/Library/Application Support/code-oss-dev"
USER_DATA_PROD="$HOME/Library/Application Support/$PRODUCT_NAME_SHORT"
LANGPACKS_DEV="$USER_DATA_DEV/languagepacks.json"
LANGPACKS_PROD="$USER_DATA_PROD/languagepacks.json"

mkdir -p "$ARGV_PROD_DIR" "$USER_DATA_PROD"

if [[ -f "$ARGV_DEV" && ! -f "$ARGV_PROD" ]]; then
	cp "$ARGV_DEV" "$ARGV_PROD"
	log "复制 argv.json → $ARGV_PROD"
elif [[ -f "$ARGV_PROD" ]]; then
	if ! grep -q '"locale"' "$ARGV_PROD"; then
		warn "$ARGV_PROD 已存在但没有 locale 字段；如界面非中文，请手动加 \"locale\": \"zh-cn\","
	fi
fi

# 关键：prod 模式（无 VSCODE_DEV）vscode 默认 builtinExtensionsPath 指向 wfm-ide/extensions/，
# 只扫描那里 98 个 vscode 自带扩展，**不看** wfm-ide/.build/builtInExtensions/（dev 模式才看）。
# 简体中文语言包是从 marketplace 下载到 .build/builtInExtensions/ 的，prod 看不到 → languagepacks
# 重写成 {} → NLS 解析失败 fallback 英文。
#
# 修法：合成一份 builtin 目录，软链上述两个源里所有扩展，启动时用 --builtin-extensions-dir 指过去。
# 必须放在 wfm-ide/ 目录树内（默认 vscode-file 协议白名单覆盖应用根），
# 否则资源（如 theme-seti 图标字体）加载会被 CSP 拦截。
MERGED_BUILTIN_DIR="$IDE_DIR/.build/wfm-builtin-merged"
log "合成 builtin-extensions 目录 → $MERGED_BUILTIN_DIR"
rm -rf "$MERGED_BUILTIN_DIR"
mkdir -p "$MERGED_BUILTIN_DIR"
link_count=0
for src in "$IDE_DIR/extensions"/*/; do
	[[ -d "$src" && -f "$src/package.json" ]] || continue
	ext_id=$(basename "$src")
	ln -s "${src%/}" "$MERGED_BUILTIN_DIR/$ext_id"
	link_count=$((link_count + 1))
done
for src in "$IDE_DIR/.build/builtInExtensions"/*/; do
	[[ -d "$src" && -f "$src/package.json" ]] || continue
	ext_id=$(basename "$src")
	# 不覆盖 wfm-ide/extensions 里已存在的同名扩展
	[[ -e "$MERGED_BUILTIN_DIR/$ext_id" ]] && continue
	ln -s "${src%/}" "$MERGED_BUILTIN_DIR/$ext_id"
	link_count=$((link_count + 1))
done
log "  共软链 $link_count 个 builtin 扩展（含简中语言包）"

# 旧 NLS 缓存可能基于旧路径，清掉让它本次启动重新生成。
if [[ -d "$USER_DATA_PROD/clp" ]]; then
	rm -rf "$USER_DATA_PROD/clp"
	log "清旧 NLS 缓存：$USER_DATA_PROD/clp"
fi
# vscode 自己会扫描扩展并写 languagepacks.json；这里同步一份 dev 版本兜底（重启后第一次读就能拿到 zh-cn）
if [[ -f "$LANGPACKS_DEV" ]] && ! cmp -s "$LANGPACKS_DEV" "$LANGPACKS_PROD" 2>/dev/null; then
	cp "$LANGPACKS_DEV" "$LANGPACKS_PROD"
	log "同步 languagepacks.json → $LANGPACKS_PROD"
fi

# ───────── 4. 启动 IDE（不带 VSCODE_DEV）─────────
if [[ $DO_LAUNCH -eq 1 ]]; then
	NAME=$(node -p "require('$IDE_DIR/product.json').nameLong")
	EXE_NAME=$(node -p "require('$IDE_DIR/product.json').nameShort")
	APP_BIN="$IDE_DIR/.build/electron/$NAME.app/Contents/MacOS/$EXE_NAME"

	if [[ ! -x "$APP_BIN" ]]; then
		err "找不到 Electron 二进制：$APP_BIN"
		err "请先执行一次 ./scripts/dev.sh 让它下载 .build/electron"
		exit 1
	fi

	log "启动 IDE（production 模式，无 VSCODE_DEV）"
	log "  数据目录：$USER_DATA_PROD"
	log "  argv：    $ARGV_PROD"
	log "  日志镜像：$IDE_LOG"
	log "  退回 dev watch：./scripts/dev.sh"

	# Cursor / vscode 调起的 shell 会注入 ELECTRON_RUN_AS_NODE=1 与一组 VSCODE_*；
	# 它们会让 Electron 二进制变回纯 Node 模式（process.type=undefined），
	# 导致 main.js 的 `import { app, Menu } from 'electron'` 抛 named import 错。
	# 这里强制清掉再启动，确保从 cursor / vscode 终端跑也能起来。
	(
		cd "$IDE_DIR"
		unset VSCODE_DEV ELECTRON_RUN_AS_NODE
		unset VSCODE_CODE_CACHE_PATH VSCODE_CRASH_REPORTER_PROCESS_TYPE \
			VSCODE_CWD VSCODE_ESM_ENTRYPOINT VSCODE_HANDLES_UNCAUGHT_ERRORS \
			VSCODE_IPC_HOOK VSCODE_NLS_CONFIG VSCODE_PID VSCODE_PROCESS_TITLE
		export NODE_ENV=production
		export VSCODE_CLI=1
		export ELECTRON_ENABLE_STACK_DUMPING=1
		export ELECTRON_ENABLE_LOGGING=1
		exec "$APP_BIN" . \
			--builtin-extensions-dir "$MERGED_BUILTIN_DIR" \
			--disable-extension=vscode.vscode-api-tests
	) 2>&1 | tee "$IDE_LOG" || true
else
	log "跳过 IDE 启动（--no-ide）"
	ok "bundle 已就绪。手动启动："
	log "  cd $IDE_DIR && unset VSCODE_DEV && ./scripts/code.sh"
fi
