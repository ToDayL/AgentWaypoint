# Claude Backend Implementation Design (Rebased on main)

Last updated: 2026-03-21

## 1. Purpose

Implement a new `claude` backend in runner while keeping existing Web/API behavior stable.

This revision is aligned with current `main` (post-rebase), where:
- project config already uses `backend + backendConfig`
- codex config already uses `model + executionMode`
- turn snapshots already use `requestedBackendConfig/effectiveBackendConfig/effectiveRuntimeConfig`

## 2. Current System Baseline (from current code)

## 2.1 Architecture

- Web -> API (`/api/*`)
- API -> Runner (`/runner/*`) via `HttpRunnerAdapter`
- Runner executes backend-specific logic and emits normalized per-turn events
- API persists turn/event timeline and streams SSE to Web

## 2.2 Current backend model

Runner supports:
- `codex`
- `mock`

Project DB model:
- `Project.backend` (`codex` by default)
- `Project.backendConfig` (JSON)

Current codex config schema:
```ts
{ model: string, executionMode: 'read-only' | 'safe-write' | 'yolo' }
```

Execution mode mapping in runner/web:
- `read-only` -> sandbox=`read-only`, approvalPolicy=`on-request`
- `safe-write` -> sandbox=`workspace-write`, approvalPolicy=`on-request`
- `yolo` -> sandbox=`danger-full-access`, approvalPolicy=`never`

## 2.3 Turn storage (already generalized)

`Turn` now stores:
- `backend`
- `requestedBackendConfig` (abstract request snapshot)
- `effectiveBackendConfig` (abstract effective snapshot)
- `effectiveRuntimeConfig` (backend-native runtime details)

This is good for multi-backend support.

## 2.4 Remaining provider-specific DB field

`Session.codexThreadId` is still codex-specific and should be generalized for Claude.

## 3. Claude Backend Target

## 3.1 Goals

- Add `claude` backend with minimal API/Web breakage.
- Keep API orchestration layer backend-agnostic (pass-through backend/config).
- Keep the normalized event contract unchanged.
- Preserve project-scoped config model.

## 3.2 Claude project config (phase 1)

Recommended shape:
```ts
{ model: string, executionMode: 'read-only' | 'safe-write' | 'yolo' }
```

Rationale:
- same user-facing mode semantics as codex
- avoids exposing provider-specific low-level permissions in UI

Runner will map executionMode to Claude SDK permission/sandbox options internally.

## 4. API Contract and Validation Changes

## 4.1 Projects API validation

Update `apps/api/src/modules/projects/projects.schemas.ts` so backend-specific validation is by discriminator:
- `backend='codex'` -> existing codex validator
- `backend='claude'` -> new claude validator
- unsupported backend -> reject

## 4.2 Pass-through rule (important)

Keep current API behavior:
- API does not parse provider runtime config.
- API forwards `{ backend, backendConfig, cwd, threadId }` to runner.

This must remain for Claude to avoid backend logic duplication in API.

## 4.3 Session conversation id generalization

Migration plan:
1. Add `Session.backendThreadId` (nullable)
2. Backfill `backendThreadId = codexThreadId`
3. Switch API/runner usage to `backendThreadId`
4. Drop `codexThreadId`

All session operations (`turn start/fork/compact/close`) should read/write generalized field.

## 5. Runner Changes

## 5.1 New backend module

Add:
- `apps/runner/src/claude-backend.ts`

Responsibilities:
- resolve claude runtime options from `backendConfig`
- start/resume backend conversation
- emit normalized events
- manage pending approvals and decision routing
- support cancellation
- implement turn execution as a single long-lived `query(...)` with streaming input
- support steer by appending additional user input to the active streaming input queue
- use interrupt as a control action when needed, not as a replacement for streaming input

## 5.2 Router wiring in runner main

In `apps/runner/src/main.ts`, route by requested backend:
- `POST /runner/turns/start`
- `POST /runner/threads/fork`
- `POST /runner/threads/compact`
- `POST /runner/threads/close`
- `POST /runner/turns/approval`
- `POST /runner/turns/cancel`
- `POST /runner/turns/steer` (if supported)

Unsupported feature for backend should return explicit error (prefer `400/409`) instead of silent no-op.

## 5.3 Model listing

If Claude SDK has no stable pre-turn model discovery endpoint, use runner-side configured model catalog for `claude` in `GET /runner/models`.

Response shape must remain:
```ts
{ id, model, displayName, description, hidden, isDefault }
```

Model selection/query policy:
- Web should query models by selected backend (recommended: `GET /api/models?backend=<backend>`).
- Model entries should include backend discriminator to avoid ambiguity in mixed/cached lists:
```ts
{ id, backend, model, displayName, description, hidden, isDefault }
```
- `isDefault` is interpreted within backend scope.

## 6. Event Contract (Claude -> normalized runner events)

Must keep existing event types used by API/Web:
- `turn.started`
- `assistant.delta`
- `turn.approval.requested`
- `turn.approval.resolved`
- `thread.token_usage.updated`
- `plan.updated`
- `reasoning.delta`
- `diff.updated`
- `tool.started`
- `tool.output`
- `tool.completed`
- `turn.completed`
- `turn.failed`
- `turn.cancelled`

## 6.1 Required payload semantics

`turn.started` payload for Claude should include at least:
- `threadId` (backend conversation id)
- `cwd`
- `model`
- `executionMode`
- backend-native runtime fields when available (for `effectiveRuntimeConfig`)

`assistant.delta`:
- `{ text: string }`

`turn.completed`:
- `{ content: string }`

`turn.failed`:
- `{ message: string, code?: string }`

Approval events:
- requested: `{ requestId, kind, ...providerContext }`
- resolved: `{ requestId, decision }`

## 6.3 Approval response capability (confirmed behavior)

For Claude Agent SDK permission callbacks:
- deny supports an explicit message (Claude receives it), equivalent to `{ behavior: 'deny', message }`
- allow does not have a separate "approval message" channel; it allows execution with original/updated tool input

Design implication:
- `/runner/turns/approval` for claude should persist decision text for deny/reject
- if product wants extra operator notes on approve, that should be a normal follow-up user message, not approval payload

## 6.2 Sparse data policy

If Claude does not expose some classes (diff/plan/reasoning/token usage), do not fabricate values.
Emit only what is truly available.

## 7. API Persistence Behavior (no structural change needed)

Current `TurnsService` already supports generalized snapshots:
- on create: stores `requestedBackendConfig`
- on `turn.started`: stores `effectiveBackendConfig` and `effectiveRuntimeConfig`

For Claude, ensure runner provides enough `turn.started` payload to fill these consistently.

## 8. Web Requirements

## 8.1 Create/Edit project UI

- backend selector determines config form fields.
- for `claude`, show `model + executionMode`.
- default model selection logic remains:
  - prefer `isDefault=true`
  - fallback to first model item.

## 8.2 Current Session panel

Current panel already shows:
- workspace/model/executionMode from effective backend config
- dynamic `Runtime Config` key-value from `effectiveRuntimeConfig`

No hardcoded codex-only runtime fields should be added in shared panel.

## 9. Claude SDK Interface Usage Plan

Based on `doc/Claude-Agent-SDK-Interface-Summary.md`.

## 9.1 Phase 1 API surface

Use TypeScript SDK v1 (`@anthropic-ai/claude-agent-sdk`) with:
- `query(...)` stream model for turn execution
- options mapping from `executionMode/model/cwd`

Keep adapter boundary in runner so migration to v2 session APIs later is internal.

Turn implementation rule:
- For one AgentWaypoint turn, runner should start one `query(...)` call and keep it alive.
- `prompt` should be an `AsyncIterable<SDKUserMessage>` backed by an internal input queue.
- Initial user message is queued at turn start.
- Later steer messages are appended to the same queue (no second `query` call for steer).

`maxTurns` guideline:
- Set `maxTurns` as a safety cap, not `1`.
- Initial recommendation: `12` (or `16` for code-heavy tasks).
- `maxTurns` counts tool-use turns; keep budget/time guardrails as additional protection.

When `query` ends:
- On normal completion (final `ResultMessage`)
- On configured limits (e.g., `maxTurns`/budget)
- On cancellation or terminal error

At `query` end:
- finalize turn (`completed` / `failed` / `cancelled`)
- close input queue and clear active turn state

## 9.2 Approval and tool mapping

Use SDK permission/tool hooks/messages to bridge into:
- approval requested/resolved events
- tool lifecycle events

Decision translation:
- accept/reject baseline must work
- codex-specific amendment decisions are optional and should return explicit unsupported error for claude if not implementable

## 9.3 Steer mapping (streaming input first)

Claude does not expose Codex-style `turn/steer`.

Implement `/runner/turns/steer` for claude as:
1. append steer text as additional user input into the active streaming input queue
2. if needed by runtime state, trigger interrupt control and continue consuming the same `query` stream

Important:
- do not start a new `query` call for steer.
- steer requests for the same turn should be serialized (FIFO queue).
- if turn is already terminal, return explicit `409`.

## 9.4 Fork semantics (confirmed scope)

Claude SDK supports session fork (`forkSession` / `fork_session`) for conversation history branching.

Important: fork does not snapshot filesystem state.
- session history/context is branched
- working directory files/process state are shared unless the app uses isolated workspaces/worktrees

Design implication:
- API/runner docs and UI copy must describe fork as \"conversation fork\"
- do not imply isolated file changes unless a separate workspace isolation feature is enabled

## 10. Database Migration Plan (remaining)

Since turn schema is already generalized, the main DB migration left for Claude integration is session thread id generalization.

Proposed migration set:
1. add `Session.backendThreadId` nullable
2. backfill from `codexThreadId`
3. update code paths
4. remove `codexThreadId`

## 11. Test Plan

## 11.1 API e2e additions

- create project with `backend=claude`
- create turn and verify event stream + persisted snapshots
- approval request/resolution round-trip
- cancel behavior terminality
- session fork/compact capability behavior (success or explicit unsupported)

## 11.2 Runner tests

- config mapping tests for claude executionMode -> runtime options
- event mapping tests from SDK message fixtures
- terminal event idempotency tests

## 11.3 Web checks

- project form shows correct backend-specific fields
- default model auto-selection works with claude model list
- current session panel renders claude runtime config dynamically

## 12. Rollout Order

1. Add runner claude backend + routing + model source
2. Add API schema validation for `backend='claude'`
3. Add web project form backend-specific config section
4. Add session thread id generalization migration and code switch
5. run `dev-down` -> `dev-up` and API e2e
6. cleanup legacy session field

## 13. Open Decisions

1. Fork/compact support for Claude in phase 1: implement now or explicitly unsupported?
2. Claude model source: static env catalog vs future dynamic endpoint.
3. Approval decision UI: global superset vs backend-filtered actions.
4. Final `maxTurns` default for claude backend in production (`12` vs `16`).

## 14. Dependencies and Environment Configuration

## 14.1 Runtime dependencies

Required:
- Node.js `22.x` (same as repo baseline)
- `corepack` + `pnpm`
- Docker + Docker Compose (for API/Web/DB/Redis stack)
- Runner host process (same split-mode as current architecture)
- TypeScript SDK package: `@anthropic-ai/claude-agent-sdk`

Recommended:
- Keep SDK version pinned in lockfile and reviewed during upgrades.
- Add a runner startup check that logs SDK version and backend availability.

## 14.2 Development environment (Dev) configuration

The following config is in addition to existing dev stack settings in `AGENTS.md`.

Required for Claude backend development:
- `RUNNER_BACKEND=claude` (or multi-backend mode once implemented)
- `API_RUNNER_MODE=http`
- `API_RUNNER_BASE_URL=http://host.docker.internal:4700` (containerized API -> host runner)

Configuration principle:
- Do not add many behavior-control env switches.
- Runtime behavior should be determined by:
  - `backend` + `backendConfig` stored per project
  - backend capability detection in runner (supported/unsupported operations)
- If an operation is unsupported, return explicit `409`/`400` instead of feature-flag branching by env.

BackendConfig defaults in dev:
- Keep project backendConfig explicit (`model + executionMode`) to avoid hidden runtime drift.
- `executionMode` default should be `safe-write` unless product changes global default.

## 14.3 Production environment (Prod) configuration

Builds on existing `prod-up` prerequisites from `AGENTS.md` (`PROD_API_DATABASE_URL`, `PROD_API_REDIS_URL`, `JWT_SECRET`, ports).

Required for Claude in production:
- `RUNNER_BACKEND` includes/supports `claude`.
- API can reach runner (`RUNNER_BASE_URL` / network path).

Strongly recommended:
- Explicitly configure model allowlist per environment.
- Set conservative defaults for execution mode (`safe-write`) in production.
- Enable structured logging for backend decision points (backend selected, model chosen, steer fallback reason, unsupported operation errors).

## 14.4 Suggested environment variable table (Claude-related)

Minimal design target (names can be finalized during implementation):

| Variable | Scope | Required | Default | Purpose |
|---|---|---|---|---|
| `RUNNER_BACKEND` | runner | yes | `codex` | active backend mode / routing baseline |
| `RUNNER_AUTH_TOKEN` | runner/api | recommended | none | runner endpoint auth between API and runner |
| `API_RUNNER_MODE` | api | yes | `http` | API runner adapter mode |
| `API_RUNNER_BASE_URL` | api | yes | env-specific | API -> runner endpoint |

Optional (only if needed for deployment operations, not behavior switching):
- `RUNNER_CLAUDE_MODELS_JSON` for static model catalog bootstrap when dynamic discovery is unavailable.

## 14.5 Deployment and rollout checklist (Claude)

1. Verify runtime prerequisites in target environment.
2. Deploy runner version with claude backend support.
3. Deploy API with backend-aware model query and project validation.
4. Run database migration for session thread id generalization.
5. Restart services in order (`dev-down` -> `dev-up` or prod equivalent).
6. Run smoke tests:
   - `/runner/health` backend visibility
   - `/api/models?backend=claude`
   - create project (`backend=claude`) and run one turn
   - approval/steer/fork behavior checks
7. Monitor logs and error rates; rollback by switching backend routing flag if needed.
