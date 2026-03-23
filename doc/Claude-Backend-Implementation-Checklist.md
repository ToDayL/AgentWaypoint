# Claude Backend Implementation Checklist

Last updated: 2026-03-23

## Core Delivery

- [x] 1. API models contract upgrade
  - Add `backend` query support to `GET /api/models?backend=...`
  - Add `backend` field to `AvailableModel` response items

- [x] 2. Web project form backend-driven model loading
  - Select backend first in create/edit project flow
  - Query model list by selected backend
  - Default model = first `isDefault`, else first model

- [x] 3. Project schema validation for claude
  - `backend=claude` requires `backendConfig.model + backendConfig.executionMode`

- [x] 4. Runner claude backend skeleton + routing
  - Route turns/thread endpoints by backend (`codex` / `claude` / `mock`)

- [x] 5. Claude turn minimal loop
  - One turn uses one `query(...)`
  - Initial input + streaming output mapped to normalized events

- [x] 6. Turn effective config persistence
  - Persist `effectiveBackendConfig` and `effectiveRuntimeConfig` from `turn.started`

- [x] 7. Steer on same query stream
  - Append steer input to active input queue
  - No steer-triggered new turn/query

- [x] 8. Steer terminal protection
  - Terminal turns reject steer (`409` at API level)

- [x] 9. Approval flow
  - Map Claude permission request to `turn.approval.requested`
  - Resolve via approval endpoint and emit `turn.approval.resolved`

- [x] 10. Session thread id generalization
  - Use `Session.backendThreadId`
  - Remove codex-specific active schema field

- [x] 11. Fork behavior
  - Claude fork via SDK `forkSession`
  - Conversation branch semantics (no filesystem snapshot)

- [x] 12. E2E and typecheck gates
  - `./scripts/test-api-e2e.sh`
  - `corepack pnpm --filter @agentwaypoint/{api,runner,web} typecheck`

## Additional Implemented Items

- [x] 13. Claude model discovery switched to SDK
  - Use `query(...).supportedModels()` for `/api/models?backend=claude`

- [x] 14. Session reuse for multi-turn
  - Start/resume turns using stored `backendThreadId`

- [x] 15. Cancel support
  - `POST /api/turns/:id/cancel` maps to Claude query interrupt + turn finalization

- [x] 16. Timeline parity enhancements
  - Reasoning deltas emitted (`reasoning.delta`)
  - Tool lifecycle events enriched (`tool.started/output/completed`)
  - Bash output forwarded when available

- [x] 17. Diff payload compatibility
  - Build frontend-compatible aggregated turn diff payload from Claude tool outputs
  - Aggregate multiple diff updates by file within a turn

- [x] 18. Context remaining estimation
  - Fetch usage via `/context` and emit `thread.token_usage.updated`

- [x] 19. Manual compact support
  - Compact by resuming thread and sending `/Compact`

- [x] 20. Slash-command suggestions (Claude-only)
  - Populate command suggestions from `supportedCommands()`
  - Only trigger when user input starts with `/`

- [x] 21. Thread close cleanup
  - Delete Claude session file under `~/.claude/projects/<encoded-cwd>/<threadId>.jsonl`

## Notes

- No documented TS V1 `deleteSession` API is currently used; close-thread is file-delete based.
- Claude runtime semantics are configured per project via `backendConfig` (`model + executionMode`), not via many behavior env toggles.
