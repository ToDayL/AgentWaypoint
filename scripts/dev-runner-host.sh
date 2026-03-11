#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
RUNNER_DIR="$ROOT_DIR/apps/runner"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

if command -v pnpm >/dev/null 2>&1; then
  PM=(pnpm)
else
  export COREPACK_HOME="${COREPACK_HOME:-/tmp/corepack}"
  PM=(corepack pnpm)
fi

CI=true "${PM[@]}" install --no-frozen-lockfile --reporter=append-only

if [[ "${RUNNER_WATCH_MODE:-1}" == "1" ]]; then
  cd "$RUNNER_DIR"
  exec "$ROOT_DIR/node_modules/.bin/tsx" watch src/main.ts
fi

cd "$RUNNER_DIR"
exec node --import tsx src/main.ts
