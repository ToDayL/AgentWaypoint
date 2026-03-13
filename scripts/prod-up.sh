#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker/docker-compose.prod.yml"
STATE_DIR="/tmp/agentwaypoint-prod"
ENV_FILE_PATH="$ROOT_DIR/.env.production"
mkdir -p "$STATE_DIR"

if [[ ! -f "$ENV_FILE_PATH" ]]; then
  ENV_FILE_PATH="$ROOT_DIR/.env"
fi

if [[ -f "$ENV_FILE_PATH" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE_PATH"
  set +a
fi

cd "$ROOT_DIR"

echo "[prod-up] Using env file: ${ENV_FILE_PATH}"
echo "[prod-up] Starting Docker services (postgres/redis)..."
docker compose -f "$COMPOSE_FILE" up --build -d postgres redis

if [[ "${SKIP_MIGRATE:-0}" != "1" ]]; then
  echo "[prod-up] Running API migration deploy..."
  docker compose -f "$COMPOSE_FILE" run --rm api sh -lc "
    pnpm install --frozen-lockfile --reporter=append-only &&
    pnpm --filter @agentwaypoint/api prisma:generate &&
    pnpm --filter @agentwaypoint/api exec prisma migrate deploy
  "
fi

if [[ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" && -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]]; then
  echo "[prod-up] Bootstrapping first admin user (skips automatically if admin already exists)..."
  docker compose -f "$COMPOSE_FILE" run --rm api sh -lc "
    pnpm install --frozen-lockfile --reporter=append-only &&
    pnpm --filter @agentwaypoint/api auth:bootstrap-admin -- \
      --email '${BOOTSTRAP_ADMIN_EMAIL}' \
      --password '${BOOTSTRAP_ADMIN_PASSWORD}' \
      --display-name '${BOOTSTRAP_ADMIN_DISPLAY_NAME:-}'
  "
else
  echo "[prod-up] BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD not set; skipping admin bootstrap."
fi

echo "[prod-up] Starting Docker app services (api/web/nginx)..."
docker compose -f "$COMPOSE_FILE" up --build -d api web nginx

start_bg() {
  local name="$1"
  local pid_file="$STATE_DIR/${name}.pid"
  local log_file="$STATE_DIR/${name}.log"
  shift
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1; then
    echo "[prod-up] ${name} already running (pid=$(cat "$pid_file"))."
    return
  fi

  nohup setsid "$@" </dev/null >"$log_file" 2>&1 &
  local pid=$!
  echo "$pid" >"$pid_file"
  echo "[prod-up] Started ${name} (pid=${pid}, log=${log_file})."
}

echo "[prod-up] Starting host runner..."
start_bg runner bash -lc "cd '$ROOT_DIR'; set -a; source '$ENV_FILE_PATH'; set +a; RUNNER_WATCH_MODE=0 RUNNER_PORT=\${PROD_RUNNER_PORT:-5700} ENV_FILE='$ENV_FILE_PATH' exec bash scripts/dev-runner-host.sh"

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
      echo "[prod-up] ${name} ready: ${url}"
      return
    fi
    sleep 1
  done
  echo "[prod-up] ${name} failed health check: ${url}"
  exit 1
}

wait_compose_http() {
  local service="$1"
  local url="$2"
  local i
  for i in $(seq 1 60); do
    if docker compose -f "$COMPOSE_FILE" exec -T "$service" sh -lc \
      "node -e \"fetch('$url').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" >/dev/null 2>&1; then
      echo "[prod-up] ${service} ready: ${url}"
      return
    fi
    sleep 1
  done
  echo "[prod-up] ${service} failed health check: ${url}"
  exit 1
}

wait_compose_http api "http://127.0.0.1:4000/api/health"
wait_health runner "http://127.0.0.1:${PROD_RUNNER_PORT:-5700}/runner/health"
wait_health web "https://127.0.0.1:${PROD_NGINX_HTTPS_PORT:-3443}" insecure

echo "[prod-up] All production services are up."
