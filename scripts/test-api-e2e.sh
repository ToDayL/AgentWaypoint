#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HOME="$(mktemp -d "${TMPDIR:-/tmp}/agentwaypoint-api-e2e.XXXXXX")"
trap 'rm -rf "$TEST_HOME"' EXIT

cd "$ROOT_DIR"

export AGENTWAYPOINT_HOME="$TEST_HOME"
export DATABASE_URL="file:$TEST_HOME/agentwaypoint-test.db"
export DEFAULT_WORKSPACE_ROOT="$TEST_HOME/workspaces"
export RUNNER_MODE=mock

mkdir -p "$DEFAULT_WORKSPACE_ROOT"

echo "[test-api-e2e] Using isolated home: $AGENTWAYPOINT_HOME"
echo "[test-api-e2e] Running Prisma generate..."
corepack pnpm --filter @agentwaypoint/api prisma:generate

echo "[test-api-e2e] Running API e2e specs..."
corepack pnpm --filter @agentwaypoint/api test -- src/modules/api.e2e.spec.ts src/modules/api.http-runner.e2e.spec.ts
