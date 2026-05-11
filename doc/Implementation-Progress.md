# AgentWaypoint Implementation Progress

Last aligned with implementation: 2026-05-11

## Current Runtime

- Host API process: `apps/api`.
- Host Web process: `apps/web`.
- Database: SQLite through Prisma.
- Data home: `AGENTWAYPOINT_HOME`.
- Default runner: embedded in API.
- Channels gateway: embedded in API.
- Supported agent backends: `codex`, `claude`, `mock`.
- External runner compatibility: `RUNNER_MODE=http`.

Docker Compose, PostgreSQL, Redis, nginx, and a separate `apps/runner` package are not present in the current repository.

## Completed Areas

### Runtime and Bootstrap

- `./agent-waypoint` launcher supports `start`, `stop`, `restart`, `status`, and `logs`.
- Dev/prod wrapper scripts exist.
- First-run bootstrap prompts for data directory, admin credentials, and ports.
- Bootstrap writes `config.json`, creates SQLite schema, and creates an admin user.
- Web build is rebuilt automatically when missing or stale.

### API

- NestJS/Fastify app with global exception filter.
- Prisma service wired to SQLite.
- Health endpoint.
- Zod validation on API boundaries.
- Owner-scoped project/session/turn/channel access.

### Auth

- Password login/logout/session endpoints.
- Server-side `AuthSession` storage.
- HTTP-only session cookie.
- Password change endpoint.
- Admin user list/create/update endpoints.
- Dev `x-user-email` fallback.

### Projects and Sessions

- Project CRUD.
- Automatic default workspace creation.
- Backend and backend config stored on `Project`.
- Session create/list/history/update/delete.
- Session fork and compact.
- Session runtime metadata including backend, cwd, backend config, and auto-approve settings.

### Turns and Streaming

- Turn create/cancel/steer/status endpoints.
- SSE stream endpoint.
- Startup reconciliation for in-flight turns.
- Event persistence.
- Rich normalized events for assistant text, reasoning, plans, diffs, tools, approvals, token usage, completion, failure, and cancellation.

### Approvals

- `TurnApproval` table.
- Approval queue exposing one pending approval per turn.
- Rich approval decisions.
- Auto-approve timer support.
- Pause/resume timer endpoint.
- Timer recovery on API startup.

### Runner

- Embedded runner service.
- Codex backend using Codex app-server over stdio.
- Claude backend using `@anthropic-ai/claude-agent-sdk`.
- Mock backend for tests.
- Model and skill listing.
- Workspace filesystem helpers.
- Codex rate limit reader.
- HTTP runner adapter compatibility mode.

### Web

- Password sign-in flow.
- Explorer sidebar for projects/sessions.
- File browser and preview/upload flows.
- Chat timeline and prompt composer.
- Turn status, cancel, steer, approval controls.
- Insights pane for preview/diff/events.
- User settings and admin user management.
- Discord integration config UI.

### Channels

- In-process `ChannelsGatewayService`.
- Web plugin app controller under `/api/channels/plugins/web/app/*`.
- Discord plugin using `discord.js` Gateway mode.
- Bot integration CRUD.
- Bot message queue and dispatch loop.
- Event mirroring from turn events to channel messages.

### Tests

- API e2e script creates isolated temp home and SQLite DB.
- API package tests run with Vitest.
- API and Web typecheck scripts are available.

## Known Gaps

- Web package has no meaningful test files.
- Provider credentials are not envelope-encrypted.
- WebAuthn, service accounts, API keys, and audit logs are not implemented.
- Channel externalized gateway mode is not implemented.
- Queue retry/dead-letter policies are basic/incomplete.
- Observability is mostly logs, not metrics/traces.
- Main web page is large and should be decomposed.

## Historical Note

Earlier progress entries described a Docker/Postgres/Redis architecture and a separate host runner. That work has been superseded by the lightweight SQLite + embedded-runner branch. Use this file's current sections as the implementation source of truth.
