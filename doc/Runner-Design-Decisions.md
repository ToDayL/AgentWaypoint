# Runner Design Decisions

Last updated: 2026-03-10

This document records the current and target design decisions for `apps/runner` and Codex app-server usage.

## 1. Identity Mapping

- `sessionId` (CodexPanel) is the conversation container in our app.
- `threadId` (Codex app-server) is the conversation container in Codex runtime.
- Mapping rule: `1 sessionId -> 1 threadId`.
- Mapping is persisted in API DB on `Session.codexThreadId`.

## 2. Turn Start Flow

For each new turn:

1. If session has no saved thread:
   - call `thread/start`
   - persist returned `threadId`
2. If session already has saved thread:
   - call `thread/resume` with saved `threadId`
   - if resume fails, fallback to `thread/start` and persist new `threadId`
3. call `turn/start`

## 3. Event Contract

- Runner emits internal callbacks to API:
  - `turn.started` (payload includes `threadId`)
  - `assistant.delta`
  - `turn.completed`
  - `turn.failed`
  - `turn.cancelled`
- API uses `turn.started.payload.threadId` to persist/refresh session mapping.

## 4. Current Runtime Model

- Current implementation uses a long-lived `codex app-server` worker process in `apps/runner`.
- API turn requests reuse this worker; turns are isolated by `threadId`.
- This removes per-turn process startup overhead while preserving session-thread continuity.

## 5. Target Runtime Model

Scale from one long-lived worker to a small worker pool if needed.

- Granularity decision: manage app-server instances at runner worker level, not per project/session.
- Start with one persistent worker, then scale to a small pool if needed.
- Use sticky routing by `sessionId` to keep session locality on one worker.

Reasoning:
- Per-session/per-project process ownership is too expensive at scale.
- Thread context is already isolated by `threadId`.
- Worker-level pooling improves latency and resource utilization.

## 6. Protocol Clarification

- `turnId` passed to `sendCodexRequest(...)` is a local runner lookup key only.
- `thread/start` request payload does not include `turnId`.
