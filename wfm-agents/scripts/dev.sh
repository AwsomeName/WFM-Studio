#!/usr/bin/env bash
# wfm-agents 开发启动脚本
#
# 用法:
#   ./scripts/dev.sh          # 稳定模式（不热重载，不会中断请求）
#   ./scripts/dev.sh --reload # 开发模式（文件变更自动重载，可能中断请求）
#
# 默认端口 8765，可通过环境变量覆盖:
#   PORT=9000 ./scripts/dev.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8765}"
HOST="${HOST:-127.0.0.1}"
RELOAD=""

if [ "${1:-}" = "--reload" ]; then
    RELOAD="--reload"
fi

exec uv run uvicorn wfm_agents.server:app \
    $RELOAD \
    --host "$HOST" \
    --port "$PORT"
