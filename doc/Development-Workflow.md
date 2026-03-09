# CodexPanel Development Workflow

Last verified: 2026-03-07

This project currently runs in hybrid mode:
- Container: `web + postgres + redis`
- Host: `api + codex-runner`

## Fast Path
Use orchestration scripts from repo root:
- Start all dev services: `pnpm dev:up`
- Check status: `pnpm dev:status`
- Stop all dev services: `pnpm dev:down`
- Clean stop (remove volumes/orphans): `CLEAN_VOLUMES=1 pnpm dev:down`

## 1. Clean Reset
Use this when debugging startup/runtime drift or verifying from scratch.

1. Stop and remove containers, network, and volumes:
   - `docker compose -f infra/docker/docker-compose.yml down -v --remove-orphans`
2. Remove web cache:
   - `rm -rf apps/web/.next`

## 2. Start Container Services
1. Start web/postgres/redis:
   - `docker compose -f infra/docker/docker-compose.yml up --build -d`

## 3. Start Host API
1. Start API on host:
   - `./scripts/dev-api-host.sh`
2. If host Node is not v22 (for example v24), run watch mode:
   - `API_WATCH_MODE=1 ./scripts/dev-api-host.sh`
3. Initialize DB schema from host (after clean DB reset):
   - `set -a; source .env; set +a; corepack pnpm --filter @codexpanel/api prisma:migrate:dev`

## 3.5 Start Host Runner
1. Start runner daemon:
   - `./scripts/dev-runner-host.sh`
2. Switch API to runner mode:
   - set `RUNNER_MODE=http` in `.env` (default is `mock`)

## 4. Verify
1. API health:
   - `curl http://localhost:4000/api/health`
   - Expected: `{"status":"ok"}`
2. Runner health:
   - `curl http://127.0.0.1:4700/runner/health`
   - Expected: `{"status":"ok","activeTurnCount":0}`
3. Open web:
   - `http://localhost:3000`
4. Verify web proxy -> API (from web container):
   - `docker compose -f infra/docker/docker-compose.yml exec -T web sh -lc "node -e \"fetch('http://localhost:3000/api/sim/projects',{headers:{'x-user-email':'demo@example.com'}}).then(async r=>{console.log(r.status);console.log(await r.text());})\""`
   - Expected: status `200` and JSON array (for a fresh DB: `[]`)

## 5. Stop
1. Stop containers:
   - `docker compose -f infra/docker/docker-compose.yml down`
2. Stop host API:
   - terminate `./scripts/dev-api-host.sh`
3. Stop host runner:
   - terminate `./scripts/dev-runner-host.sh`

## Notes
- If web shows `API upstream unavailable`, host API is not reachable from container. Check API process and `http://localhost:4000/api/health`.
- If API returns Prisma `table does not exist`, run migration command in step 3.3.
