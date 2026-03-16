# AgentWaypoint Implementation Progress

Last updated: 2026-03-12

## Architecture Decision on 2026-03-05
1. Chosen integration model: Option 2.
2. `web/api` remain containerized.
3. Codex runtime will be managed by a host-side `codex-runner` daemon.
4. API will call runner over internal API; runner owns host `codex app-server` processes.

## Architecture Decision Update on 2026-03-06
1. Keep Option 2 integration model.
2. Keep both `web` and `api` containerized.
3. Keep `codex-runner` host-side as the only host-resident service.
4. Local dev target topology:
   - Docker: `nginx + web + api + postgres + redis`
   - Host: `codex-runner`
5. Communication model:
   - `api -> runner` for commands over HTTP
   - `api -> runner` for per-turn event streaming over SSE
   - no runner callback dependency on a host-exposed API port

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
   - `agentwaypoint-app`
   - `agentwaypoint-postgres`
   - `agentwaypoint-redis`
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
   - `pnpm --filter @agentwaypoint/api typecheck` passes in the containerized API environment.
   - `pnpm --filter @agentwaypoint/api test` passes in the containerized API environment.
   - CRUD flows were verified through the web/API stack rather than a host-exposed API port.

## Runtime Topology Update on 2026-03-06
1. Local runtime switched to hybrid mode:
   - Docker: `agentwaypoint-nginx`, `agentwaypoint-web`, `agentwaypoint-api`, `agentwaypoint-postgres`, `agentwaypoint-redis`
   - Host: `apps/runner` process
2. Dev tooling updates:
   - `infra/docker/docker-compose.yml` keeps `api` and `web` in separate containers.
   - `scripts/dev-up.sh` manages Docker services plus the host runner.
   - `scripts/dev-api-host.sh` remains only as fallback/manual tooling.

## Completed on 2026-03-10
1. Session history read path implemented:
   - API endpoint: `GET /api/sessions/:id/history`
   - Returns ordered `messages`, ordered `turns`, `activeTurnId`, and `activeTurnStatus`.
   - Web proxy route added at `/api/sessions/:sessionId/history`.
2. Durable turn failure metadata added:
   - Prisma fields on `Turn`: `failureCode`, `failureMessage`.
   - Migration added: `20260310152000_add_turn_failure_fields`.
3. Turn status API added:
   - API endpoint: `GET /api/turns/:id`.
   - Includes status, timestamps, and failure metadata.
   - Web proxy route added at `/api/turns/:turnId`.
4. Startup reconciliation for in-flight turns implemented:
   - On API startup, stale `queued/running` turns are marked `failed`.
   - Reconciliation reason:
     - `failureCode=RECOVERED_ON_STARTUP`
     - `failureMessage=Turn marked failed during API startup reconciliation`
   - `turn.failed` event is appended for reconciled turns.
5. Web resilience improvements delivered:
   - Session selection restores persisted history.
   - Resumed in-flight turns are explicitly indicated in UI.
   - SSE disconnect falls back to polling `GET /api/turns/:id` until terminal status.
6. Validation completed:
   - `@agentwaypoint/api` typecheck passes.
   - `@agentwaypoint/web` typecheck passes.
   - Workspace tests pass (`8/8` API tests; other packages currently have no test files).
7. HTTPS reverse proxy added for local web access:
   - New `nginx` Docker service terminates TLS in front of `web`.
   - `web` is now exposed only on the Docker network and published through nginx.
   - TLS cert, key, and optional CA bundle can be mounted from `infra/docker/nginx/certs/`.
   - Default public entrypoint is `https://localhost:3000`.
8. Dev stack verification completed for HTTPS entrypoint:
   - `docker compose` stack starts with `nginx`, `web`, `api`, `postgres`, and `redis`.
   - Host `runner` health check passes via `scripts/dev-up.sh`.
   - `curl -kI https://127.0.0.1:3000` returns `HTTP/2 200` after web startup completes.

## Backfilled Progress (already implemented in repo)
1. Turn lifecycle APIs and streaming path are implemented:
   - `POST /api/sessions/:id/turns`
   - `POST /api/turns/:id/cancel`
   - `GET /api/turns/:id/stream` (SSE)
2. HTTP runner adapter mode is implemented and tested:
   - API supports `RUNNER_MODE=http` with runner base URL and optional auth token.
   - HTTP-runner e2e tests exist in `apps/api/src/modules/api.http-runner.e2e.spec.ts`.
3. Dev orchestration scripts are implemented:
   - `scripts/dev-up.sh`, `scripts/dev-down.sh`, `scripts/dev-status.sh`
   - Host service script: `scripts/dev-runner-host.sh` (`scripts/dev-api-host.sh` retained as fallback/manual tooling)
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
   - Project workspace (`repoPath`) is forwarded by API and validated by the host runner before execution.
   - Session `cwdOverride` is resolved by API and applied as thread configuration through the runner.
   - Optional root allowlist via `RUNNER_ALLOWED_REPO_ROOTS`.
8. Web simulation UX was expanded before current turn:
   - Project form includes workspace path (`repoPath`).
   - Proxy empty-body cancel forwarding bug was fixed.
   - Hydration guard mitigations added for mobile/client attribute mismatch cases.

## Completed on 2026-03-11
1. Approval pause/resume flow implemented end-to-end:
   - API ingests streamed runner events for `turn.approval.requested` and `turn.approval.resolved`.
   - Turn status now exposes `pendingApproval` details while a turn is blocked on approval.
   - User action endpoint added: `POST /api/turns/:id/approval`.
   - Web proxy route added at `/api/turns/:turnId/approval`.
2. Approval persistence added to the data model:
   - New Prisma model: `TurnApproval`.
   - Migration added: `20260310164000_add_turn_approvals`.
   - Pending approval state survives polling/history reloads because it is stored in the database.
3. Runner approval bridge implemented:
   - Host runner now captures Codex approval requests from the app-server stream.
   - Approval decisions are forwarded back to Codex through `/runner/turns/approval`.
   - Runner exposes normalized approval request and resolution events through the per-turn event stream.
4. Web simulation UI supports human approval:
   - Active turn panel renders approval-required state and payload details.
   - Approve/reject controls resume the paused turn.
   - SSE and polling paths both hydrate approval state correctly after reload/reconnect.
5. E2E coverage expanded for approval behavior:
   - `apps/api/src/modules/api.e2e.spec.ts` now covers approval event persistence and `pendingApproval` turn status.
   - `apps/api/src/modules/api.http-runner.e2e.spec.ts` now covers approve/resume flow through the HTTP runner adapter.
6. Validation status for this update:
   - `@agentwaypoint/api` typecheck passes.
   - `@agentwaypoint/web` typecheck passes.
   - `corepack pnpm --filter @agentwaypoint/api test` passes locally (`10/10` tests).

## Completed on 2026-03-12
1. Rich runner event mapping implemented:
   - Runner now forwards `plan.updated`, `reasoning.delta`, `diff.updated`, `tool.started`, `tool.output`, and `tool.completed`.
   - API runner stream ingestion accepts and persists the same event types.
   - Shared stream event typings were expanded so clients can consume the richer stream consistently.
2. Web simulation UI exposes richer live execution state:
   - Active turn view now renders separate panes for tool output, reasoning deltas, latest plan, and diff summary.
   - Event timeline descriptions were extended for plan/reasoning/diff/tool lifecycle updates.
   - Event log behavior was adjusted so the list is preserved after turn completion and only cleared when a new turn starts or the session changes.
3. Approval decision handling expanded beyond binary approve/reject:
   - API and runner now support `accept`, `acceptForSession`, `decline`, `cancel`, `acceptWithExecpolicyAmendment`, and `applyNetworkPolicyAmendment`.
   - Legacy web/API `approve` and `reject` aliases are still normalized for compatibility.
   - Approval UI now renders richer command-approval actions when the app server provides available decisions or amendment proposals.
4. Validation and live verification completed for this update:
   - `@agentwaypoint/api` typecheck passes.
   - `@agentwaypoint/web` typecheck passes.
   - `corepack pnpm --filter @agentwaypoint/api test` passes locally (`10/10` tests).
   - Live containerized API and host runner were restarted successfully and exercised against the updated event and approval surfaces.

## Completed on 2026-03-12 (later)
1. Runtime topology was finalized around one host service:
   - `web` and `api` run as separate Docker services.
   - `postgres` and `redis` remain internal Docker services with no host-published ports.
   - `codex-runner` remains the only host-resident application service.
2. Runner-to-API callback dependency was removed:
   - Runner now buffers per-turn events and exposes `GET /runner/turns/:id` plus `GET /runner/turns/:id/stream?since=N`.
   - API opens and maintains runner SSE subscriptions for in-flight turns.
   - Host-exposed API port `4000` is no longer required for the production dev flow.
3. Session-level execution controls were added:
   - Project defaults: `defaultModel`, `defaultSandbox`, `defaultApprovalPolicy`.
   - Session overrides: `modelOverride`, `cwdOverride`, `sandboxOverride`, `approvalPolicyOverride`.
   - Session execution config is applied at thread start or resume rather than per turn.
4. Runner-backed model discovery was added:
   - Runner exposes `GET /runner/models`.
   - API exposes `GET /api/models`.
   - Web uses that live list for project and session model pickers.
5. Conversation control features were added:
   - Session fork support through API, runner, and web UI.
   - `turn/steer` support through API, runner, and web UI.
   - Steer enablement is now managed through persisted per-user settings instead of env flags.
6. Turn execution metadata was added for auditability:
   - Requested and effective `model`, `cwd`, `sandbox`, and `approvalPolicy` are persisted on `Turn`.
   - Web turn history shows requested versus effective execution config.
7. Current verification state:
   - `@agentwaypoint/api`, `@agentwaypoint/runner`, and `@agentwaypoint/web` typechecks pass.
   - `./scripts/test-api-e2e.sh` passes (`18/18` tests).
