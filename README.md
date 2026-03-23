# AgentWaypoint

AgentWaypoint offers a WebUI for backend-driven coding agents through a runner service.
Currently supported backends: `codex`, `claude`.

## What It Offers
- WebUI chat interface with streaming responses for Codex and Claude backends.
- Project and session management for organized workspaces.
- Multi-user support with role-based access.
- Tooling insights (events/diff/tool output) for turn inspection.
- Extensible interface layer; Discord and other clients are planned next.
- Self-hosted deployment with Docker and a host runner service.

## Production Quick Start
Prerequisite:
- Docker + Docker Compose
- Bash
- Node.js `22.x` recommended
- `corepack` (or `pnpm`) available on host
- Codex CLI installed on host (`codex` in `PATH`) when using codex backend
- Claude runtime dependencies installed on host when using claude backend
- Login on host before startup for enabled backends

1. Prepare env:
```bash
cp .env.production.example .env.production
```
Set admin bootstrap values for first startup:
- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_DISPLAY_NAME` (optional)

Set a strong runner token (required for production security):
- `RUNNER_AUTH_TOKEN` (same value is used by API -> runner and runner auth check)
- Generate one on host: `openssl rand -hex 32`

Configure enabled backends for this deployment:
- Set `RUNNER_SUPPORTED_BACKENDS` in `.env.production` (comma-separated), for example:
  - `RUNNER_SUPPORTED_BACKENDS=codex,claude`
  - `RUNNER_SUPPORTED_BACKENDS=codex`
  - `RUNNER_SUPPORTED_BACKENDS=claude`

Security note:
- `prod-up` bootstraps admin only when no admin exists.
- After first successful login, immediately change the admin password in Settings.
- Then clear `BOOTSTRAP_ADMIN_PASSWORD` from `.env.production`.

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
