# AGENTS.md

## Scope
Operational runbook for local development and test execution in this repository.

## Prerequisites
- Docker + Docker Compose available.
- `corepack` available (for `pnpm`).
- Recommended Node version: `22.x` (repo engines: `>=22 <23`).

## Development Workflow

### 1. Start full dev stack
```bash
./scripts/dev-up.sh
```

What this does:
- Starts `postgres` + `redis`.
- Runs Prisma generate/migrate for API.
- Starts Docker app services: `api`, `web`, `nginx`.
- Starts host runner process.

### 2. Check service status and health
```bash
./scripts/dev-status.sh
```

Expected healthy signals:
- Docker services up: `api`, `web`, `nginx`, `postgres`, `redis`.
- Host runner shown as running.
- Health checks return:
  - API: `{"status":"ok"}`
  - Runner: `{"status":"ok", ...}`

### 3. Restart services cleanly
```bash
./scripts/dev-down.sh
./scripts/dev-up.sh
```

### 4. Stop everything
```bash
./scripts/dev-down.sh
```

## Production Deployment Workflow

### 1. Prepare production env file
Create `.env.production` (or reuse `.env`) and set at least:
- `PROD_NGINX_HTTPS_PORT` (default `3443`)
- `PROD_RUNNER_PORT` (default `5700`)
- `PROD_API_DATABASE_URL`
- `PROD_API_REDIS_URL`
- `JWT_SECRET`

### 2. Start production stack
```bash
./scripts/prod-up.sh
```

What this does:
- Starts `postgres` + `redis` using `infra/docker/docker-compose.prod.yml`.
- Runs Prisma migrate deploy for API.
- Starts Docker app services: `api`, `web`, `nginx`.
- Starts host runner process (non-watch) on `PROD_RUNNER_PORT`.

### 3. Check production status and health
```bash
./scripts/prod-status.sh
```

### 4. Stop production stack
```bash
./scripts/prod-down.sh
```

### 5. Run dev and prod on one machine
- Dev defaults: `NGINX_HTTPS_PORT=3000`, `RUNNER_PORT=4700`
- Prod defaults: `PROD_NGINX_HTTPS_PORT=3443`, `PROD_RUNNER_PORT=5700`
- Keep these port ranges distinct to avoid collisions.

## Test Procedure

### Fast checks (typecheck)
```bash
corepack pnpm --filter @agentwaypoint/api typecheck
corepack pnpm --filter @agentwaypoint/runner typecheck
corepack pnpm --filter @agentwaypoint/web typecheck
```

### API e2e (recommended)
Run API e2e in Docker so DB/networking matches service config:
```bash
./scripts/test-api-e2e.sh
```

This script:
- Ensures DB services are running.
- Runs Prisma generate + migrate inside API container.
- Executes:
  - `src/modules/api.e2e.spec.ts`
  - `src/modules/api.http-runner.e2e.spec.ts`

### Package tests
```bash
corepack pnpm --filter @agentwaypoint/api test
corepack pnpm --filter @agentwaypoint/runner test
corepack pnpm --filter @agentwaypoint/web test
```

Notes:
- `runner` and `web` currently may report “No test files found”.
- Running API tests directly on host can fail if host `DATABASE_URL` points to `localhost:5432` while Postgres is only reachable as `postgres:5432` inside Docker network.

## Troubleshooting

### API tests fail with Prisma `Can't reach database server at localhost:5432`
Use Docker test path:
```bash
./scripts/test-api-e2e.sh
```
Or ensure host-accessible Postgres and correct `DATABASE_URL`.

### Engine warning about Node version
If you see Node version warnings, switch to Node `22.x` to match `package.json` engines.
