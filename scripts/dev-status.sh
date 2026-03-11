#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker/docker-compose.yml"
STATE_DIR="/tmp/agentwaypoint-dev"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

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
curl -kfsS "https://127.0.0.1:${NGINX_HTTPS_PORT:-443}" >/dev/null || echo "web https unavailable"
