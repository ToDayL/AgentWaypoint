# CodexPanel

CodexPanel is a web interface for chatting and vibe coding with Codex through the Codex app server interface.

## Status
Hybrid local dev stack is implemented with project/session management, turn streaming, session resume, host runner integration, and approval pause/resume support.

## Goals (MVP)
- Browser chat experience for Codex
- Streaming assistant/tool events (SSE)
- Project/session management
- Session history and resume
- Basic auth and observability

## Tech Direction (v1)
- Frontend: Next.js + TypeScript
- Backend: NestJS (Fastify) + TypeScript
- Database: PostgreSQL + Prisma
- Streaming: SSE first, WebSocket later if needed
- Deployment (Option 2, revised): Docker (`web`, DB services) plus host `api` and host `codex-runner` daemon for Codex app-server process management

## Repository Structure
```text
apps/
  web/
  api/
packages/
  shared/
  config/
infra/
doc/
scripts/
```

## Quick Start (Docker-First)
1. Copy environment template:
   - `cp .env.example .env`
   - Optional: set `HTTP_PROXY`/`HTTPS_PROXY` in `.env` for constrained networks.
2. Start full dev stack (container + host services):
   - `pnpm dev:up`

Expected local ports:
- `web`: `https://localhost:3000`
- `api`: `http://localhost:4000`
- `runner`: `http://127.0.0.1:4700`
- health check: `http://localhost:4000/api/health`

TLS termination is handled by the `nginx` container in front of `web`.
Only the HTTPS listener is published by default.
Place your certificate and key in `infra/docker/nginx/certs/` and set:
- `NGINX_SSL_CERT_FILE`
- `NGINX_SSL_KEY_FILE`
- optional `NGINX_SSL_TRUSTED_CERT_FILE` for a mounted CA bundle or chain file

Stop stack:
- `pnpm dev:down`
- Optional clean reset (also remove volumes/orphans):
  - `CLEAN_VOLUMES=1 pnpm dev:down`
- Check status:
  - `pnpm dev:status`

## Development Workflow (Verified)
This project currently runs in hybrid mode:
- Container: `web + postgres + redis`
- Host: `api + codex-runner`

### 1. Clean Reset (optional but recommended when debugging)
1. Stop and remove containers + networks + volumes:
   - `docker compose -f infra/docker/docker-compose.yml down -v --remove-orphans`
2. Remove web build cache:
   - `rm -rf apps/web/.next`

### 2. Start Container Services
1. Add TLS assets for nginx:
   - certificate: `infra/docker/nginx/certs/${NGINX_SSL_CERT_FILE:-localhost.crt}`
   - key: `infra/docker/nginx/certs/${NGINX_SSL_KEY_FILE:-localhost.key}`
   - optional CA chain: `infra/docker/nginx/certs/${NGINX_SSL_TRUSTED_CERT_FILE}`
2. Start nginx/web/postgres/redis:
   - `docker compose -f infra/docker/docker-compose.yml up --build -d`

### 3. Start Host API
1. In a separate terminal:
   - `./scripts/dev-api-host.sh`
2. If your host Node is not v22 (for example v24), use watch mode:
   - `API_WATCH_MODE=1 ./scripts/dev-api-host.sh`
3. If DB schema is not initialized yet, run once:
   - `set -a; source .env; set +a; corepack pnpm --filter @codexpanel/api prisma:migrate:dev`

### 3.5 Start Host Runner
1. Start runner daemon:
   - `./scripts/dev-runner-host.sh`
2. Configure API to call runner:
   - set `RUNNER_MODE=http` in `.env`

### 4. Verify End-to-End
1. API health:
   - `curl http://localhost:4000/api/health`
   - expected: `{"status":"ok"}`
2. Web app:
   - open `https://localhost:3000`
3. Simulation API proxy (from web container):
   - `docker compose -f infra/docker/docker-compose.yml exec -T web sh -lc "node -e \"fetch('http://localhost:3000/api/sim/projects',{headers:{'x-user-email':'demo@example.com'}}).then(async r=>{console.log(r.status);console.log(await r.text());})\""`

### Runner Adapter Mode
`apps/api` supports two runner adapter modes selected by `RUNNER_MODE`:
- `mock` (default): in-process simulated turn execution.
- `http`: forwards turn control calls to host `codex-runner`.

When `RUNNER_MODE=http`, API calls:
- `POST ${RUNNER_BASE_URL}/runner/turns/start` with `{ turnId, sessionId, content }`
- `POST ${RUNNER_BASE_URL}/runner/turns/cancel` with `{ turnId }`

Optional auth header:
- `Authorization: Bearer ${RUNNER_AUTH_TOKEN}` (if token is set)
- Runner health endpoint:
  - `GET ${RUNNER_BASE_URL}/runner/health`
- Runner callback target:
  - `RUNNER_API_BASE_URL` (default `http://127.0.0.1:4000`)

### Runner Backend
`apps/runner` supports two execution backends:
- `RUNNER_BACKEND=codex` (default): starts `codex app-server` over stdio and forwards real streamed deltas.
- `RUNNER_BACKEND=mock`: legacy echo simulator for local fallback/debugging.

Codex backend env options:
- `RUNNER_CODEX_BIN` (default `codex`)
- `RUNNER_CODEX_CWD` (default current working directory)
- `RUNNER_CODEX_MODEL` (optional model override)
- `RUNNER_CODEX_APPROVAL_POLICY` (default `on-request`)
- `RUNNER_CODEX_SANDBOX` (optional sandbox override)

When approvals are enabled, CodexPanel pauses the active turn and exposes approve/reject controls in the web UI before side-effecting actions continue.

Workspace validation:
- Turn execution now requires project `repoPath` to be configured and exist on host.
- Optional `RUNNER_ALLOWED_REPO_ROOTS` (comma-separated absolute roots) restricts allowed workspaces.

### 5. Stop All Services
1. Stop containers:
   - `docker compose -f infra/docker/docker-compose.yml down`
2. Stop host API process:
   - terminate `./scripts/dev-api-host.sh`

### Optional Orchestration Scripts
- `pnpm dev:up`: starts Docker services, runs migration, starts host runner + host api in background, and checks health.
- Background host services started by `pnpm dev:up` run in non-watch mode by default for stability. Set `API_WATCH_MODE=1` and/or `RUNNER_WATCH_MODE=1` explicitly if you want watch mode.
- `pnpm dev:status`: prints Docker service status, host pid status, and health checks.
- `pnpm dev:down`: stops host processes and Docker services.

## Documentation
- [PRD](./doc/PRD.md)
- [Initial Architecture](./doc/Architecture-Initial.md)
- [Auth Design](./doc/Auth-Design.md)
- [Codex App Server Notes](./doc/Codex-App-Server-Documentation.md)
- [v1 Tech Stack and Repo Structure](./doc/V1-Tech-Stack-and-Repo-Structure.md)
- [Development Workflow](./doc/Development-Workflow.md)
- [Runner Design Decisions](./doc/Runner-Design-Decisions.md)
- [Implementation Plan](./doc/Implementation-Plan.md)
- [Implementation Progress](./doc/Implementation-Progress.md)

## Next Steps
1. Harden approval edge cases such as rejection handling, duplicate approvals, and recovery from paused turns.
2. Add CI coverage for lint, typecheck, and database-backed tests.
3. Improve observability around runner lifecycle and approval state transitions.
4. Replace the current simulation-first UX with fuller auth and session management flows.

## License
Apache License 2.0. See [LICENSE](./LICENSE).
