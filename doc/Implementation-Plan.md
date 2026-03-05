# CodexPanel Implementation Plan

Last updated: 2026-03-05

## 1. Phase 0: Foundation and Tooling
1. Set up monorepo root files (`package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.editorconfig`, `.env.example`).
2. Pin runtime/tooling versions (Node 22, pnpm 10).
3. Add shared config package for TypeScript/ESLint/Prettier.
4. Add shared package for contracts and stream event types.

## 2. Phase 1: App Bootstraps
1. Bootstrap `apps/api` with NestJS + Fastify skeleton.
2. Bootstrap `apps/web` with Next.js App Router skeleton.
3. Add API health endpoint.

## 3. Phase 2: Local Development Environment
1. Add Docker dev image and `docker-compose` stack.
2. Add PostgreSQL and Redis services.
3. Add proxy-aware container env for dependency install/runtime.
4. Add Prisma schema and initial migration flow.

## 4. Phase 3: MVP Backend
1. Add auth module and token flow.
2. Add projects/sessions CRUD endpoints.
3. Add turn lifecycle endpoints (create/cancel/history).
4. Add persistence wiring for messages/events.

## 5. Phase 4: MVP Frontend
1. Add login/session management pages.
2. Add project/session selector and history views.
3. Add chat page and API client integration.

## 6. Phase 5: Codex Integration and Streaming
1. Add runner adapter module in API.
2. Implement host `codex-runner` daemon process manager.
3. Implement normalized event mapping.
4. Implement SSE endpoint and reconnect behavior.

## 7. Phase 6: Hardening
1. Add tests (unit/integration).
2. Add lint/typecheck CI workflow.
3. Add observability baseline (structured logs, metrics/tracing hooks).

## 8. Immediate Next Work
1. Implement auth module and first CRUD endpoints in `apps/api`.
2. Add Prisma service/module wiring in Nest app.
3. Build first real web pages: login, projects/sessions list, chat shell.
4. Define and implement API <-> host runner contract.
5. Add runner adapter and SSE stream endpoint.
6. Add CI for lint/typecheck/test.
