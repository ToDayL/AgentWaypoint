#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker/docker-compose.yml"
STATE_DIR="/tmp/codexpanel-dev"

status_bg() {
  local name="$1"
  local pid_file="$STATE_DIR/${name}.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "${name}: running (pid=${pid})"
      return
    fi
    echo "${name}: stale pid file (pid=${pid})"
    return
  fi
  echo "${name}: not running"
}

echo "[dev-status] Docker services:"
docker compose -f "$COMPOSE_FILE" ps || true

echo
echo "[dev-status] Host services:"
status_bg api
status_bg runner

echo
echo "[dev-status] Health checks:"
curl -fsS http://127.0.0.1:4000/api/health || echo "api health unavailable"
curl -fsS http://127.0.0.1:4700/runner/health || echo "runner health unavailable"
