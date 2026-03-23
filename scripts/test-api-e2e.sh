#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker/docker-compose.yml"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

API_DATABASE_URL="${API_DATABASE_URL:-postgresql://postgres:postgres@postgres:5432/agentwaypoint}"

cd "$ROOT_DIR"

echo "[test-api-e2e] Starting database services..."
docker compose -f "$COMPOSE_FILE" up -d postgres redis

echo "[test-api-e2e] Running migrations..."
docker compose -f "$COMPOSE_FILE" run --rm \
  -e DATABASE_URL="$API_DATABASE_URL" \
  -e CI="${CI:-}" \
  api sh -lc "
    pnpm install --no-frozen-lockfile --reporter=append-only &&
    pnpm --filter @agentwaypoint/api prisma:generate &&
    if [ \"\${CI:-}\" = \"true\" ]; then
      pnpm --filter @agentwaypoint/api prisma migrate deploy;
    else
      pnpm --filter @agentwaypoint/api prisma:migrate:dev;
    fi
  "

echo "[test-api-e2e] Running API e2e tests..."
docker compose -f "$COMPOSE_FILE" run --rm \
  -e DATABASE_URL="$API_DATABASE_URL" \
  api sh -lc "
    pnpm install --no-frozen-lockfile --reporter=append-only &&
    pnpm --filter @agentwaypoint/api test -- src/modules/api.e2e.spec.ts src/modules/api.http-runner.e2e.spec.ts
  "
