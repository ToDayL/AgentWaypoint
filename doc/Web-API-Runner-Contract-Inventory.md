# AgentWaypoint Web/API/Runner Contract Inventory

This document is derived from the current source code in:
- `apps/web`
- `apps/api`
- `apps/runner`

It answers:
1. Web endpoints and usage.
2. API-layer endpoints and usage.
3. Runner endpoints and usage.
4. Data runner passes to API (detailed schema).
5. Data API passes to web (detailed schema).

## 1) Web Endpoints

Web routing is minimal: one UI page and one proxy route.

### `GET /`
- Purpose: serves the main React UI panel (`apps/web/src/app/page.tsx`).
- Params: none.
- Used for: full project/session/turn management UI.

### `GET|HEAD|POST|PATCH|DELETE /api/[...path]`
- Purpose: Next.js BFF proxy that forwards web requests to API service.
- Source: `apps/web/src/app/api/[...path]/route.ts`.
- Path param:
  - `path: string[]` -> forwarded to upstream as `/api/${path.join('/')}`.
- Query params:
  - Passed through unchanged.
- Headers forwarded (when present):
  - `cookie`
  - `x-user-email` (dev auth mode)
  - `accept`
  - `last-event-id` (SSE resume cursor)
- Body behavior:
  - JSON bodies forwarded as raw JSON text.
  - Non-JSON request streams are piped through.
- Special behavior:
  - SSE upstream responses are re-exposed as `text/event-stream`.
  - Non-allowed methods return `405`.
  - Empty path returns `404`.

## 2) API-Layer Endpoints

All `/api/*` routes below are guarded by auth unless noted.

## Health

### `GET /api/health`
- Auth: no.
- Purpose: liveness check.
- Response: `{ "status": "ok" }`.

## Auth

### `POST /api/auth/login/password`
- Body:
  - `email: string (email, <=320)`
  - `password: string (8..512)`
- Purpose: password login; sets session cookie.
- Response:
  - `{ user: { id, email, role } }`

### `POST /api/auth/logout`
- Purpose: revoke current session token and clear cookie.
- Response: `{ "success": true }`

### `POST /api/auth/password/change`
- Body:
  - `currentPassword: string (8..512)`
  - `newPassword: string (8..512)`
- Purpose: rotate current authenticated user password.
- Response: `{ "success": true }`

### `GET /api/auth/session`
- Purpose: return current auth principal.
- Response:
  - Authenticated:
    - `{ authenticated: true, principal: { type: "user", userId, email, role, authMethod } }`
  - Unauthenticated:
    - `{ authenticated: false }`

## Projects

### `GET /api/projects`
- Purpose: list current user projects.
- Response: `Project[]`

### `POST /api/projects`
- Body:
  - `name: string (1..120)` required
  - `repoPath?: string (1..512)` optional
  - `backend?: string (1..40)` optional (defaults to `codex`)
  - `backendConfig?: Record<string, unknown>` optional
    - when backend is `codex`, expected shape is:
      - `model: string (1..120)`
      - `sandbox: string (1..120)`
      - `approvalPolicy: string (1..120)`
- Purpose: create a project; if `repoPath` omitted, API auto-creates workspace via runner.
- Response: created `Project`

### `GET /api/projects/:id`
- Path params:
  - `id: string`
- Purpose: fetch one project.
- Response: `Project`

### `PATCH /api/projects/:id`
- Path params:
  - `id: string`
- Body (at least one required):
  - `name?: string`
  - `repoPath?: string|null`
  - `backend?: string`
  - `backendConfig?: Record<string, unknown>`
    - when backend is/updates to `codex`, `backendConfig` requires:
      - `model: string`
      - `sandbox: string`
      - `approvalPolicy: string`
- Purpose: update project defaults/workspace path.
- Response: updated `Project`

### `DELETE /api/projects/:id`
- Purpose: delete project (blocked if active turns exist).
- Response: `204 No Content`

## Sessions

### `GET /api/projects/:projectId/sessions`
- Purpose: list sessions under project.
- Response: `Session[]`

### `POST /api/projects/:projectId/sessions`
- Body:
  - `title: string (1..200)` required
- Purpose: create a session (no execution override fields).
- Response: created `Session`

### `GET /api/sessions/:id/history`
- Purpose: fetch full chat + turn timeline for one session.
- Response:
  - `{ session, messages, turns, activeTurnId, activeTurnStatus }`

### `POST /api/sessions/:id/fork`
- Body:
  - `title?: string`
- Purpose: clone existing conversation context into a new session/thread branch.
- Notes:
  - This is a conversation fork.
  - It does not imply filesystem/workspace snapshot isolation.
- Response: created forked `Session`

### `POST /api/sessions/:id/compact`
- Purpose: compact Codex thread context/history.
- Response: `{ accepted: true }` (HTTP `202`)

### `DELETE /api/sessions/:id`
- Purpose: delete session (blocked if turn active).
- Response: `204 No Content`

## Turns

### `POST /api/sessions/:id/turns`
- Body:
  - `content: string (1..10000)`
- Purpose: enqueue/start a new turn for a session.
- Response:
  - `{ turnId: string, status: "queued" | ... }`

### `POST /api/turns/:id/cancel`
- Purpose: cancel active turn.
- Response: turn record snapshot.

### `POST /api/turns/:id/steer`
- Body:
  - `content: string (1..10000)`
- Purpose: inject steering message while turn is queued/running.
- Notes:
  - Backend-specific behavior is allowed.
  - For Claude, expected implementation is interrupt + appended user input (not a native provider `turn/steer` RPC).
- Response: `TurnStatusResponse`

### `POST /api/turns/:id/approval`
- Body:
  - `approvalId: string`
  - `decision:`
    - `"approve" | "reject" | "accept" | "acceptForSession" | "decline" | "cancel"`
    - or `acceptWithExecpolicyAmendment`
    - or `applyNetworkPolicyAmendment`
- Purpose: resolve a pending tool/file/permission approval.
- Notes:
  - Current API surface has no explicit `message` field in approval body.
  - Claude SDK can consume deny messages internally; if exposed later, API contract will need extension.
- Response: `TurnStatusResponse`

### `GET /api/turns/:id`
- Purpose: read turn status and pending approval.
- Response: `TurnStatusResponse`

### `GET /api/turns/:id/stream?since=<int?>`
- Purpose: SSE stream of normalized turn events for UI timeline/live output.
- Query:
  - `since?: number >= 0` (event sequence cursor)
- Header support:
  - `Last-Event-Id` also used as cursor.
- Response:
  - SSE events with `id=<seq>`, `event=<type>`, `data=<StreamEnvelope>`.

## Runner-backed API helpers

### `GET /api/models?backend=<string?>`
- Purpose: list available models from runner.
- Query:
  - `backend?: string` recommended; when provided, response should be scoped to that backend.
- Response: `{ data: AvailableModel[] }`
- Notes:
  - Web should query by currently selected project backend.
  - Even when scoped, each model item should include `backend` discriminator.

### `GET /api/fs/suggestions?prefix=<string>&limit=<1..50?>`
- Purpose: workspace directory autocomplete.
- Response: `{ data: string[] }`

### `GET /api/fs/tree?path=<string>&limit=<1..500?>`
- Purpose: list directory entries.
- Response: `{ data: WorkspaceTreeEntry[] }`

### `GET /api/fs/file?path=<string>&maxBytes=<1024..1048576?>`
- Purpose: load text preview of file.
- Response: `{ path, content, truncated }`

### `GET /api/fs/file-content?path=<string>`
- Purpose: stream binary file content (images/pdf).
- Response:
  - raw binary bytes
  - `Content-Type` from runner mime type
  - `X-AgentWaypoint-File-Path` header

### `POST /api/fs/upload` (multipart/form-data)
- Form fields:
  - `workspacePath: string`
  - `file: binary` (single file, <=20MB)
- Purpose: upload file into `<workspace>/uploads/`.
- Response: `{ path, relativePath, size, mimeType }`

## Settings / Admin

### `GET /api/settings`
- Purpose: get user app settings.
- Response: `{ turnSteerEnabled: boolean, defaultWorkspaceRoot: string|null }`

### `POST /api/settings`
- Body (at least one field required):
  - `turnSteerEnabled?: boolean`
  - `defaultWorkspaceRoot?: string|null`
- Purpose: update user app settings.
- Response: same schema as `GET /api/settings`.

### `GET /api/settings/account/rate-limits`
- Purpose: fetch Codex account rate limits via runner.
- Response:
  - `{ rateLimits: RateLimitSnapshot|null, rateLimitsByLimitId: Record<string, RateLimitSnapshot>|null }`

### `GET /api/settings/users` (admin only)
- Purpose: list users.
- Response: `AdminManagedUser[]`

### `POST /api/settings/users` (admin only)
- Body:
  - `email: string`
  - `displayName?: string|null`
  - `password: string`
  - `role?: "admin"|"user"` (default user)
  - `isActive?: boolean` (default true)
  - `defaultWorkspaceRoot?: string|null`
- Purpose: create managed user.
- Response: created user object.

### `PATCH /api/settings/users/:id` (admin only)
- Body (at least one):
  - `displayName?: string|null`
  - `password?: string`
  - `role?: "admin"|"user"`
  - `isActive?: boolean`
  - `defaultWorkspaceRoot?: string|null`
- Purpose: update managed user.
- Response: updated user object.

## Internal ingestion endpoint (runner -> API push mode)

### `POST /internal/runner/turns/:turnId/events`
- Auth:
  - optional bearer token check via `RUNNER_AUTH_TOKEN`.
- Body:
  - `type`: enum
    - `turn.started`
    - `assistant.delta`
    - `turn.approval.requested`
    - `turn.approval.resolved`
    - `plan.updated`
    - `reasoning.delta`
    - `diff.updated`
    - `tool.started`
    - `tool.output`
    - `tool.completed`
    - `turn.completed`
    - `turn.failed`
    - `turn.cancelled`
  - `payload: Record<string, unknown>` (default `{}`)
- Purpose: alternate event ingest path (API currently primarily consumes runner SSE pull stream).

## 3) Runner Endpoints

Base prefix: `/runner`.

### `GET /runner/health`
- Purpose: liveness and backend mode.
- Response:
  - `{ status: "ok", backend: "codex"|"mock", activeTurnCount: number }`
- Auth: not required.

### `GET /runner/models`
- Purpose: list available models.
- Response: `{ data: ModelListItem[] }`

### `GET /runner/account/rate-limits`
- Purpose: get account rate limits from Codex backend.
- Response: `{ rateLimits, rateLimitsByLimitId }`

### `GET /runner/fs/suggestions?prefix=<string>&limit=<int?>`
- Purpose: directory suggestions.
- Response: `{ data: string[] }`

### `GET /runner/fs/tree?path=<string>&limit=<int?>`
- Purpose: directory listing.
- Response: `{ data: { name, path, isDirectory }[] }`

### `GET /runner/fs/file?path=<string>&maxBytes=<int?>`
- Purpose: text file preview.
- Response: `{ path, content, truncated }`

### `GET /runner/fs/file-content?path=<string>`
- Purpose: binary file read.
- Response: binary bytes + headers (`content-type`, `x-agentwaypoint-file-path`).

### `POST /runner/fs/ensure-directory`
- Body: `{ path: string }`
- Purpose: mkdir (or verify existing dir).
- Response: `{ path: string, created: boolean }`

### `POST /runner/fs/upload` (multipart/form-data)
- Fields:
  - `workspacePath` (string)
  - `file` (binary)
- Purpose: save upload to `workspace/uploads`.
- Response: `{ path, relativePath, size, mimeType }`

### `POST /runner/turns/start`
- Body:
  - `turnId: string`
  - `sessionId: string`
  - `content: string`
  - `backend?: string|null`
  - `backendConfig?: Record<string, unknown>|null`
  - `threadId?: string|null`
  - `cwd?: string|null`
- Purpose: start turn execution.
- Response: `{ accepted: true, runnerRequestId: string }` (`202`)

### `GET /runner/turns/:turnId`
- Purpose: inspect runner-side stream state.
- Response:
  - `{ turnId, sessionId, status, latestSeq }`

### `GET /runner/turns/:turnId/stream?since=<int>`
- Purpose: SSE event stream for a single turn.
- SSE data payload per event: `BufferedRunnerEvent`.

### `POST /runner/turns/steer`
- Body: `{ turnId: string, content: string }`
- Purpose: steer active turn.
- Notes:
  - Claude path should be implemented as interrupt + appended input.
  - If unsupported in runtime path, runner should return explicit error (`400/409`).
- Response: `{ accepted: true, runnerRequestId }` (`202`)

### `POST /runner/turns/cancel`
- Body: `{ turnId: string }`
- Purpose: cancel active turn.
- Response: `{ accepted: true, cancelled: boolean, runnerRequestId }` (`202`)

### `POST /runner/turns/approval`
- Body:
  - `turnId: string`
  - `requestId: string`
  - `decision: ApprovalDecision`
- Purpose: resolve pending approval with active backend worker.
- Notes:
  - Backend-specific decisions are allowed; unsupported variants should fail explicitly.
  - Claude supports deny-side feedback message internally, but the current HTTP contract does not carry a custom message field.
- Response: `{ accepted: true, runnerRequestId }` (`202`)

### `POST /runner/threads/fork`
- Body: `{ threadId, backend?, backendConfig?, cwd? }`
- Purpose: fork thread.
- Notes:
  - For Claude, this is conversation-history branching.
  - It does not snapshot filesystem state.
- Response: `{ threadId: string }`

### `POST /runner/threads/close`
- Body: `{ threadId: string }`
- Purpose: archive/close thread.
- Response: `204`

### `POST /runner/threads/compact`
- Body: `{ threadId, backend?, backendConfig?, cwd? }`
- Purpose: run thread compaction.
- Response: `{ accepted: true, runnerRequestId }` (`202`)

## 4) Runner -> API Data Schema (Detailed)

There are two ingestion modes:
- Pull mode (current default): API reads runner SSE from `/runner/turns/:id/stream`.
- Push mode (available): runner can post to `/internal/runner/turns/:turnId/events`.

Important nuance:
- `thread.token_usage.updated` is supported in pull mode (`TurnsService.ingestRunnerEvent`), but it is not currently accepted by the push controller enum in `RunnerEventsController`.

Common envelope in pull mode (`RunnerStreamEvent` / `BufferedRunnerEvent`):

```ts
type RunnerStreamEvent = {
  turnId: string;
  seq: number; // monotonically increasing per turn
  type:
    | 'turn.started'
    | 'assistant.delta'
    | 'turn.approval.requested'
    | 'turn.approval.resolved'
    | 'thread.token_usage.updated'
    | 'plan.updated'
    | 'reasoning.delta'
    | 'diff.updated'
    | 'tool.started'
    | 'tool.output'
    | 'tool.completed'
    | 'turn.completed'
    | 'turn.failed'
    | 'turn.cancelled';
  payload: Record<string, unknown>;
  createdAt: string; // ISO datetime
};
```

Event payload shapes emitted by runner code:

### `turn.started`
```ts
{
  threadId?: string;
  cwd?: string;
  model?: string;
  executionMode?: 'read-only' | 'safe-write' | 'yolo';
  sandbox?: string;
  approvalPolicy?: string;
}
```

### `assistant.delta`
```ts
{ text: string } // required by API ingest
```

### `turn.approval.requested`
Command execution approval:
```ts
{
  requestId: string;
  kind: 'command_execution';
  reason: string | null;
  command: string | null;
  cwd: string | null;
  itemId: string | null;
  approvalId: string | null;
  availableDecisions: unknown[];
  additionalPermissions: Record<string, unknown> | null;
  networkApprovalContext: Record<string, unknown> | null;
  proposedExecpolicyAmendment: unknown[];
  proposedNetworkPolicyAmendments: unknown[];
  commandActions: unknown[];
  skillMetadata: Record<string, unknown> | null;
}
```

File change approval:
```ts
{
  requestId: string;
  kind: 'file_change';
  reason: string | null;
  itemId: string | null;
  grantRoot: string | null;
}
```

Permissions approval:
```ts
{
  requestId: string;
  kind: 'permissions';
  reason: string | null;
  itemId: string | null;
  permissions: Record<string, unknown> | null;
}
```

### `turn.approval.resolved`
```ts
{
  requestId: string; // required by API ingest
  decision: string;  // required by API ingest
}
```

### `thread.token_usage.updated`
```ts
{
  threadId: string | null;
  turnId: string | null; // codex turn id
  modelContextWindow: number | null;
  totalTokens: number | null;
  remainingTokens: number | null;
  remainingRatio: number | null;
}
```

### `plan.updated`
```ts
{
  explanation: string | null;
  plan: unknown[];
}
```

### `reasoning.delta`
```ts
{
  kind: 'reasoning' | 'summary' | 'plan';
  itemId: string | null;
  delta: string;
}
```

### `diff.updated`
```ts
{
  diffStat: Record<string, unknown> | null;
  diffAvailable: boolean;
  unifiedDiff: string | null;
  diff: string | null;
}
```

### `tool.started` / `tool.completed`
```ts
{
  phase: 'started' | 'completed';
  itemId: string | null;
  kind: string;   // item.type fallback 'tool'
  title: string;  // best-effort title
  status: string | null;
  command: string | null;
  text: string | null;
  path: string | null;
  item: Record<string, unknown>;
}
```

### `tool.output`
```ts
{
  kind: 'command_execution' | 'file_change';
  itemId: string | null;
  stream: string | null;
  text: string | null;
}
```

### `turn.completed`
```ts
{ content: string } // required by API ingest
```

### `turn.failed`
```ts
{
  code?: string;    // API defaults to RUNNER_FAILED when missing
  message?: string; // API defaults generic message when missing
}
```

### `turn.cancelled`
```ts
Record<string, unknown> // often {}
```

## 5) API -> Web Data Schema (Detailed)

Web consumes API in two ways:
- JSON over `/api/*` through Next proxy.
- SSE over `/api/turns/:id/stream`.

Key JSON response schemas consumed by web:

```ts
type Project = {
  id: string;
  name: string;
  backend?: string;
  backendConfig?: Record<string, unknown> | null;
  repoPath?: string | null;
  createdAt: string;
};

type AvailableModel = {
  id: string;
  backend: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean; // default within this backend
};

type Session = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
};

type TurnStatusResponse = {
  id: string;
  sessionId: string;
  backend: string | null;
  status: string;
  requestedBackendConfig: Record<string, unknown> | null;
  effectiveBackendConfig: Record<string, unknown> | null;
  effectiveRuntimeConfig: Record<string, unknown> | null;
  failureCode: string | null;
  failureMessage: string | null;
  contextRemainingRatio: number | null;
  contextRemainingTokens: number | null;
  contextWindowTokens: number | null;
  contextUpdatedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  pendingApproval: PendingApproval | null;
};

type PendingApproval = {
  id: string; // approval requestId
  kind: string;
  status: string; // pending/approved/rejected
  decision: string | null;
  createdAt: string;
  resolvedAt: string | null;
  payload: Record<string, unknown>;
};

type SessionHistory = {
  session: Session;
  messages: Array<{ id: string; role: 'user'|'assistant'|'system'; content: string; createdAt: string }>;
  turns: Array<{
    id: string;
    status: string;
    backend: string | null;
    requestedBackendConfig: Record<string, unknown> | null;
    effectiveBackendConfig: Record<string, unknown> | null;
    effectiveRuntimeConfig: Record<string, unknown> | null;
    failureCode: string | null;
    failureMessage: string | null;
    contextRemainingRatio: number | null;
    contextRemainingTokens: number | null;
    contextWindowTokens: number | null;
    contextUpdatedAt: string | null;
    createdAt: string;
    startedAt: string | null;
    endedAt: string | null;
    userMessageId: string | null;
    assistantMessageId: string | null;
  }>;
  activeTurnId: string | null;
  activeTurnStatus: string | null;
};
```

SSE schema delivered to web:

```ts
type StreamEnvelope = {
  turnId: string;
  seq: number;
  type: string; // event type
  payload: Record<string, unknown>;
  createdAt: string; // ISO datetime
};
```

Notes on API -> web event normalization:
- API persists events in DB and streams them from DB (`Event` table), not directly from runner.
- For `turn.completed`, API stores assistant message content in DB but emits stream payload as `{}`.
- For `turn.failed`, API may synthesize defaults (`failureCode`, `failureMessage`) even if payload omitted fields.
