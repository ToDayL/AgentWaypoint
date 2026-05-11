# Auto-Approve for Tool Approval Requests

Last aligned with implementation: 2026-05-11

## 1. Current Behavior

Auto-approve is implemented for turn approval requests. A session can enable:

- `autoApprove: boolean`
- `autoApproveTimeoutSeconds: number` in range `0..3600`

At turn start, the API snapshots those values into `Turn.effectiveRuntimeConfig`. Mid-turn session edits do not alter the running turn.

When the runner emits `turn.approval.requested`, API does not immediately expose every request. It queues approvals so only one approval is pending and visible per turn. If auto-approve is enabled, the visible approval is accepted automatically after the configured timeout unless a user pauses or resolves it first.

## 2. Data Storage

### Session Metadata

`Session.meta.runtime` stores:

```json
{
  "backend": "codex",
  "cwd": "/workspace/path",
  "backendConfig": {
    "model": "gpt-5-codex",
    "executionMode": "safe-write"
  },
  "autoApprove": false,
  "autoApproveTimeoutSeconds": 10
}
```

### Turn Snapshot

`Turn.effectiveRuntimeConfig` is initialized with:

```json
{
  "autoApprove": false,
  "autoApproveTimeoutSeconds": 10
}
```

`turn.started` ingestion later merges backend runtime fields such as `cwd`, `model`, `sandbox`, `approvalPolicy`, `permissionMode`, and preserves the auto-approve fields.

### TurnApproval

Active schema fields:

```prisma
model TurnApproval {
  turnId            String
  requestId         String
  kind              String
  status            String
  payload           Json
  decision          String?
  createdAt         DateTime
  resolvedAt        DateTime?
  publishedAt       DateTime?
  autoApproveAt     DateTime?
  pausedAt          DateTime?
  pausedRemainingMs Int?
}
```

Current status values used by the implementation:

- `queued`: waiting behind another visible approval.
- `pending`: visible to the user and eligible for timer handling.
- `approved`: resolved positively.
- `rejected`: resolved negatively.

## 3. API and Service Components

### ApprovalQueueService

File: `apps/api/src/modules/turns/approval-queue.service.ts`

Responsibilities:

- Insert approval rows as `queued`.
- Promote the oldest queued approval to `pending` when no pending approval exists for that turn.
- Append `turn.approval.requested` only when an approval is published.
- Schedule auto-approve timers from `autoApproveAt`.
- Pause/resume timers.
- Recover pending timers on module startup.
- Promote the next queued approval after resolution.

Timer fire path resolves the approval with Codex/Claude decision `accept`.

### TurnsService

File: `apps/api/src/modules/turns/turns.service.ts`

Responsibilities:

- Snapshot session auto-approve settings when creating a turn.
- Hand `turn.approval.requested` ingestion to `ApprovalQueueService`.
- Normalize legacy user decisions:
  - `approve` -> `accept`
  - `reject` -> `decline`
- Persist approval resolution as `approved` or `rejected`.

### Controller Endpoint

```http
POST /api/turns/:id/approval/timer
```

Body:

```json
{
  "approvalId": "request-id",
  "action": "pause"
}
```

`action` is `pause` or `resume`.

The same operation is mirrored under:

```http
POST /api/channels/plugins/web/app/turns/:id/approval/timer
```

## 4. Events

Published approval request payloads include timer fields:

```json
{
  "requestId": "req",
  "kind": "command_execution",
  "autoApproveAt": "2026-05-11T10:30:00.000Z",
  "pausedAt": null,
  "pausedRemainingMs": null
}
```

Timer control events:

```json
{
  "requestId": "req",
  "pausedAt": "2026-05-11T10:30:05.000Z",
  "pausedRemainingMs": 7234
}
```

```json
{
  "requestId": "req",
  "autoApproveAt": "2026-05-11T10:30:13.000Z"
}
```

Event names:

- `turn.approval.timer_paused`
- `turn.approval.timer_resumed`

These are API-internal events persisted to `Event` and streamed like runner events.

## 5. Web UI

`apps/web/src/app/page.tsx` currently:

- Reads auto-approve fields from session runtime metadata.
- Exposes session config controls for auto-approve and timeout.
- Shows a countdown control on pending approval cards when `autoApproveAt` is present.
- Sends pause/resume requests with `{ approvalId, action }`.
- Reconciles state from SSE events and turn-status polling.

## 6. Verification Checklist

- Enable auto-approve with timeout `3`; trigger approval; verify auto-resolution with decision `accept`.
- Enable timeout `0`; verify immediate server-side acceptance.
- Pause then resume; verify remaining-time math.
- Emit multiple approval requests; verify one visible approval at a time.
- Restart API during a pending timer; verify recovery on boot.
- Disable auto-approve; verify manual approval behavior is unchanged.

## 7. Known Limits

- Auto decision is always accept.
- There is no per-kind policy.
- Timers are in-memory but recovered from persisted `TurnApproval` rows.
- Cron-triggered turns are not implemented yet, although the per-turn snapshot model supports them.
