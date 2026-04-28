# AgentWaypoint Development Workflow

Last verified: 2026-04-28

This branch runs the lightweight stack directly on the host:
- API: NestJS/Fastify
- Web: Next.js
- DB: SQLite in `AGENTWAYPOINT_HOME`
- Runner: embedded in the API process

## Safety
Do not use the live `~/.agentwaypoint` directory for development or automated tests. Use a temp or repo-local home:
```bash
AGENTWAYPOINT_DEV_HOME=./.agentwaypoint-dev
```

Do not use ports `4242` or `3443` for tests.

## Fast Path
Use orchestration scripts from repo root:
- Start dev services: `pnpm dev:up`
- Check status: `pnpm dev:status`
- Stop dev services: `pnpm dev:down`

The dev scripts default to `./.agentwaypoint-dev` unless `AGENTWAYPOINT_DEV_HOME` is already set.

## Clean Reset
Stop services and remove the dev data directory:
```bash
pnpm dev:down
rm -rf ./.agentwaypoint-dev apps/web/.next
```

## Start
```bash
pnpm dev:up
```

On first run, bootstrap prompts for admin credentials and ports. Use non-reserved ports such as API `4000` and Web `3000`.
The launcher rebuilds the web app when the existing `.next` build is missing or stale. To force a rebuild, run:
```bash
./agent-waypoint restart --home ./.agentwaypoint-dev --rebuild
```

## Verify
Status:
```bash
pnpm dev:status
```

API health:
```bash
curl http://127.0.0.1:4000/api/health
```

Open web:
```text
http://localhost:3000
```

## Stop
```bash
pnpm dev:down
```

## Tests
```bash
./scripts/test-api-e2e.sh
```

The e2e script creates a temp home and SQLite database under `/tmp`, runs Prisma generate, and executes the API specs on host.

## Notes
- If web shows `API upstream unavailable`, check `./agent-waypoint logs api --home ./.agentwaypoint-dev`.
- If Prisma client generation is missing, run `corepack pnpm --filter @agentwaypoint/api prisma:generate`.
