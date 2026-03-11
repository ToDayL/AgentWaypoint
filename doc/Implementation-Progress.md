# CodexPanel Implementation Progress

Last updated: 2026-03-11

## Architecture Decision on 2026-03-05
1. Chosen integration model: Option 2.
2. `web/api` remain containerized.
3. Codex runtime will be managed by a host-side `codex-runner` daemon.
4. API will call runner over internal API; runner owns host `codex app-server` processes.

## Architecture Decision Update on 2026-03-06
1. Keep Option 2 integration model.
2. Revise runtime topology for MVP integration:
   - `web` remains containerized.
   - `api` moves to host runtime.
   - `codex-runner` remains host-side.
3. Reason for change:
   - Reduce container-host IPC/path/permission friction while integrating runner process management and streaming.
4. Local dev target topology:
   - Docker: `web + postgres (+redis optional)`
   - Host: `api + codex-runner`

## Completed on 2026-03-05
1. Monorepo root foundation created:
   - `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.editorconfig`, `.env.example`
   - Node version markers: `.nvmrc`, `.node-version`
2. Shared packages scaffolded:
   - `packages/config` (TS base config, ESLint base config, Prettier config)
   - `packages/shared` (API contracts and stream event types)
3. App scaffolds created:
   - `apps/api` skeleton with `/api/health`
   - `apps/web` Next.js App Router minimal shell
4. Docker-first dev environment implemented:
   - `infra/docker/Dockerfile.dev`
   - `infra/docker/docker-compose.yml` with `app + postgres + redis`
   - `.dockerignore`
5. Proxy configured for containerized development:
   - `HTTP_PROXY`/`HTTPS_PROXY` sourced from local `.env` (not hardcoded in tracked files)
6. Workspace developer dependencies added:
   - TypeScript, tsx, ESLint, Prettier, Vitest, TS ESLint plugins, React TS types
7. Prisma initialized and migration applied:
   - `apps/api/prisma/schema.prisma`
   - `apps/api/prisma/migrations/20260305152716_init/migration.sql`
8. README updated for Docker-first quick start.

## Runtime Status Snapshot (2026-03-05)
1. Docker services running:
   - `codexpanel-app`
   - `codexpanel-postgres`
   - `codexpanel-redis`
2. API health check passes from inside container:
   - `GET /api/health -> {"status":"ok"}`

## Completed on 2026-03-06
1. API backend slice implemented in `apps/api`:
   - Global `PrismaModule` + `PrismaService` wiring.
   - Header-based auth stub via `x-user-email` with user upsert and request user context.
   - Consistent API error payload shape via global HTTP exception filter.
2. First CRUD endpoints implemented:
   - `GET /api/projects`
   - `POST /api/projects`
   - `GET /api/projects/:id`
   - `GET /api/projects/:projectId/sessions`
   - `POST /api/projects/:projectId/sessions`
3. Input validation and ownership checks added:
   - Zod-based request validation for params/body.
   - Owner-scoped access for projects/sessions (other users receive `404`).
4. API integration tests added and passing:
   - `apps/api/src/modules/api.e2e.spec.ts`
   - Covers auth missing header (`401`), create/list flows, validation errors (`400`), and cross-user access control.
5. Containerized verification completed:
   - `pnpm --filter @codexpanel/api typecheck` passes in `codexpanel-app`.
   - `pnpm --filter @codexpanel/api test` passes in `codexpanel-app`.
   - Host-level smoke tests against `localhost:4000` confirm project/session CRUD works.

## Runtime Topology Update on 2026-03-06
1. Local runtime switched to hybrid mode:
   - Docker: `codexpanel-web`, `codexpanel-postgres`, `codexpanel-redis`
   - Host: `apps/api` process
2. Dev tooling updates:
   - `infra/docker/docker-compose.yml` now runs `web` only (plus DB services).
   - `scripts/dev-api-host.sh` added for host API startup.

## Completed on 2026-03-10
1. Session history read path implemented:
   - API endpoint: `GET /api/sessions/:id/history`
   - Returns ordered `messages`, ordered `turns`, `activeTurnId`, and `activeTurnStatus`.
   - Web proxy route added at `/api/sim/sessions/:sessionId/history`.
2. Durable turn failure metadata added:
   - Prisma fields on `Turn`: `failureCode`, `failureMessage`.
   - Migration added: `20260310152000_add_turn_failure_fields`.
3. Turn status API added:
   - API endpoint: `GET /api/turns/:id`.
   - Includes status, timestamps, and failure metadata.
   - Web proxy route added at `/api/sim/turns/:turnId`.
4. Startup reconciliation for in-flight turns implemented:
   - On API startup, stale `queued/running` turns are marked `failed`.
   - Reconciliation reason:
     - `failureCode=RECOVERED_ON_STARTUP`
     - `failureMessage=Turn marked failed during API startup reconciliation`
   - `turn.failed` event is appended for reconciled turns.
5. Web resilience improvements delivered:
   - Session selection restores persisted history.
   - Resumed in-flight turns are explicitly indicated in UI.
   - SSE disconnect falls back to polling `GET /api/sim/turns/:id` until terminal status.
6. Validation completed:
   - `@codexpanel/api` typecheck passes.
   - `@codexpanel/web` typecheck passes.
   - Workspace tests pass (`8/8` API tests; other packages currently have no test files).
7. HTTPS reverse proxy added for local web access:
   - New `nginx` Docker service terminates TLS in front of `web`.
   - `web` is now exposed only on the Docker network and published through nginx.
   - TLS cert, key, and optional CA bundle can be mounted from `infra/docker/nginx/certs/`.
   - Default public entrypoint is `https://localhost:3000`.
8. Dev stack verification completed for HTTPS entrypoint:
   - `docker compose` stack starts with `nginx`, `web`, `postgres`, and `redis`.
   - Host `api` and `runner` health checks pass via `scripts/dev-up.sh`.
   - `curl -kI https://127.0.0.1:3000` returns `HTTP/2 200` after web startup completes.

## Backfilled Progress (already implemented in repo)
1. Turn lifecycle APIs and streaming path are implemented:
   - `POST /api/sessions/:id/turns`
   - `POST /api/turns/:id/cancel`
   - `GET /api/turns/:id/stream` (SSE)
   - Internal runner callback: `POST /internal/runner/turns/:turnId/events`
2. HTTP runner adapter mode is implemented and tested:
   - API supports `RUNNER_MODE=http` with runner base URL and optional auth token.
   - HTTP-runner e2e tests exist in `apps/api/src/modules/api.http-runner.e2e.spec.ts`.
3. Dev orchestration scripts are implemented:
   - `scripts/dev-up.sh`, `scripts/dev-down.sh`, `scripts/dev-status.sh`
   - Host service scripts: `scripts/dev-api-host.sh`, `scripts/dev-runner-host.sh`
4. Runner Codex backend integration is implemented:
   - `RUNNER_BACKEND=codex` starts/uses Codex app-server behavior.
   - `RUNNER_BACKEND=mock` remains available as fallback.
   - Runner exposes backend state in health response.
5. Runner execution model was upgraded to persistent worker reuse:
   - Long-lived Codex worker reused across turns.
   - No per-turn app-server process startup in the steady state.
6. Session/thread continuity is implemented:
   - DB field `Session.codexThreadId` persisted via migration `20260309153100_add_session_codex_thread_id`.
   - Turn flow supports `thread/start` on first turn and `thread/resume` on follow-up turns.
   - Fallback to new thread if resume fails.
7. Workspace and cwd management are implemented:
   - Project workspace (`repoPath`) validation before dispatching turns.
   - `cwd` is forwarded to runner/Codex turn operations.
   - Optional root allowlist via `RUNNER_ALLOWED_REPO_ROOTS`.
8. Web simulation UX was expanded before current turn:
   - Project form includes workspace path (`repoPath`).
   - Proxy empty-body cancel forwarding bug was fixed.
   - Hydration guard mitigations added for mobile/client attribute mismatch cases.

## Completed on 2026-03-11
1. Approval pause/resume flow implemented end-to-end:
   - API accepts runner callbacks for `turn.approval.requested` and `turn.approval.resolved`.
   - Turn status now exposes `pendingApproval` details while a turn is blocked on approval.
   - User action endpoint added: `POST /api/turns/:id/approval`.
   - Web proxy route added at `/api/sim/turns/:turnId/approval`.
2. Approval persistence added to the data model:
   - New Prisma model: `TurnApproval`.
   - Migration added: `20260310164000_add_turn_approvals`.
   - Pending approval state survives polling/history reloads because it is stored in the database.
3. Runner approval bridge implemented:
   - Host runner now captures Codex approval requests from the app-server stream.
   - Approval decisions are forwarded back to Codex through `/runner/turns/approval`.
   - Runner emits normalized approval request/resolution events back to the API.
4. Web simulation UI supports human approval:
   - Active turn panel renders approval-required state and payload details.
   - Approve/reject controls resume the paused turn.
   - SSE and polling paths both hydrate approval state correctly after reload/reconnect.
5. E2E coverage expanded for approval behavior:
   - `apps/api/src/modules/api.e2e.spec.ts` now covers approval event persistence and `pendingApproval` turn status.
   - `apps/api/src/modules/api.http-runner.e2e.spec.ts` now covers approve/resume flow through the HTTP runner adapter.
6. Validation status for this update:
   - `@codexpanel/api` typecheck passes.
   - `@codexpanel/web` typecheck passes.
   - `corepack pnpm --filter @codexpanel/api test` passes locally (`10/10` tests).

## In Progress on 2026-03-11 (uncommitted working tree)
1. Runner event surface is being expanded beyond approvals:
   - Runner now forwards `plan.updated`, `reasoning.delta`, `diff.updated`, `tool.started`, `tool.output`, and `tool.completed`.
   - API runner callback validation and turn event ingestion now accept and persist the same event types.
   - Shared stream event typings are updated so clients can consume the new events consistently.
2. Web simulation UI is being upgraded to expose richer live execution state:
   - Active turn view now accumulates separate panes for tool output, reasoning deltas, latest plan, and diff summary.
   - Stream event log descriptions were extended for plan/reasoning/diff/tool lifecycle updates.
   - UI state reset and session reload paths now clear and rehydrate the richer streamed output model.
3. Current validation status for the uncommitted changes:
   - No new verification has been recorded in this document yet for the richer event-stream UI/API changes.
