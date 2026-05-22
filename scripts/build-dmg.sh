#!/usr/bin/env bash
# WFM Studio — 一键构建 DMG
#
# 完整流程：build-backend → gulp package → create-dmg
#
# 前置条件：
#   - Node 22 (见 wfm-ide/.nvmrc)
#   - wfm-ide/node_modules 已安装 (npm ci)
#
# 用法：./scripts/build-dmg.sh [--skip-backend]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_BACKEND=0

if [[ "${1:-}" == "--skip-backend" ]]; then
  SKIP_BACKEND=1
fi

# ─── 颜色 ───
if [[ -t 1 ]]; then
  C_GRN=$'\e[32m'; C_CYN=$'\e[36m'; C_RST=$'\e[0m'
else
  C_GRN=""; C_CYN=""; C_RST=""
fi
log()  { printf '%s[build-dmg]%s %s\n' "$C_CYN" "$C_RST" "$*"; }
ok()   { printf '%s[build-dmg]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_GRN" "$*" "$C_RST"; }

# ─── Step 1: 构建 Python 后端 ───
if [[ $SKIP_BACKEND -eq 0 ]]; then
  log "Step 1/3: 构建 Python 后端（含 CAD 工具链）..."
  "$ROOT_DIR/scripts/build-backend.sh" --with-cad
else
  log "Step 1/3: 跳过后端构建 (--skip-backend)"
fi

# ─── Step 2: 编译并打包 WFM Studio.app ───
log "Step 2/3: 编译并打包 WFM Studio.app..."
cd "$ROOT_DIR/wfm-ide"

if [[ ! -x node_modules/.bin/npm-run-all2 ]]; then
  echo "错误：wfm-ide/node_modules 未安装。请先运行：cd wfm-ide && npm ci" >&2
  exit 1
fi

npx gulp vscode-darwin-arm64

APP_PATH="$ROOT_DIR/VSCode-darwin-arm64/WFM Studio.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "错误：未找到 $APP_PATH" >&2
  exit 1
fi
ok "WFM Studio.app 打包完成"

# ─── Step 3: 生成 DMG ───
log "Step 3/3: 生成 DMG..."
mkdir -p "$ROOT_DIR/out"

VSCODE_ARCH=arm64 node build/darwin/create-dmg.ts \
  "$ROOT_DIR" "$ROOT_DIR/out"

DMG_PATH="$ROOT_DIR/out/VSCode-darwin-arm64.dmg"
if [[ ! -f "$DMG_PATH" ]]; then
  echo "错误：DMG 未生成" >&2
  exit 1
fi

DMG_SIZE="$(du -sh "$DMG_PATH" | cut -f1)"
ok "完成: $DMG_PATH ($DMG_SIZE)"
