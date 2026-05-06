#!/usr/bin/env bash
# 最小闭环：后端 8765 + IDE watch + OSS，不启动 AgenticX/MAF DevUI（见 docs/PLAN.md §8.3）
# 等价于: ./scripts/dev.sh --no-agent-devuis "$@"
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT_DIR/scripts/dev.sh" --no-agent-devuis "$@"
