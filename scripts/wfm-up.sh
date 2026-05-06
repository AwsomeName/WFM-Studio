#!/usr/bin/env bash
# 先停再起：./scripts/dev-stop.sh → ./scripts/dev.sh --kill-port
# （释放 8765 等端口上的旧后端，再拉起全套 dev）
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT_DIR/scripts/dev-stop.sh"
sleep 1
exec "$ROOT_DIR/scripts/dev.sh" --kill-port "$@"
