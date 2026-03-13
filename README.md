# AgentWaypoint

Web UI for chatting with Codex through a runner service.

## What It Offers
- Chat interface for Codex with streaming responses.
- Project and session management for organized workspaces.
- Tooling insights (events/diff/tool output) for turn inspection.
- Self-hosted deployment with Docker and a host runner service.

## Production Quick Start
Prerequisite:
- Docker + Docker Compose
- Bash
- Node.js `22.x` recommended
- `corepack` (or `pnpm`) available on host
- Codex CLI installed on host (`codex` in `PATH`)
- Login on host before startup (run `codex login` once)

1. Prepare env:
```bash
cp .env.production.example .env.production
```
2. Put TLS files in `infra/docker/nginx/certs/` (matching `.env.production`):
- `NGINX_SSL_CERT_FILE`
- `NGINX_SSL_KEY_FILE`
3. Start serving:
```bash
./scripts/prod-up.sh
```

Open:
- `https://localhost:3443` (or your `PROD_NGINX_HTTPS_PORT`)

Data persistence:
- Default uses Docker named volumes.
- Optional: set `PROD_POSTGRES_DATA_MOUNT` / `PROD_REDIS_DATA_MOUNT` in `.env.production` to absolute host paths.

## Operations
- Status: `./scripts/prod-status.sh`
- Stop: `./scripts/prod-down.sh`

## Developer Docs
- [Developer Guide](./doc/Developer-Guide.md)
- [AGENTS runbook](./AGENTS.md)

## License
Apache License 2.0. See [LICENSE](./LICENSE).
