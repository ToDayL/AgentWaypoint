# AgentWaypoint Tech Stack and Repo Structure

Last aligned with implementation: 2026-05-11

## 1. Active Stack

- Language: TypeScript.
- Package manager: pnpm via Corepack.
- Runtime: Node.js `>=22 <23`.
- Web: Next.js App Router + React 19.
- API: NestJS 11 + Fastify adapter.
- Validation: Zod at API boundaries.
- Database: SQLite through Prisma.
- Streaming: Server-Sent Events.
- Runner: embedded API service for Codex, Claude, and mock backends.
- Channels: in-process channel gateway with web and Discord plugins.
- Tests: Vitest for package tests and API e2e tests.
- Formatting/linting: Prettier and ESLint.

PostgreSQL, Redis, Docker Compose, nginx, and a separate `apps/runner` package are not part of the current implementation.

## 2. Runtime Layout

```text
AgentWaypoint/
  agent-waypoint               # host launcher wrapper
  scripts/
    agent-waypoint.mjs         # background process manager
    dev-up.sh                  # isolated dev home wrapper
    dev-status.sh
    dev-down.sh
    prod-up.sh
    prod-status.sh
    prod-down.sh
    test-api-e2e.sh
  apps/
    api/
      prisma/schema.prisma     # SQLite schema
      src/
        bootstrap/             # first-run config/admin bootstrap
        modules/
          auth/
          projects/
          sessions/
          turns/
          runner/
          settings/
          channels/
          health/
    web/
      src/app/                 # Next.js UI and proxy route
  packages/
    shared/
    config/
  doc/
```

## 3. API Modules

- `auth`: password login, session cookies, dev header fallback, guards.
- `projects`: project CRUD and default workspace creation.
- `sessions`: session CRUD, fork, compact, runtime metadata.
- `turns`: turn lifecycle, event ingestion, approvals, SSE streaming.
- `runner`: `RunnerAdapter` implementations for embedded, mock, and HTTP modes.
- `settings`: user settings, Codex rate limits, admin user management.
- `channels`: bot integrations, outbound queue, gateway service, web plugin, Discord plugin.
- `health`: liveness endpoint.

## 4. Web Structure

The main UI is currently implemented in `apps/web/src/app/page.tsx` with supporting global styles and proxy routes.

Web uses:

- `/api/auth/*` for session bootstrap/login/logout/password change.
- `/api/settings/*` for user/admin settings.
- `/api/channels/integrations` for bot integrations.
- `/api/channels/plugins/web/app/*` for primary project/session/turn/model/skill/filesystem workflows.

## 5. Active API Surface

Core user-facing groups:

- `POST /api/auth/login/password`
- `POST /api/auth/logout`
- `POST /api/auth/password/change`
- `GET /api/auth/session`
- `GET|POST|PATCH|DELETE /api/projects`
- `GET|POST /api/projects/:projectId/sessions`
- `GET|PATCH|DELETE /api/sessions/:id`
- `POST /api/sessions/:id/fork`
- `POST /api/sessions/:id/compact`
- `POST /api/sessions/:id/turns`
- `GET|POST /api/turns/:id/*`
- `GET /api/models`
- `GET /api/skills`
- `GET|POST /api/fs/*`
- `GET|POST /api/settings`
- `GET|POST|PATCH|DELETE /api/channels/*`
- `GET|POST|PATCH|DELETE /api/channels/plugins/web/app/*`

See [Web-API-Runner-Contract-Inventory.md](./Web-API-Runner-Contract-Inventory.md) for details.

## 6. Runtime Choices

Default local ports:

- API: `4000`
- Web: `3000`

Default data home:

- production wrapper and direct start: `~/.agentwaypoint`
- dev wrapper: `./.agentwaypoint-dev`

Runner modes:

- `RUNNER_MODE=embedded`: current default, in-process runner.
- `RUNNER_MODE=mock`: deterministic simulated turns.
- `RUNNER_MODE=http`: external runner-compatible service at `RUNNER_BASE_URL`.

## 7. Build and Test

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm --filter @agentwaypoint/api typecheck
corepack pnpm --filter @agentwaypoint/web typecheck
./scripts/test-api-e2e.sh
```

`./agent-waypoint start` regenerates Prisma Client before database bootstrap, then builds the web app when `.next/BUILD_ID` is missing or older than tracked web/shared inputs.
