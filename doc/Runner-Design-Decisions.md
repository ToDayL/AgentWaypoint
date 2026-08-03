# Runner Design Decisions

Last aligned with implementation: 2026-05-11

This document records the runner model in the current repository.

## 1. Active Runtime Model

The default runner is embedded inside the API process:

- `RUNNER_MODE=embedded` returns `InProcessRunnerAdapter`.
- `EmbeddedRunnerService` owns active turns and per-turn event buffers.
- Backend implementations live under `apps/api/src/modules/runner/embedded/`.
- Supported backend ids are `codex`, `claude`, and `mock`; `RUNNER_SUPPORTED_BACKENDS` can restrict the list.

`RUNNER_MODE=http` still exists as a compatibility adapter for an external runner-compatible service, but it is not the default local runtime. There is no active `apps/runner` package in this repository.

## 2. Identity Mapping

- `Session.id` is AgentWaypoint's conversation container.
- `Session.backendThreadId` stores the backend-native thread/session id.
- `Turn.id` is AgentWaypoint's unit of execution.
- Runner events are keyed by AgentWaypoint `turnId`.

The old `Session.codexThreadId` field is no longer part of the active Prisma schema.

## 3. Turn Start Flow

For each turn:

1. API reads `Session.meta.runtime`.
2. API creates a `Message(role=user)` and `Turn(status=queued)`.
3. API snapshots requested backend config and auto-approve settings onto the turn.
4. API calls `runnerAdapter.startTurn({ turnId, sessionId, content, backend, backendConfig, threadId, cwd })`.
5. API starts a runner event consumer for that turn.
6. `turn.started` may include a backend `threadId`; API persists it to `Session.backendThreadId`.

Only one active turn is allowed per session.

## 4. Event Contract

The runner emits normalized events:

- `turn.started`
- `assistant.delta`
- `turn.approval.requested`
- `turn.approval.resolved`
- `turn.approval.auto_review`
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

API-internal approval queue events are also persisted/streamed:

- `turn.approval.timer_paused`
- `turn.approval.timer_resumed`

API persists each event in the `Event` table, assigns its own per-turn `seq`, and streams from persisted rows. Channel dispatch uses `BotMessage(kind=event, eventId=...)` as an outbox reference; the gateway hydrates the canonical event payload once before passing it to channel plugins.

## 5. Backend Config

Project and session runtime config use backend-agnostic fields:

- `backend`
- `backendConfig.model`
- `backendConfig.executionMode`
- optional backend-specific extras such as Codex `effort`

Codex execution mode mapping:

- `read-only` -> `sandbox=read-only`, `approvalPolicy=on-request`
- `safe-write` -> `sandbox=workspace-write`, `approvalPolicy=on-request`
- `auto-review` -> `sandbox=workspace-write`, `approvalPolicy=on-request`, `approvalsReviewer=auto_review`
- `yolo` -> `sandbox=danger-full-access`, `approvalPolicy=never`

Claude execution mode mapping:

- `read-only` -> `permissionMode=default`, sandbox enabled
- `safe-write` -> `permissionMode=acceptEdits`, sandbox enabled
- `yolo` -> `permissionMode=bypassPermissions`, sandbox disabled

## 6. HTTP Runner Compatibility

When `RUNNER_MODE=http`, API calls these external paths:

- `GET /runner/health`
- `GET /runner/models`
- `GET /runner/skills`
- `GET /runner/codex/rate-limits`
- `GET /runner/fs/*`
- `POST /runner/fs/*`
- `POST /runner/turns/start`
- `GET /runner/turns/:turnId/stream`
- `POST /runner/turns/steer`
- `POST /runner/turns/cancel`
- `POST /runner/turns/approval`
- `POST /runner/threads/fork`
- `POST /runner/threads/close`
- `POST /runner/threads/compact`

`RUNNER_AUTH_TOKEN` is forwarded as bearer auth when set.
