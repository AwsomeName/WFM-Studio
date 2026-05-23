#!/usr/bin/env bash
# 先停再起：./scripts/dev-stop.sh → ./scripts/dev.sh
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT_DIR/scripts/dev-stop.sh"
sleep 1
exec "$ROOT_DIR/scripts/dev.sh" "$@"
