# CodexPanel v1 Tech Stack and Repo Structure

## 1. Recommended v1 Stack

### 1.1 Core Languages
- TypeScript for frontend and backend.
- SQL (PostgreSQL) for persistent data.

### 1.6 Deployment
- Recommended: hybrid runtime for MVP runner integration.
- Local: `docker-compose` for `web + postgres (+redis optional)`.
- Runtime split (Option 2, revised): `web` in container, `api` on host, `codex-runner` on host.
- Production options:
  - Preferred for early versions: `api` + `codex-runner` as host/system services, `web` containerized.
  - Optional later: containerize `api` after runner API/proxy boundary is stabilized.

### 1.2 Frontend
- Framework: Next.js (App Router) + React.
- UI: Tailwind CSS + a small component library (shadcn/ui optional).
- State/data: TanStack Query for server state.
- Streaming: Server-Sent Events (SSE) client handling first.

### 1.3 Backend
- Framework: NestJS with Fastify adapter.
- API style: REST for CRUD + SSE endpoint for turn stream.
- Validation: Zod (or class-validator) at API boundary.
- Auth: JWT session tokens for MVP.

### 1.4 Data and Infra
- Database: PostgreSQL.
- ORM: Prisma.
- Cache/queue (optional in v1): Redis.
- Observability: OpenTelemetry + structured logs (pino).

### 1.5 Testing/Quality
- Unit tests: Vitest.
- API/integration tests: Supertest.
- Lint/format: ESLint + Prettier.
- Type checks in CI: `tsc --noEmit`.

## 2. Monorepo Layout (v1)

```text
CodexPanel/
  apps/
    web/                      # Next.js frontend
    api/                      # NestJS backend (BFF + runner adapter module)
  packages/
    shared/                   # Shared TS types, event schemas, API contracts
    config/                   # Shared lint/tsconfig/prettier configs
  infra/
    docker/                   # Dockerfiles, docker-compose for local dev
    runner/                   # Host runner service configs (systemd/supervisor/env)
    migrations/               # Optional raw SQL migrations (if needed)
  doc/                        # PRD, architecture, integration docs
  scripts/                    # Setup/dev scripts
  .env.example
  package.json
  pnpm-workspace.yaml
  README.md
```

## 3. Detailed Folder Design

### 3.1 `apps/web`
```text
apps/web/
  src/
    app/                      # Next.js routes/pages/layout
    components/               # Reusable UI components
    features/
      chat/                   # Chat UI, stream rendering
      sessions/               # Session list, resume flows
      projects/               # Project selector
    lib/
      api-client.ts           # REST client
      sse-client.ts           # SSE stream handling
      auth.ts                 # Token/session helpers
    styles/
  public/
  next.config.ts
```

### 3.2 `apps/api`
```text
apps/api/
  src/
    main.ts
    app.module.ts
    modules/
      auth/
      projects/
      sessions/
      turns/
      streams/                # SSE endpoint logic
      codex-runner-adapter/   # Host runner integration module
    common/
      middleware/
      guards/
      interceptors/
      logger/
      errors/
    prisma/
      prisma.service.ts
      schema.prisma
  test/
  nest-cli.json
```

### 3.3 `packages/shared`
```text
packages/shared/
  src/
    api/                      # Request/response DTO and schemas
    events/                   # Normalized event types for streaming
    db/                       # Shared enums/constants
  package.json
```

## 4. Initial API Surface (v1)
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/sessions?project_id=...`
- `POST /api/sessions`
- `GET /api/sessions/:id/messages`
- `POST /api/sessions/:id/turns`
- `POST /api/turns/:id/cancel`
- `GET /api/turns/:id/stream` (SSE)

## 5. Suggested Runtime Choices
- Package manager: pnpm.
- Node version: 22 LTS.
- Local development:
  - `web`: `http://localhost:3000`
  - `api`: `http://localhost:4000`
  - `codex-runner`: host daemon (for example `http://127.0.0.1:4700`)
  - `postgres`: `localhost:5432` (container)

## 6. Why This Setup for You
- One language across frontend/backend reduces learning burden.
- Clear module boundaries make it easier to grow gradually.
- SSE keeps streaming implementation simple for MVP.
- Monorepo keeps shared types/contracts in sync and avoids drift.

## 7. v1 Build Order (Practical)
1. Initialize monorepo + lint/typecheck/test baseline.
2. Build API auth + projects/sessions CRUD.
3. Build web login + session list + basic chat page.
4. Add host runner adapter + turn creation.
5. Add SSE streaming + cancel.
6. Add observability and error hardening.
