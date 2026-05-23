#!/usr/bin/env bash
# 最小闭环：watch + OSS IDE。本项目后端已切到本地 claude CLI 子进程，无 HTTP 服务。
# 等价于：./scripts/dev.sh "$@"
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT_DIR/scripts/dev.sh" "$@"
