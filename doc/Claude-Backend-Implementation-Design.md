# Claude Backend Implementation Design

Last updated: 2026-03-23

## 1. Purpose

This document describes the implemented Claude backend architecture in AgentWaypoint and the current design constraints for future changes.

## 2. Current Baseline (Implemented)

### 2.1 Architecture

- Web -> API (`/api/*`)
- API -> Runner (`/runner/*`) via `HttpRunnerAdapter`
- Runner routes by backend (`codex` / `claude` / `mock`)
- API persists turn/session state and streams SSE events to Web

### 2.2 Project and Turn Data Model

- `Project` stores:
  - `backend`
  - `backendConfig`
- Both `codex` and `claude` currently use:
  - `{ model: string, executionMode: 'read-only' | 'safe-write' | 'yolo' }`

`Turn` stores backend-agnostic snapshots:
- `backend`
- `requestedBackendConfig`
- `effectiveBackendConfig`
- `effectiveRuntimeConfig`

### 2.3 Session Thread Field

Session thread identity has been generalized:
- `Session.backendThreadId` is the active field
- `Session.codexThreadId` has been removed from active Prisma schema

## 3. API and Web Contracts (Implemented)

### 3.1 Models API

- `GET /api/models?backend=<backend>` is supported
- Response item includes `AvailableModel.backend`
- API passes backend filter to runner; no provider parsing in API layer

### 3.2 Project Validation

`projects.schemas.ts` validates backend-specific config:
- `backend='codex'` -> requires `model + executionMode`
- `backend='claude'` -> requires `model + executionMode`

### 3.3 Create/Edit Project UX

- Backend is selected first
- Model list is queried by backend
- Default model selection:
  - first `isDefault=true`
  - otherwise first returned item

## 4. Runner Claude Backend (Implemented)

File: `apps/runner/src/claude-backend.ts`

### 4.1 Model and Command Discovery

- Models are fetched from Claude SDK via `query(...).supportedModels()`
  - `settingSources: ['user']`
- Slash commands are fetched via `query(...).supportedCommands()`
  - `settingSources: ['user', 'project', 'local']`
  - scoped by `cwd`

### 4.2 Turn Execution Model

- One AgentWaypoint turn => one long-lived Claude `query(...)`
- Prompt input is an async queue (`AsyncIterable<SDKUserMessage>`)
- Initial user message is queued at turn start
- Steer appends additional user messages to the same queue (no new query)
- `includePartialMessages: true` for streaming assistant/reasoning deltas

### 4.3 Runtime Mapping by `executionMode`

Current mapping in runner:
- `read-only`
  - `permissionMode: 'default'`
  - `sandbox.enabled: true`
  - `sandbox.autoAllowBashIfSandboxed: false`
  - `allowDangerouslySkipPermissions: false`
- `safe-write`
  - `permissionMode: 'acceptEdits'`
  - `sandbox.enabled: true`
  - `sandbox.autoAllowBashIfSandboxed: true`
  - `allowDangerouslySkipPermissions: false`
- `yolo`
  - `permissionMode: 'bypassPermissions'`
  - `sandbox.enabled: false`
  - `allowDangerouslySkipPermissions: true`

Note: `allowUnsandboxedCommands` is currently enabled in all three mappings.

### 4.4 Session Reuse / Fork / Compact / Close

- Resume: runner passes `resume=<backendThreadId>` when session exists
- Fork: implemented with SDK `forkSession(sourceThreadId, { dir })`
- Compact: implemented by sending `/Compact` on resumed session
- Close thread: implemented by deleting Claude local session file:
  - `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
  - `<encoded-cwd>` = `cwd` with non-alphanumeric chars replaced by `-`

## 5. Event Mapping (Implemented)

Claude backend emits normalized events used by API/Web:
- `turn.started`
- `assistant.delta`
- `reasoning.delta`
- `tool.started`
- `tool.output`
- `tool.completed`
- `diff.updated`
- `turn.approval.requested`
- `turn.approval.resolved`
- `thread.token_usage.updated`
- `turn.completed`
- `turn.failed`
- `turn.cancelled`

Additional implemented behavior:
- Write/Edit/MultiEdit diff is aggregated per turn and emitted in a frontend-compatible `unifiedDiff` + `byFile.structuredPatch` payload
- Bash tool output is forwarded to timeline when available
- Context usage is estimated via `/context` output parsing and emitted as `thread.token_usage.updated`

## 6. Approval Behavior (Implemented)

- Approval requests are generated from `canUseTool(...)`
- API approval endpoint resolves pending request
- Decisions supported for Claude path:
  - `accept`
  - `acceptForSession`
  - `decline`
  - `cancel`

Important SDK constraint observed in implementation:
- `behavior: 'allow'` responses must include `updatedInput`
- `acceptForSession` uses `updatedPermissions` when suggestions exist

## 7. What API Does Not Do (By Design)

- API does not parse backend-native runtime options
- API forwards `backend + backendConfig + cwd + threadId` to runner
- Backend-specific interpretation is owned by runner backend implementations

## 8. Environment and Deployment

### 8.1 Minimal backend-control env

- `RUNNER_SUPPORTED_BACKENDS` controls enabled backends in runner
- `RUNNER_AUTH_TOKEN` secures API -> runner calls
- `RUNNER_PORT`, `RUNNER_HOST` basic runner network config

Avoid adding behavior-specific env toggles for Claude runtime semantics.
Project-level `backendConfig` must remain the source of truth.

### 8.2 Local workflow

Use repository runbook in `AGENTS.md`:
- `./scripts/dev-down.sh`
- `./scripts/dev-up.sh`
- `./scripts/dev-status.sh`
- `./scripts/test-api-e2e.sh`

## 9. Remaining Gaps / Follow-ups

- Add dedicated Claude runner route for provider-specific operational endpoints if needed (currently shared generic routes are used)
- Expand automated tests for large timeline/performance scenarios (many `reasoning.delta` events)
- Revisit executionMode mapping if Claude SDK permission/sandbox behavior changes upstream
