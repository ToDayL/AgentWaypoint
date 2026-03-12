# AgentWaypoint Development Workflow

Last verified: 2026-03-07

This project currently runs in split mode:
- Container: `nginx + web + api + postgres + redis`
- Host: `codex-runner`

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
1. Start nginx/web/api/postgres/redis:
   - `docker compose -f infra/docker/docker-compose.yml up --build -d`

## 3. Start Host Runner
1. Start runner daemon:
   - `./scripts/dev-runner-host.sh`
2. Containerized API reaches the host runner through `host.docker.internal`:
   - default `API_RUNNER_MODE=http`
   - default `API_RUNNER_BASE_URL=http://host.docker.internal:4700`
3. Initialize DB schema from the API container (after clean DB reset):
   - `docker compose -f infra/docker/docker-compose.yml exec -T api sh -lc "pnpm --filter @agentwaypoint/api prisma:migrate:dev"`
4. Choose runner backend:
   - `RUNNER_BACKEND=codex` for real Codex app-server integration (default)
   - `RUNNER_BACKEND=mock` for local echo fallback

## 4. Verify
1. API health:
   - `docker compose -f infra/docker/docker-compose.yml exec -T api sh -lc "node -e \"fetch('http://127.0.0.1:4000/api/health').then(async r=>console.log(await r.text()))\""`
   - Expected: `{"status":"ok"}`
2. Runner health:
   - `curl http://127.0.0.1:4700/runner/health`
   - Expected: `{"status":"ok","activeTurnCount":0}`
3. Open web:
   - `https://localhost:3000`
4. Verify web proxy -> API (from web container):
   - `docker compose -f infra/docker/docker-compose.yml exec -T web sh -lc "node -e \"fetch('http://localhost:3000/api/sim/projects',{headers:{'x-user-email':'demo@example.com'}}).then(async r=>{console.log(r.status);console.log(await r.text());})\""`
   - Expected: status `200` and JSON array (for a fresh DB: `[]`)

## 5. Stop
1. Stop containers:
   - `docker compose -f infra/docker/docker-compose.yml down`
2. Stop host runner:
   - terminate `./scripts/dev-runner-host.sh`

## Notes
- If web shows `API upstream unavailable`, check the `api` container logs and the in-container health check in step 4.1.
- If API returns Prisma `table does not exist`, run migration command in step 3.4.
