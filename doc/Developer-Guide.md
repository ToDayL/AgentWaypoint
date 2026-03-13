# Developer Guide

This document contains development-focused setup and workflows.  
Production usage is intentionally kept in [README](../README.md).

## Project Status
- Split-container local stack is implemented.
- Core features include project/session management, streaming turns, resume, host runner integration, and approvals.

## Tech Stack
- Web: Next.js + TypeScript
- API: NestJS (Fastify) + TypeScript
- DB: PostgreSQL + Prisma
- Streaming: SSE
- Runtime topology: Docker (`web`, `api`, `postgres`, `redis`, `nginx`) + host `runner`

## Repo Layout
```text
apps/
  web/
  api/
  runner/
packages/
  shared/
  config/
infra/
doc/
scripts/
```

## Local Development
1. Copy env:
```bash
cp .env.example .env
```
2. Start stack:
```bash
./scripts/dev-up.sh
```
3. Check status:
```bash
./scripts/dev-status.sh
```
4. Stop:
```bash
./scripts/dev-down.sh
```

Default local ports:
- Web: `https://localhost:3000`
- Runner: `http://127.0.0.1:4700`

## Test Commands
- API e2e (recommended):
```bash
./scripts/test-api-e2e.sh
```
- Typecheck:
```bash
corepack pnpm --filter @agentwaypoint/api typecheck
corepack pnpm --filter @agentwaypoint/runner typecheck
corepack pnpm --filter @agentwaypoint/web typecheck
```

## Runner Modes
API side (`RUNNER_MODE`):
- `mock`: in-process simulated turns
- `http`: forwards turn control to runner service

Runner side (`RUNNER_BACKEND`):
- `codex`: real Codex app-server backend
- `mock`: fallback simulator

## Related Docs
- [PRD](./PRD.md)
- [Initial Architecture](./Architecture-Initial.md)
- [Auth Design](./Auth-Design.md)
- [Codex App Server Notes](./Codex-App-Server-Documentation.md)
- [v1 Tech Stack and Repo Structure](./V1-Tech-Stack-and-Repo-Structure.md)
- [Development Workflow](./Development-Workflow.md)
- [Runner Design Decisions](./Runner-Design-Decisions.md)
- [Implementation Plan](./Implementation-Plan.md)
- [Implementation Progress](./Implementation-Progress.md)
