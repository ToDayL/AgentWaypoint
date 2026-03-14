#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker/docker-compose.prod.yml"
STATE_DIR="/tmp/agentwaypoint-prod"

if [[ -f "$ROOT_DIR/.env.production" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.production"
  set +a
elif [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

PROD_RUNNER_PORT="${PROD_RUNNER_PORT:-5700}"

find_pids_by_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "( sport = :$port )" 2>/dev/null \
      | sed -nE 's/.*pid=([0-9]+).*/\1/p' \
      | sort -u
    return
  fi
}

kill_pid_gracefully() {
  local pid="$1"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
    return
  fi
  kill "$pid" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
}

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
    kill_pid_gracefully "$pid"
    echo "[prod-down] Stopped ${name} (pid=${pid})."
  else
    echo "[prod-down] ${name}: process not running (pid=${pid})."
  fi
  rm -f "$pid_file"
}

stop_bg runner

# Fallbacks for runner processes started manually or with stale pid files.
for pid in $(find_pids_by_port "$PROD_RUNNER_PORT"); do
  kill_pid_gracefully "$pid"
  echo "[prod-down] Stopped runner listener on port ${PROD_RUNNER_PORT} (pid=${pid})."
done

if command -v pgrep >/dev/null 2>&1; then
  for pid in $(pgrep -f "apps/runner/src/main.ts" || true); do
    kill_pid_gracefully "$pid"
    echo "[prod-down] Stopped runner process by command match (pid=${pid})."
  done
fi

if [[ "${CLEAN_VOLUMES:-0}" == "1" ]]; then
  echo "[prod-down] Stopping docker services and removing volumes/orphans..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans
else
  echo "[prod-down] Stopping docker services..."
  docker compose -f "$COMPOSE_FILE" down
fi

echo "[prod-down] Done."
