# CodexPanel

CodexPanel is a web interface for chatting and vibe coding with Codex through the Codex app server interface.

## Status
Scaffolded monorepo baseline with initial `web`, `api`, shared packages, and local Docker infra.

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
2. Build and start Docker services (`web + postgres + redis`):
   - `docker compose -f infra/docker/docker-compose.yml up --build -d`
3. Start API on host:
   - `./scripts/dev-api-host.sh`
4. Run DB migration on host (new terminal):
   - `corepack pnpm --filter @codexpanel/api prisma:migrate:dev`

Expected local ports:
- `web`: `http://localhost:3000`
- `api`: `http://localhost:4000`
- health check: `http://localhost:4000/api/health`

Stop stack:
- `docker compose -f infra/docker/docker-compose.yml down`
- Stop host API:
  - terminate the `./scripts/dev-api-host.sh` process (`Ctrl+C` if foreground)

## Documentation
- [PRD](./doc/PRD.md)
- [Initial Architecture](./doc/Architecture-Initial.md)
- [Codex App Server Notes](./doc/Codex-App-Server-Documentation.md)
- [v1 Tech Stack and Repo Structure](./doc/V1-Tech-Stack-and-Repo-Structure.md)
- [Implementation Plan](./doc/Implementation-Plan.md)
- [Implementation Progress](./doc/Implementation-Progress.md)

## Next Steps
1. Shift local runtime to hybrid mode (`web + db` in Docker, `api` on host).
2. Define and implement API <-> host runner contract.
3. Add API runner adapter + SSE streaming endpoints.
4. Add API client + session list page in `apps/web`.

## License
Apache License 2.0. See [LICENSE](./LICENSE).
