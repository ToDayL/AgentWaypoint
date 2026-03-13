#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker/docker-compose.prod.yml"
STATE_DIR="/tmp/agentwaypoint-prod"

stop_bg() {
  local name="$1"
  local pid_file="$STATE_DIR/${name}.pid"
  if [[ ! -f "$pid_file" ]]; then
    echo "[prod-down] ${name}: no pid file."
    return
  fi

  local pid
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    echo "[prod-down] Stopped ${name} (pid=${pid})."
  else
    echo "[prod-down] ${name}: process not running (pid=${pid})."
  fi
  rm -f "$pid_file"
}

stop_bg runner

if [[ "${CLEAN_VOLUMES:-0}" == "1" ]]; then
  echo "[prod-down] Stopping docker services and removing volumes/orphans..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans
else
  echo "[prod-down] Stopping docker services..."
  docker compose -f "$COMPOSE_FILE" down
fi

echo "[prod-down] Done."
