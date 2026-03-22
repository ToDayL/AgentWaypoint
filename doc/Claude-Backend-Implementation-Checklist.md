# Claude Backend Implementation Checklist

Last updated: 2026-03-21

## Checklist

- [x] 1. API models contract upgrade
  - [x] Add `backend` query support to `GET /api/models?backend=...`.
  - [x] Add `backend` field to `AvailableModel` response items.
  - [x] Verification:
    - [x] `curl -k "https://127.0.0.1:3000/api/models?backend=codex"` returns only codex models.
    - [x] Every model item includes `backend`.

- [x] 2. Web project form backend-driven model loading (moved earlier)
  - [x] Select backend first in create/edit project flow.
  - [x] Query model list by selected backend.
  - [x] Default selected model = `isDefault` or first model.
  - [x] Verification:
    - [x] Switching backend refreshes model list.
    - [x] Submit stores exact `project.backendConfig` (`model + executionMode`).

- [x] 3. Project schema validation for claude
  - [x] Add `backend=claude` validation in `projects.schemas.ts`.
  - [x] Require `backendConfig` fields: `model + executionMode`.
  - [x] Verification:
    - [x] Create claude project missing fields => `400`.
    - [x] Create claude project with complete fields => `200/201`.

- [ ] 4. Runner claude backend skeleton + routing
  - [ ] Add `claude-backend` module skeleton.
  - [ ] Route turn/thread endpoints by backend (`codex/mock/claude`).
  - [ ] Verification:
    - [ ] `backend=claude` start request returns `202 accepted` (not unsupported backend).

- [ ] 5. Claude minimal turn loop (single query + streaming input)
  - [ ] One AgentWaypoint turn starts one `query(...)`.
  - [ ] Support initial user input only in this step.
  - [ ] Map minimal events:
    - [ ] `turn.started`
    - [ ] `assistant.delta`
    - [ ] `turn.completed`
  - [ ] Verification:
    - [ ] `/api/turns/:id/stream` receives events in order.
    - [ ] Final turn status = `completed`.

- [ ] 6. Persist effective config on `turn.started`
  - [ ] Include `model/executionMode/cwd` in `turn.started` payload.
  - [ ] Persist to `effectiveBackendConfig` + `effectiveRuntimeConfig` in API.
  - [ ] Verification:
    - [ ] `GET /api/turns/:id` returns both fields non-null and correct.

- [ ] 7. Steer via same streaming input channel
  - [ ] Implement steer as append to active input queue of the same query.
  - [ ] Use interrupt control only when needed by runtime state.
  - [ ] Verification:
    - [ ] Steering a running turn yields new `assistant.delta` output.
    - [ ] No second turn is created.

- [ ] 8. Steer FIFO + terminal protection
  - [ ] Serialize steer requests FIFO per turn.
  - [ ] Terminal turn steer returns `409`.
  - [ ] Verification:
    - [ ] Two rapid steers apply in order.
    - [ ] Steer after completion returns `409`.

- [ ] 9. Approval flow (requested/resolved)
  - [ ] Map Claude permission requests to `turn.approval.requested`.
  - [ ] Resolve via approval endpoint and emit `turn.approval.resolved`.
  - [ ] Verification:
    - [ ] Turn enters `waiting_approval`.
    - [ ] Approval call moves turn back to `running` or terminal.

- [ ] 10. Session thread id generalization
  - [ ] Add `Session.backendThreadId`.
  - [ ] Backfill from existing `codexThreadId`.
  - [ ] Switch code read/write to `backendThreadId`.
  - [ ] Verification:
    - [ ] Old sessions continue working.
    - [ ] New turn/fork/compact uses `backendThreadId`.
    - [ ] Regression tests pass.

- [ ] 11. Fork behavior (conversation branch only)
  - [ ] Implement/confirm Claude fork as history/context branch.
  - [ ] Keep no-filesystem-snapshot semantics.
  - [ ] Verification:
    - [ ] `POST /api/sessions/:id/fork` returns new session.
    - [ ] History exists in forked session.
    - [ ] Workspace path unchanged.

- [ ] 12. E2E and release gate
  - [ ] Add/update API e2e for Claude flows:
    - [ ] project create
    - [ ] session create
    - [ ] turn start
    - [ ] steer
    - [ ] approval
    - [ ] fork
  - [ ] Run validation suite.
  - [ ] Verification:
    - [ ] `./scripts/test-api-e2e.sh` passes.
    - [ ] `corepack pnpm --filter @agentwaypoint/api typecheck` passes.
    - [ ] `corepack pnpm --filter @agentwaypoint/runner typecheck` passes.
    - [ ] `corepack pnpm --filter @agentwaypoint/web typecheck` passes.
