#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker/docker-compose.yml"
STATE_DIR="/tmp/agentwaypoint-dev"
mkdir -p "$STATE_DIR"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

cd "$ROOT_DIR"

echo "[dev-up] Starting Docker database services (postgres/redis)..."
docker compose -f "$COMPOSE_FILE" up --build -d postgres redis

if [[ "${SKIP_MIGRATE:-0}" != "1" ]]; then
  echo "[dev-up] Running API migration..."
  docker compose -f "$COMPOSE_FILE" run --rm api sh -lc "
    pnpm install --no-frozen-lockfile --reporter=append-only &&
    pnpm --filter @agentwaypoint/api prisma:generate &&
    pnpm --filter @agentwaypoint/api prisma:migrate:dev
  "
fi

echo "[dev-up] Starting Docker app services (api/web/nginx)..."
docker compose -f "$COMPOSE_FILE" up --build -d api web nginx

start_bg() {
  local name="$1"
  local pid_file="$STATE_DIR/${name}.pid"
  local log_file="$STATE_DIR/${name}.log"
  shift
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1; then
    echo "[dev-up] ${name} already running (pid=$(cat "$pid_file"))."
    return
  fi

  nohup setsid "$@" </dev/null >"$log_file" 2>&1 &
  local pid=$!
  echo "$pid" >"$pid_file"
  echo "[dev-up] Started ${name} (pid=${pid}, log=${log_file})."
}

echo "[dev-up] Starting host runner..."
start_bg runner bash -lc "cd '$ROOT_DIR'; set -a; source .env; set +a; RUNNER_WATCH_MODE=${RUNNER_WATCH_MODE:-0} exec bash scripts/dev-runner-host.sh"

wait_health() {
  local name="$1"
  local url="$2"
  local curl_args=()
  if [[ "${3:-}" == "insecure" ]]; then
    curl_args+=(-k)
  fi
  local i
  for i in $(seq 1 60); do
    if curl "${curl_args[@]}" -fsS "$url" >/dev/null 2>&1; then
      echo "[dev-up] ${name} ready: ${url}"
      return
    fi
    sleep 1
  done
  echo "[dev-up] ${name} failed health check: ${url}"
  exit 1
}

wait_compose_http() {
  local service="$1"
  local url="$2"
  local i
  for i in $(seq 1 60); do
    if docker compose -f "$COMPOSE_FILE" exec -T "$service" sh -lc \
      "node -e \"fetch('$url').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" >/dev/null 2>&1; then
      echo "[dev-up] ${service} ready: ${url}"
      return
    fi
    sleep 1
  done
  echo "[dev-up] ${service} failed health check: ${url}"
  exit 1
}

wait_compose_http api "http://127.0.0.1:4000/api/health"
wait_health runner "http://127.0.0.1:4700/runner/health"
wait_health web "https://127.0.0.1:${NGINX_HTTPS_PORT:-443}" insecure

echo "[dev-up] All dev services are up."
