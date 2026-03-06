#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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
if [[ "${SKIP_PRISMA_GENERATE:-0}" != "1" ]]; then
  "${PM[@]}" --filter @codexpanel/api prisma:generate
fi

# pnpm may skip lifecycle scripts in hardened mode, which leaves
# @prisma/client without the .prisma runtime symlink.
PRISMA_CLIENT_DIR="$(readlink -f apps/api/node_modules/@prisma/client || true)"
if [[ -n "${PRISMA_CLIENT_DIR}" ]]; then
  PRISMA_NODE_MODULES_DIR="$(cd "${PRISMA_CLIENT_DIR}/../.." && pwd)"
  if [[ -d "${PRISMA_NODE_MODULES_DIR}/.prisma/client" && ! -e "${PRISMA_CLIENT_DIR}/.prisma" ]]; then
    ln -s ../../.prisma "${PRISMA_CLIENT_DIR}/.prisma"
  fi
fi

if [[ "${API_WATCH_MODE:-0}" == "1" ]]; then
  exec "${PM[@]}" --filter @codexpanel/api dev
fi

"${PM[@]}" --filter @codexpanel/api build
exec "${PM[@]}" --filter @codexpanel/api start
