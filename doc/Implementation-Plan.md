# AgentWaypoint Implementation Plan

Last aligned with implementation: 2026-05-11

## 1. Implemented Baseline

- Monorepo with `apps/api`, `apps/web`, `packages/shared`, and `packages/config`.
- Host launcher: `./agent-waypoint`.
- Lightweight runtime:
  - host API,
  - host Web,
  - SQLite,
  - embedded runner.
- First-run bootstrap:
  - writes `AGENTWAYPOINT_HOME/config.json`,
  - runs Prisma `db push`,
  - creates admin user.
- Auth:
  - password login,
  - server-side sessions,
  - admin user management,
  - dev `x-user-email` fallback.
- Project/session/turn workflow:
  - CRUD,
  - history,
  - streaming,
  - cancel,
  - steer,
  - fork,
  - compact.
- Runner:
  - Codex backend,
  - Claude backend,
  - mock backend,
  - external HTTP compatibility mode.
- Approvals:
  - persisted approval queue,
  - rich decision variants,
  - auto-approve timers,
  - pause/resume.
- Web UI:
  - app shell,
  - explorer,
  - file browser,
  - chat,
  - insights,
  - settings/admin panels,
  - Discord integration config.
- Channels:
  - in-process gateway,
  - web plugin,
  - Discord plugin,
  - BotMessage dispatch queue.

## 2. Current Verification Gates

```bash
corepack pnpm --filter @agentwaypoint/api typecheck
corepack pnpm --filter @agentwaypoint/web typecheck
./scripts/test-api-e2e.sh
```

The web package currently has no test files, but typecheck is active.

## 3. Near-Term Work

1. Add focused tests for Discord plugin routing, command handling, and integration lifecycle.
2. Encrypt provider credentials instead of storing raw JSON token payloads.
3. Split the large `apps/web/src/app/page.tsx` into feature components.
4. Add CSRF/rate-limit protection to cookie-authenticated auth routes.
5. Add queue retry/dead-letter behavior and admin retry UI for `BotMessage`.
6. Decide whether externalized channel gateway mode is still needed.

## 4. Medium-Term Work

1. Service-account/API-key auth for non-human clients.
2. WebAuthn/passkey support.
3. Audit log model and UI.
4. Better observability for turns, approvals, runner state, and channel delivery.
5. CI workflow for typecheck/e2e gates.
6. Broader web component and interaction tests.

## 5. Superseded Historical Plan

Earlier documents planned Docker Compose, PostgreSQL, Redis, and a separate host `codex-runner` daemon. Those are not part of the current implementation. Future moves back toward those components should be treated as new architecture work, not assumed baseline.
