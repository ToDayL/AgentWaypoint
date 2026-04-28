# Auto-Approve for Tool Approval Requests — Design

## Context

Today every approval request (command execution, file change, additional permissions) blocks the running turn until the user clicks Approve / Decline in the web UI. That's the right default for interactive use, but it makes two things impossible:

- **Long-running interactive sessions** where the user trusts the agent for a window of time and just wants it to keep going.
- **Cron-triggered turns** (planned, not yet built) which have no human at the keyboard at all.

We add a per-session "auto approve" knob with a per-request timeout. When enabled, an approval is silently accepted after `N` seconds unless the user intervenes (`N = 0` accepts immediately, with no UI prompt). Cron jobs will set the same flag at the per-turn level when they enqueue a turn.

## Goals

1. **Server-side authority** — the timer runs in the API, survives a UI tab close, and uses the same code path whether the trigger is a human or cron.
2. **Per-turn snapshot** — a turn's auto-approve behavior is frozen at turn-start. Mid-turn session edits don't change a running turn (predictable for cron).
3. **One approval visible at a time** — the codex backend can fire several approval requests concurrently; the API queues them so the user only ever sees one. Timers only run for the request the user is actually looking at.
4. **Pauseable** — the user can click the countdown ring to pause "I want to think". Click again to resume.
5. **Restart-safe** — if the API restarts mid-countdown, pending timers are recovered from DB on boot.

## Non-goals

- Per-approval-kind policy (e.g. auto-approve file changes but always prompt for commands). Single global flag for v1.
- Approving on behalf of a different user. Auto-approves run as the session owner.
- Rate-limiting / max auto-approve count per turn. Out of scope; add later if needed.

## Storage

Three layers, all on the existing `Session.meta` JSON, the existing `Turn.effectiveRuntimeConfig` JSON, and a small set of new columns on `TurnApproval`. SQLite + `prisma db push` (no migration history on the lightweight branch), so column additions are cheap.

### Session (existing JSON, no schema change)

```jsonc
session.meta = {
  runtime: {
    backend: "codex",
    cwd: "...",
    backendConfig: { ... },
    autoApprove: false,                  // NEW (default false)
    autoApproveTimeoutSeconds: 10        // NEW (default 10, range 0..3600; 0 = approve immediately)
  },
  override: { ... }
}
```

### Turn (existing JSON, no schema change)

`Turn.effectiveRuntimeConfig` already stores backend/sandbox/approvalPolicy/cwd captured at turn start. We add the same two fields:

```jsonc
turn.effectiveRuntimeConfig = {
  cwd, model, sandbox, approvalPolicy,
  autoApprove,                          // NEW: copied from session at turn start
  autoApproveTimeoutSeconds              // NEW
}
```

Cron-launched turns will set these directly in the turn-start payload, bypassing the session value — same downstream behavior.

### TurnApproval (new columns via `prisma db push`)

```prisma
model TurnApproval {
  // ...existing fields...
  status              String     // 'queued' | 'pending' | 'resolved'
  publishedAt         DateTime?  // NEW: when the request became visible to the user
  autoApproveAt       DateTime?  // NEW: scheduled auto-fire deadline
  pausedAt            DateTime?  // NEW: non-null while user has paused the timer
  pausedRemainingMs   Int?       // NEW: ms left when paused, used to re-arm on resume
}
```

`status` gains a new `'queued'` value (waiting in line, not visible). The existing `'pending'` now means *currently shown to the user*. `'resolved'` is unchanged.

## Components

### 1. Approval queue (new module: `apps/api/src/modules/turns/approval-queue.service.ts`)

A NestJS service that owns:

- A `Map<string, NodeJS.Timeout>` keyed by `${turnId}:${requestId}` for active auto-approve timers.
- Methods:
  - `enqueue(turnId, requestId, payload)` — called when `turn.approval.requested` is ingested. Inserts row with `status='queued'`, then calls `tryPublishNext(turnId)`.
  - `tryPublishNext(turnId)` — if no `status='pending'` row exists for this turn, pop the oldest `status='queued'` row, set `status='pending'`, set `publishedAt=now`, compute `autoApproveAt = publishedAt + timeoutMs` (only if turn has `autoApprove=true`), persist, schedule timer, and append a `turn.approval.requested` event (so the UI sees it). When `timeoutMs === 0`, fire on `process.nextTick` instead of `setTimeout` so the UI never has to render a 0-second countdown.
  - `pause(turnId, requestId)` — must be `status='pending'` and not already paused. Compute `pausedRemainingMs = autoApproveAt - now`, set `pausedAt=now`, clear `autoApproveAt`, cancel timer, persist, emit `turn.approval.timer_paused`.
  - `resume(turnId, requestId)` — must be paused. Compute new `autoApproveAt = now + pausedRemainingMs`, clear `pausedAt`/`pausedRemainingMs`, re-arm timer, persist, emit `turn.approval.timer_resumed`.
  - `cancel(turnId, requestId)` — manual approve/decline path. Cancel timer, no event needed (the existing `turn.approval.resolved` covers it).
  - `recoverOnBoot()` — query `status='pending' AND autoApproveAt IS NOT NULL AND pausedAt IS NULL`. For each, schedule a timer; if `autoApproveAt <= now`, fire immediately. Run from `OnModuleInit`.

Timer fire path → call `TurnsService.resolveTurnApprovalForSystem(turnId, requestId, 'accept')` (new system-actor entrypoint that bypasses user-ownership checks since the turn already had a verified user when it started).

After any resolution (manual or timer), `tryPublishNext(turnId)` is called to publish the next queued approval, if any.

### 2. Turn ingestion change (`turns.service.ts`)

`ingestRunnerEvent('turn.approval.requested')` currently inserts the `TurnApproval` row directly and emits to clients. Change it to:

- Build the request payload (existing `normalizedPayload`).
- Call `approvalQueue.enqueue(turnId, requestId, normalizedPayload)`. The queue service decides whether to also persist a public event right now (when published) or hold it back (when queued).

The user-facing event is emitted only on publish; queued approvals are invisible.

### 3. Turn-start change (`turns.service.ts`)

When a new turn is created, copy `session.meta.runtime.autoApprove` and `autoApproveTimeoutSeconds` into the turn's `effectiveRuntimeConfig`. The auto-approve service reads these from the turn (not the session) so cron and live edits behave identically.

### 4. Pause/Resume endpoint (`turns.controller.ts`)

```
POST /api/turns/:id/approval/timer
body: { requestId: string, action: 'pause' | 'resume' }
```

Forwards to `approvalQueue.pause` / `.resume`. Returns the updated approval state. Emits the corresponding `turn.approval.timer_paused` / `turn.approval.timer_resumed` event so other tabs / the inspector stay in sync.

### 5. Session settings (`sessions.schemas.ts`, `sessions.service.ts`)

Extend `UpdateSessionBodySchema`:

```ts
{
  title?: string,
  backendConfig?: BackendConfig,
  autoApprove?: boolean,
  autoApproveTimeoutSeconds?: number  // int, 0..3600 (0 = approve immediately)
}
```

In `updateByIdForUser`, write the two fields into `nextMeta.runtime` (preserving any existing values not in the update).

`CreateSessionBody` is left as-is for now; new sessions inherit defaults (`false`, `10`) on first read.

### 6. Web UI (`apps/web/src/app/page.tsx`)

- Extend `readSessionRuntimeConfig` to expose `autoApprove` and `autoApproveTimeoutSeconds`.
- Session config panel: add a checkbox "Auto-approve tool requests" + a numeric input "Timeout (s)" gated to enabled state. Persist via the existing PATCH path.
- Approval card (`pendingApproval` rendering):
  - Read `autoApproveAt` / `pausedAt` / `pausedRemainingMs` from the approval payload (the same `pendingApproval` object — just new fields).
  - Render an SVG countdown ring at the top-right of the card. Animation driven by a per-second `setInterval` ticking against `Date.now()`. When `autoApproveAt - now <= 0`, the server will (in a moment) fire — the UI just shows 0.
  - Click handler on the ring: if running, POST `{action:'pause'}`; if paused, POST `{action:'resume'}`. Local state updates optimistically, then the server's emitted event reconciles.
  - When the approval is replaced (next in queue), the UI sees a fresh `turn.approval.requested` and starts a new ring.

## Event payload additions

Existing event:

```jsonc
"turn.approval.requested": {
  // ...existing kind/payload...
  autoApproveAt: "2026-04-27T10:30:00.000Z" | null,
  pausedAt: null,
  pausedRemainingMs: null
}
```

New events:

```jsonc
"turn.approval.timer_paused": {
  requestId,
  pausedAt: "...",
  pausedRemainingMs: 7234
}

"turn.approval.timer_resumed": {
  requestId,
  autoApproveAt: "..."
}
```

These reuse the existing event-stream infrastructure (`appendEvent` → SSE → web). Add the type names to the `RunnerEventType` union or the API-side equivalent (these are API-internal, not runner events; so they live in the API event types only).

## Files to touch

| File | Change |
|---|---|
| `apps/api/prisma/schema.prisma` | Add 4 columns to `TurnApproval`. |
| `apps/api/src/modules/sessions/sessions.schemas.ts` | Accept `autoApprove` + `autoApproveTimeoutSeconds`. |
| `apps/api/src/modules/sessions/sessions.service.ts` | Persist into `meta.runtime`. |
| `apps/api/src/modules/turns/approval-queue.service.ts` | NEW. Queue + timers. |
| `apps/api/src/modules/turns/turns.service.ts` | Wire `enqueue` from `ingestRunnerEvent`; snapshot session config into turn `effectiveRuntimeConfig`; new `resolveTurnApprovalForSystem`. |
| `apps/api/src/modules/turns/turns.controller.ts` | `POST /api/turns/:id/approval/timer`. |
| `apps/api/src/modules/turns/turns.module.ts` | Register `ApprovalQueueService`. |
| `apps/api/src/modules/turns/turns.schemas.ts` | Pause/resume body. |
| `apps/api/src/modules/turns/runner-event.types.ts` (or wherever event types live) | Add `turn.approval.timer_paused` / `_resumed`. |
| `apps/api/src/modules/channels/plugins/web/web-app.controller.ts` | Mirror the new pause/resume route under `/api/channels/plugins/web/app/turns/:id/approval/timer` so the existing web→API proxy works. |
| `apps/web/src/app/page.tsx` | Read auto-approve fields, render toggle + numeric, render countdown ring, wire pause/resume. |

## Verification

1. **Unit-style local probe**: enable auto-approve with `timeout=3`, trigger an approval, observe it auto-resolve in ~3s without UI interaction. Inspect DB: row goes `pending → resolved` with `autoApproveAt` set and `decision='accept'`.
2. **Zero-timeout fast path**: enable auto-approve with `timeout=0`, trigger an approval. The UI never sees `pendingApproval`; the row goes `queued → pending → resolved` within the same event-loop tick. The next event after `turn.approval.requested` is `turn.approval.resolved` with `decision='accept'`.
3. **Pause then resume**: enable auto-approve with `timeout>=5`, trigger an approval, wait ~1s, click ring (pause). Wait 5s. Click again (resume). Approval should auto-fire ~timeout-1s after resume — i.e. remaining-time math is correct.
4. **Multiple parallel codex approvals**: contrive a turn that emits two approvals back-to-back (e.g. two file writes). UI shows only the first; resolving it (manually or auto) reveals the second; the second's timer starts at that publish moment, not at the original codex emit time.
5. **API restart mid-countdown**: enable auto-approve with `timeout=30`, trigger approval, restart API at 10s remaining. Approval should still fire roughly on time (DB-backed).
6. **Auto-approve disabled**: existing manual flow unchanged. No `autoApproveAt`. Ring not rendered.
7. **Cron handoff readiness**: a turn-start payload with `effectiveRuntimeConfig.autoApprove=true, autoApproveTimeoutSeconds=0` makes every approval auto-resolve immediately (zero-timeout = next tick). Confirms the per-turn snapshot path.

## Open call-outs

- **Decline via auto?** v1 always auto-accepts. If user wants safety, they leave auto-approve off. Future config could add `autoDecideAs: 'accept' | 'decline'`.
- **Concurrency**: queue ops touch `TurnApproval` rows. Wrap publish + cancel in `prisma.$transaction` to avoid races between the ingest path (publishing next) and a manual user resolve happening at the same moment.
