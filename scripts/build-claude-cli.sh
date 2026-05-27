#!/usr/bin/env bash
# WFM Studio — 打包 Claude Code CLI
#
# 产出目录结构：.build/claude-cli/
#   node_modules/@anthropic-ai/claude-code/   ← CLI npm 包
#   claude                                      ← 入口脚本（指向 node_modules）
#
# 用法：./scripts/build-claude-cli.sh [--force]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.build/claude-cli"
FORCE=0

for arg in "$@"; do
	case "$arg" in
		--force) FORCE=1 ;;
	esac
done

# ─── 颜色 ───
if [[ -t 1 ]]; then
	C_GRN=$'\e[32m'; C_CYN=$'\e[36m'; C_RST=$'\e[0m'
else
	C_GRN=""; C_CYN=""; C_RST=""
fi
log()  { printf '%s[build-claude-cli]%s %s\n' "$C_CYN" "$C_RST" "$*"; }
ok()   { printf '%s[build-claude-cli]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_GRN" "$*" "$C_RST"; }

# ─── 检查是否已构建 ───
CLAUDE_BIN="$BUILD_DIR/node_modules/.bin/claude"
if [[ -x "$CLAUDE_BIN" ]] && [[ $FORCE -eq 0 ]]; then
	VERSION="$("$CLAUDE_BIN" --version 2>/dev/null || echo 'unknown')"
	ok "Claude Code CLI 已存在: $VERSION"
	exit 0
fi

# ─── 安装 ───
log "安装 @anthropic-ai/claude-code..."
mkdir -p "$BUILD_DIR"

# 创建临时 package.json 用于 npm install
cat > "$BUILD_DIR/package.json" << 'PKGEOF'
{
	"name": "wfm-claude-cli",
	"private": true,
	"description": "Bundled Claude Code CLI for WFM Studio"
}
PKGEOF

npm install --prefix "$BUILD_DIR" @anthropic-ai/claude-code --no-save --no-package-lock

if [[ ! -x "$CLAUDE_BIN" ]]; then
	echo "错误：Claude Code CLI 安装失败" >&2
	exit 1
fi

# 创建顶层 claude 入口脚本，设置 NODE_PATH 让 CLI 能找到自己的 node_modules
cat > "$BUILD_DIR/claude" << 'ENTRYPEOF'
#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NODE_PATH="$DIR/node_modules"
exec "$DIR/node_modules/.bin/claude" "$@"
ENTRYPEOF
chmod +x "$BUILD_DIR/claude"

VERSION="$("$CLAUDE_BIN" --version 2>/dev/null || echo 'unknown')"
CLI_SIZE="$(du -sh "$BUILD_DIR" | cut -f1)"
ok "Claude Code CLI 打包完成: v${VERSION} ($CLI_SIZE)"
