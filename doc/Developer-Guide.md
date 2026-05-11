# Developer Guide

This document contains development-focused setup and workflows. Production usage is kept in [README](../README.md).

## Project Status
- Lightweight bare-metal stack is implemented.
- Core features include password/session auth, project/session management, streaming turns, fork/compact, embedded Codex/Claude/mock runner integration, approvals with auto-approve timers, workspace file browsing/upload, and web/Discord channel plugins.

## Tech Stack
- Web: Next.js + TypeScript
- API: NestJS (Fastify) + TypeScript
- DB: SQLite + Prisma
- Streaming: SSE
- Runtime topology: host API + host Web + embedded runner
- Channels: in-process gateway with web and Discord plugins

## Repo Layout
```text
apps/
  web/
  api/
packages/
  shared/
  config/
doc/
scripts/
```

## Local Development
Use a non-live data directory for development:
```bash
AGENTWAYPOINT_DEV_HOME=./.agentwaypoint-dev ./scripts/dev-up.sh
```

Check status:
```bash
./scripts/dev-status.sh
```

Stop:
```bash
./scripts/dev-down.sh
```

Default local ports:
- API: `http://localhost:4000`
- Web: `http://localhost:3000`

## Test Commands
API e2e:
```bash
./scripts/test-api-e2e.sh
```

Typecheck:
```bash
corepack pnpm --filter @agentwaypoint/api typecheck
corepack pnpm --filter @agentwaypoint/web typecheck
```

## Runner Modes
API side (`RUNNER_MODE`):
- `embedded`: in-process Codex/Claude runner
- `mock`: in-process simulated turns
- `http`: forwards turn control to an external runner-compatible service

Embedded backend configuration:
- `RUNNER_SUPPORTED_BACKENDS`
- `RUNNER_CODEX_BIN`
- `RUNNER_CODEX_CWD`
- `RUNNER_CODEX_MODEL`
- `RUNNER_CODEX_APPROVAL_POLICY`
- `RUNNER_CODEX_SANDBOX`
- `RUNNER_ALLOWED_REPO_ROOTS`
- `RUNNER_EVENT_RETENTION_MS`
- `RUNNER_EVENT_BUFFER_LIMIT`

HTTP runner compatibility configuration:
- `RUNNER_BASE_URL`
- `RUNNER_HTTP_TIMEOUT_MS`
- `RUNNER_AUTH_TOKEN`

## Web/API Routing
The web app uses the generic Next proxy at `/api/[...path]`. The primary product UI calls `/api/channels/plugins/web/app/*` for project/session/turn/model/skill/filesystem workflows, while auth, settings, and bot integration management use the core `/api/*` endpoints directly.

## Auth Notes
- First-run bootstrap creates the initial admin user.
- Password login stores opaque session tokens in `AuthSession`.
- `AUTH_DEV_EMAIL_HEADER=1` keeps the local `x-user-email` fallback enabled for development.
- WebAuthn, service accounts, API keys, and audit logs are not implemented.

## Related Docs
- [PRD](./PRD.md)
- [Auth Design](./Auth-Design.md)
- [Web/API/Runner Contract Inventory](./Web-API-Runner-Contract-Inventory.md)
- [Codex App Server Notes](./Codex-App-Server-Documentation.md)
- [Development Workflow](./Development-Workflow.md)
- [Runner Design Decisions](./Runner-Design-Decisions.md)
