# Developer Guide

This document contains development-focused setup and workflows. Production usage is kept in [README](../README.md).

## Project Status
- Lightweight bare-metal stack is implemented.
- Core features include project/session management, streaming turns, resume, embedded runner integration, and approvals.

## Tech Stack
- Web: Next.js + TypeScript
- API: NestJS (Fastify) + TypeScript
- DB: SQLite + Prisma
- Streaming: SSE
- Runtime topology: host API + host Web + embedded runner

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
- `RUNNER_CODEX_BIN`
- `RUNNER_CODEX_CWD`
- `RUNNER_CODEX_MODEL`
- `RUNNER_CODEX_APPROVAL_POLICY`
- `RUNNER_CODEX_SANDBOX`
- `RUNNER_ALLOWED_REPO_ROOTS`

## Related Docs
- [PRD](./PRD.md)
- [Auth Design](./Auth-Design.md)
- [Codex App Server Notes](./Codex-App-Server-Documentation.md)
- [Development Workflow](./Development-Workflow.md)
- [Runner Design Decisions](./Runner-Design-Decisions.md)
