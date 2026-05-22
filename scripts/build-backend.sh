#!/usr/bin/env bash
# WFM Studio — 打包 Python 后端为嵌入式运行时
#
# 产出目录结构：.build/wfm-backend/
#   python/            ← python-build-standalone 运行时
#   wfm_agents/        ← 后端源码
#   start.sh           ← 启动入口
#
# 用法：./scripts/build-backend.sh [--with-cad] [--force]
#   --with-cad  包含 CAD 工具链（build123d/OCP/trimesh/ezdxf/playwright）
#   --force     强制重新下载 Python 运行时（即使已缓存）
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.build/wfm-backend"
FORCE=0
WITH_CAD=0

for arg in "$@"; do
  case "$arg" in
    --with-cad) WITH_CAD=1 ;;
    --force)    FORCE=1 ;;
  esac
done

# ─── 配置 ───
PYTHON_VERSION="3.12.13"
PYTHON_RELEASE="20260510"
PYTHON_ARCH="aarch64-apple-darwin"
PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/cpython-${PYTHON_VERSION}%2B${PYTHON_RELEASE}-${PYTHON_ARCH}-install_only.tar.gz"

# 最小依赖集（不含 CAD/crewai/build123d/trimesh/playwright）
MINIMAL_DEPS=(
  "fastapi>=0.115"
  "uvicorn[standard]>=0.32"
  "pydantic>=2.9"
  "python-dotenv>=1.0"
  "openai>=1.59"
  "mcp>=1.26.0"
  "pyyaml>=6.0.3"
  "httpx>=0.27"
)

# CAD 依赖集（--with-cad 时追加）
CAD_DEPS=(
  "build123d>=0.10"
  "ezdxf"
  "numpy"
  "pillow"
  "playwright"
  "trimesh>=4.12"
)

# 合并依赖列表
ALL_DEPS=("${MINIMAL_DEPS[@]}")
if [[ $WITH_CAD -eq 1 ]]; then
  ALL_DEPS+=("${CAD_DEPS[@]}")
fi

# ─── 颜色 ───
if [[ -t 1 ]]; then
  C_GRN=$'\e[32m'; C_CYN=$'\e[36m'; C_RST=$'\e[0m'
else
  C_GRN=""; C_CYN=""; C_RST=""
fi
log()  { printf '%s[build-backend]%s %s\n' "$C_CYN" "$C_RST" "$*"; }
ok()   { printf '%s[build-backend]%s %s%s%s\n' "$C_CYN" "$C_RST" "$C_GRN" "$*" "$C_RST"; }

# ─── Step 1: 下载 Python 运行时 ───
PYTHON_DIR="$BUILD_DIR/python"
PYTHON_BIN="$PYTHON_DIR/bin/python3"

if [[ -x "$PYTHON_BIN" ]] && [[ $FORCE -eq 0 ]]; then
  ok "Python 运行时已存在: $PYTHON_BIN"
  $PYTHON_BIN --version
else
  log "下载 python-build-standalone ${PYTHON_VERSION} (${PYTHON_ARCH})..."
  mkdir -p "$BUILD_DIR"
  TMP_TAR="$(mktemp "${BUILD_DIR}/python-XXXXXXXX.tar.gz")"
  trap 'rm -f "$TMP_TAR"' EXIT

  curl -fSL --progress-bar -o "$TMP_TAR" "$PYTHON_URL"

  log "解压..."
  TMP_EXTRACT="$BUILD_DIR/tmp-python"
  rm -rf "$TMP_EXTRACT"
  mkdir -p "$TMP_EXTRACT"
  tar xzf "$TMP_TAR" -C "$TMP_EXTRACT"
  rm -f "$TMP_TAR"
  trap - EXIT

  # astral-sh 格式: 解压后为 python/bin/python3 直接可用
  EXTRACTED_PYTHON="$TMP_EXTRACT/python"
  if [[ ! -x "$EXTRACTED_PYTHON/bin/python3" ]]; then
    echo "错误：未找到 python3 二进制" >&2
    find "$TMP_EXTRACT" -maxdepth 3 -type d >&2
    exit 1
  fi

  rm -rf "$PYTHON_DIR"
  mv "$EXTRACTED_PYTHON" "$PYTHON_DIR"
  rm -rf "$TMP_EXTRACT"

  ok "Python 运行时就绪: $($PYTHON_BIN --version 2>&1)"
fi

# ─── Step 2: 安装依赖集 ───
SITE_PACKAGES="$BUILD_DIR/site-packages"
REQUIREMENTS_HASH="$BUILD_DIR/.deps-hash"

# 用依赖列表内容做 hash，变化时重装
DEPS_HASH="$(echo "${ALL_DEPS[*]}" | shasum -a 256 | cut -d' ' -f1)"
NEED_INSTALL=0

if [[ ! -f "$REQUIREMENTS_HASH" ]] || [[ "$(cat "$REQUIREMENTS_HASH")" != "$DEPS_HASH" ]]; then
  NEED_INSTALL=1
fi

if [[ $NEED_INSTALL -eq 1 ]]; then
  log "安装依赖集 (${#ALL_DEPS[@]} 个包$( [[ $WITH_CAD -eq 1 ]] && echo '，含 CAD')..."
  rm -rf "$SITE_PACKAGES"
  mkdir -p "$SITE_PACKAGES"
  "$PYTHON_BIN" -m pip install --target "$SITE_PACKAGES" --no-warn-script-location \
    "${ALL_DEPS[@]}"
  echo "$DEPS_HASH" > "$REQUIREMENTS_HASH"
  ok "依赖安装完成"
else
  ok "依赖已是最新，跳过安装"
fi

# ─── Step 3: 复制 wfm-agents 源码 ───
log "复制 wfm-agents 源码..."
AGENTS_SRC="$ROOT_DIR/wfm-agents/wfm_agents"
AGENTS_DST="$BUILD_DIR/wfm_agents"

if [[ ! -d "$AGENTS_SRC" ]]; then
  echo "错误：未找到 wfm-agents 源码: $AGENTS_SRC" >&2
  exit 1
fi

rm -rf "$AGENTS_DST"
cp -R "$AGENTS_SRC" "$AGENTS_DST"
# 清理 __pycache__
find "$AGENTS_DST" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

ok "wfm-agents 源码已复制"

# ─── Step 4: 复制 openai-agents SDK ───
log "复制 openai-agents SDK..."
AGENTS_SDK_SRC="$ROOT_DIR/third_party/agents/openai-agents-python/src/agents"
AGENTS_SDK_DST="$SITE_PACKAGES/agents"

if [[ ! -d "$AGENTS_SDK_SRC" ]]; then
  echo "错误：未找到 openai-agents SDK: $AGENTS_SDK_SRC" >&2
  exit 1
fi

rm -rf "$AGENTS_SDK_DST"
cp -R "$AGENTS_SDK_SRC" "$AGENTS_SDK_DST"
find "$AGENTS_SDK_DST" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

ok "openai-agents SDK 已复制"

# ─── Step 5: 生成 start.sh ───
log "生成 start.sh..."
cat > "$BUILD_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 加载用户配置
ENV_FILE="$HOME/.wfm-studio/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# 设置 PYTHONPATH：site-packages + wfm_agents 父目录
export PYTHONPATH="$DIR/site-packages:$DIR"

# CAD 工具链（可选，仅打包版包含）
if [[ -d "$DIR/skills/cad" ]]; then
  export WFM_CAD_PYTHON="$DIR/python/bin/python3"
  export WFM_CAD_SKILL_DIR="$DIR/skills/cad"
  export PLAYWRIGHT_BROWSERS_PATH="$DIR/browsers"
  export PATH="$DIR/libredwg:$PATH"
fi

exec "$DIR/python/bin/python3" -m uvicorn wfm_agents.server:app \
  --host 127.0.0.1 --port 8765 --log-level warning
STARTEOF
chmod +x "$BUILD_DIR/start.sh"

ok "start.sh 已生成"

# ─── Step 6-9: CAD 工具链（仅 --with-cad） ───
if [[ $WITH_CAD -eq 1 ]]; then
  # Step 6: 复制 CAD 脚本
  log "复制 CAD 脚本..."
  CAD_SKILLS_SRC="$ROOT_DIR/third_party/text-to-cad/skills/cad"
  CAD_SKILLS_DST="$BUILD_DIR/skills/cad"
  if [[ ! -d "$CAD_SKILLS_SRC" ]]; then
    echo "警告：未找到 CAD 脚本: $CAD_SKILLS_SRC，跳过" >&2
  else
    rm -rf "$CAD_SKILLS_DST"
    mkdir -p "$(dirname "$CAD_SKILLS_DST")"
    cp -R "$CAD_SKILLS_SRC" "$CAD_SKILLS_DST"
    find "$CAD_SKILLS_DST" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
    ok "CAD 脚本已复制"
  fi

  # Step 7: 复制 libredwg
  log "复制 libredwg..."
  LIBREDWG_SRC="$ROOT_DIR/third_party/libredwg/bin/macos/dwg2dxf"
  LIBREDWG_DST="$BUILD_DIR/libredwg/dwg2dxf"
  if [[ -x "$LIBREDWG_SRC" ]]; then
    mkdir -p "$(dirname "$LIBREDWG_DST")"
    cp "$LIBREDWG_SRC" "$LIBREDWG_DST"
    chmod +x "$LIBREDWG_DST"
    ok "libredwg 已复制"
  else
    log "libredwg 未找到，跳过 DWG 支持"
  fi

  # Step 8: 安装 Playwright Chromium
  log "安装 Playwright Chromium..."
  BROWSERS_DIR="$BUILD_DIR/browsers"
  PYTHONPATH="$SITE_PACKAGES" PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" \
    "$PYTHON_BIN" -m playwright install chromium
  ok "Playwright Chromium 已安装"

  log "CAD 工具链打包完成"
fi

# ─── 完成 ───
FINAL_SIZE="$(du -sh "$BUILD_DIR" | cut -f1)"
ok "后端打包完成: $BUILD_DIR ($FINAL_SIZE)"
log "  Python: $($PYTHON_BIN --version 2>&1)"
if [[ $WITH_CAD -eq 1 ]]; then
  log "  依赖:   ${#ALL_DEPS[@]} 个包（含 CAD）"
  log "  源码:   wfm_agents/ + agents SDK + CAD skills"
else
  log "  依赖:   ${#MINIMAL_DEPS[@]} 个包"
  log "  源码:   wfm_agents/ + agents SDK"
fi
