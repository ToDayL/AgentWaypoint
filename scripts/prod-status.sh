#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker/docker-compose.prod.yml"
STATE_DIR="/tmp/agentwaypoint-prod"
ENV_FILE_PATH="$ROOT_DIR/.env.production"

if [[ ! -f "$ENV_FILE_PATH" ]]; then
  ENV_FILE_PATH="$ROOT_DIR/.env"
fi

if [[ -f "$ENV_FILE_PATH" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE_PATH"
  set +a
fi

detect_docker_gateway_ip() {
  local container_name="$1"
  local gateway
  gateway="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{println $v.Gateway}}{{end}}' "$container_name" 2>/dev/null | awk 'NF {print $1; exit}')"
  if [[ -n "$gateway" ]]; then
    printf '%s\n' "$gateway"
  fi
}

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

echo "[prod-status] Using env file: ${ENV_FILE_PATH}"
echo "[prod-status] Docker services:"
docker compose -f "$COMPOSE_FILE" ps || true

echo
echo "[prod-status] Host services:"
status_bg runner

effective_runner_host="${RUNNER_HOST:-}"
if [[ -z "$effective_runner_host" ]]; then
  effective_runner_host="$(detect_docker_gateway_ip agentwaypoint-prod-postgres)"
fi
effective_runner_base_url="${PROD_API_RUNNER_BASE_URL:-}"
if [[ -z "$effective_runner_base_url" || "$effective_runner_base_url" == "http://host.docker.internal:5700" ]]; then
  if [[ -n "$effective_runner_host" ]]; then
    effective_runner_base_url="http://${effective_runner_host}:${PROD_RUNNER_PORT:-5700}"
  fi
fi

echo
echo "[prod-status] Effective runner endpoint config:"
echo "RUNNER_HOST=${effective_runner_host:-<unknown>}"
echo "PROD_API_RUNNER_BASE_URL=${effective_runner_base_url:-<unknown>}"

runner_health_host="${effective_runner_host:-127.0.0.1}"
if [[ "$runner_health_host" == "0.0.0.0" || "$runner_health_host" == "::" || "$runner_health_host" == "<unknown>" ]]; then
  runner_health_host="127.0.0.1"
fi

echo
echo "[prod-status] Health checks:"
docker compose -f "$COMPOSE_FILE" exec -T api sh -lc \
  "node -e \"fetch('http://127.0.0.1:4000/api/health').then(async r=>{if(!r.ok) process.exit(1); console.log(await r.text());}).catch(()=>process.exit(1))\"" \
  || echo "api health unavailable"
curl -fsS "http://${runner_health_host}:${PROD_RUNNER_PORT:-5700}/runner/health" || echo "runner health unavailable"
curl -kfsS "https://127.0.0.1:${PROD_NGINX_HTTPS_PORT:-3443}" >/dev/null || echo "web https unavailable"
