#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
RUNNER_DIR="$ROOT_DIR/apps/runner"
ENV_FILE="${ENV_FILE:-.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if command -v pnpm >/dev/null 2>&1; then
  PM=(pnpm)
else
  export COREPACK_HOME="${COREPACK_HOME:-/tmp/corepack}"
  PM=(corepack pnpm)
fi

TSX_BIN="$ROOT_DIR/node_modules/.bin/tsx"

if [[ ! -x "$TSX_BIN" ]]; then
  CI=true "${PM[@]}" install --no-frozen-lockfile --reporter=append-only
fi

if [[ "${RUNNER_WATCH_MODE:-1}" == "1" ]]; then
  cd "$RUNNER_DIR"
  exec "$TSX_BIN" watch src/main.ts
fi

cd "$RUNNER_DIR"
exec node --import tsx src/main.ts
