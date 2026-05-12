# AgentWaypoint Web/API/Runner Contract Inventory

Last aligned with implementation: 2026-05-11

This inventory is derived from the current source code in `apps/web` and `apps/api`.

## 1. Web Routes

### `GET /`

Serves the main React UI from `apps/web/src/app/page.tsx`.

### `GET|HEAD|POST|PATCH|DELETE /api/[...path]`

Generic Next.js proxy route.

Forwarded to API as:

```text
${API_BASE_URL or NEXT_PUBLIC_API_BASE_URL or http://localhost:4000}/api/<path>
```

Forwarded headers when present:

- `cookie`
- `x-user-email`
- `accept`
- `last-event-id`
- `content-type`
- `content-length` for non-JSON streamed bodies

SSE upstream responses are re-exposed as `text/event-stream`.

## 2. Core API Endpoints

Unless noted, routes are guarded by `AuthGuard`.

### Health

#### `GET /api/health`

No auth. Response:

```json
{ "status": "ok" }
```

### Auth

#### `POST /api/auth/login/password`

Body:

```json
{ "email": "user@example.com", "password": "password" }
```

Sets the session cookie and returns:

```json
{ "user": { "id": "...", "email": "...", "role": "admin" } }
```

#### `POST /api/auth/logout`

Revokes the current session and clears the cookie.

#### `POST /api/auth/password/change`

Body:

```json
{ "currentPassword": "...", "newPassword": "..." }
```

#### `GET /api/auth/session`

Returns either:

```json
{ "authenticated": false }
```

or:

```json
{
  "authenticated": true,
  "principal": {
    "type": "user",
    "userId": "...",
    "email": "...",
    "role": "admin",
    "authMethod": "session"
  }
}
```

### Projects

#### `GET /api/projects`

List current user's projects.

#### `POST /api/projects`

Body:

```ts
{
  name: string;                 // 1..120
  repoPath?: string;            // 1..512
  backend?: string;             // default "codex"
  backendConfig?: Record<string, unknown>;
}
```

For `backend="codex"`, `backendConfig` must be:

```ts
{ model: string; executionMode: 'read-only' | 'safe-write' | 'auto-review' | 'yolo' }
```

For `backend="claude"`, `backendConfig` must be:

```ts
{ model: string; executionMode: 'read-only' | 'safe-write' | 'yolo' }
```

If `repoPath` is omitted, API creates a default workspace directory through the runner.

#### `GET /api/projects/:id`

Fetch one owned project.

#### `PATCH /api/projects/:id`

Body requires at least one:

```ts
{
  name?: string;
  repoPath?: string | null;
  backend?: string;
  backendConfig?: Record<string, unknown>;
}
```

Changing backend is blocked once the project has sessions.

#### `DELETE /api/projects/:id`

Deletes a project after closing backend threads when possible. Blocked while any session has an active turn.

### Sessions

#### `GET /api/projects/:projectId/sessions`

List sessions under one owned project.

#### `POST /api/projects/:projectId/sessions`

Body:

```ts
{
  title: string;                      // 1..200
  backend?: string;
  repoPath?: string;
  backendConfig?: Record<string, unknown>;
  autoApprove?: boolean;
  autoApproveTimeoutSeconds?: number; // int 0..3600
}
```

Creates `Session.meta.runtime`.

#### `GET /api/sessions/:id/history`

Returns:

```ts
{
  session: {
    id: string;
    projectId: string;
    title: string;
    status: string;
    updatedAt: string;
    meta: Record<string, unknown> | null;
  };
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
  turns: TurnHistoryItem[];
  activeTurnId: string | null;
  activeTurnStatus: string | null;
}
```

#### `PATCH /api/sessions/:id`

Body requires at least one:

```ts
{
  title?: string;
  backendConfig?: Record<string, unknown>;
  autoApprove?: boolean;
  autoApproveTimeoutSeconds?: number;
}
```

#### `DELETE /api/sessions/:id`

Deletes a session after closing backend thread when possible. Blocked while an active turn exists.

#### `POST /api/sessions/:id/fork`

Body:

```ts
{ title?: string }
```

Forks backend thread and copies messages.

#### `POST /api/sessions/:id/compact`

Compacts backend thread context. Response:

```json
{ "accepted": true }
```

### Turns

#### `POST /api/sessions/:id/turns`

Body:

```ts
{ content: string } // 1..10000
```

Response:

```ts
{ turnId: string; messageId: string; status: string }
```

#### `GET /api/turns/:id`

Returns `TurnStatusResponse`.

#### `POST /api/turns/:id/cancel`

Cancels an active turn through the runner.

#### `POST /api/turns/:id/steer`

Body:

```ts
{ content: string } // 1..10000
```

Requires user's `turnSteerEnabled=true`; only `queued` and `running` turns are steerable.

#### `POST /api/turns/:id/approval`

Body:

```ts
{
  approvalId: string;
  decision:
    | 'approve'
    | 'reject'
    | 'accept'
    | 'acceptForSession'
    | 'decline'
    | 'cancel'
    | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
    | { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow' | 'deny'; host: string } } };
}
```

Legacy aliases:

- `approve` -> `accept`
- `reject` -> `decline`

#### `POST /api/turns/:id/approval/timer`

Body:

```ts
{ approvalId: string; action: 'pause' | 'resume' }
```

Pauses or resumes the current auto-approve timer.

#### `GET /api/turns/:id/stream?since=<int?>`

SSE stream. Supports `Last-Event-Id` as cursor.

### Runner-Backed Helpers

#### `GET /api/models?backend=<string?>`

Returns:

```ts
{ data: AvailableModel[] }
```

#### `GET /api/skills?cwd=<string?>&backend=<string?>`

Returns:

```ts
{ data: AvailableSkill[] }
```

#### `GET /api/fs/suggestions?prefix=<string>&limit=<1..50?>`

#### `GET /api/fs/tree?path=<string>&limit=<1..500?>&includeHidden=<boolean?>`

#### `GET /api/fs/file?path=<string>&maxBytes=<1024..1048576?>`

#### `GET /api/fs/file-content?path=<string>`

Returns binary body with:

- `Content-Type`
- `Cache-Control: no-store`
- `X-AgentWaypoint-File-Path`

#### `POST /api/fs/upload`

Multipart form upload. Max file size is configured by Fastify multipart registration as 20 MiB.

### Settings / Admin

#### `GET /api/settings`

Returns:

```ts
{ turnSteerEnabled: boolean; defaultWorkspaceRoot: string | null }
```

#### `POST /api/settings`

Body requires at least one:

```ts
{ turnSteerEnabled?: boolean; defaultWorkspaceRoot?: string | null }
```

#### `GET /api/settings/codex/rate-limits`

Returns Codex rate limits through the runner:

```ts
{
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
}
```

#### `GET /api/settings/users`

Admin only. Lists users.

#### `POST /api/settings/users`

Admin only. Body:

```ts
{
  email: string;
  displayName?: string | null;
  password: string;
  role?: 'admin' | 'user';
  isActive?: boolean;
  defaultWorkspaceRoot?: string | null;
}
```

#### `PATCH /api/settings/users/:id`

Admin only. Body requires at least one:

```ts
{
  displayName?: string | null;
  password?: string;
  role?: 'admin' | 'user';
  isActive?: boolean;
  defaultWorkspaceRoot?: string | null;
}
```

## 3. Channels API

### Integrations

- `POST /api/channels/integrations`
- `GET /api/channels/integrations`
- `GET /api/channels/integrations/:botIntegrationId`
- `PATCH /api/channels/integrations/:botIntegrationId`
- `POST /api/channels/integrations/:botIntegrationId/activate`
- `POST /api/channels/integrations/:botIntegrationId/pause`
- `DELETE /api/channels/integrations/:botIntegrationId`

Discord create payload:

```ts
{
  provider: 'discord';
  name: string;
  credentialsEncrypted: { botToken: string };
  pluginConfig: {
    trigger: {
      requireMention: boolean;
      allowedUsers: string[];
      allowedGuilds: string[];
      allowedChannels?: string[];
      allowDM?: boolean;
    };
    message: {
      sendStyle?: 'reply' | 'new_message';
      allowEveryoneMention?: boolean;
      ignoreBotMessages?: boolean;
      maxInboundLength?: number;
    };
  };
}
```

Generic non-Discord providers are accepted by schema with generic JSON config, but no non-web/non-Discord runtime plugin is implemented.

### Messages

- `POST /api/channels/messages/send`
- `POST /api/channels/messages/send-approval`
- `GET /api/channels/messages?projectId=&sessionId=&status=&kind=&limit=`
- `GET /api/channels/messages/:messageId`

## 4. Web Plugin App API

The main Web UI uses these routes:

- `GET /api/channels/plugins/web/app/models`
- `GET /api/channels/plugins/web/app/skills`
- `GET /api/channels/plugins/web/app/fs/suggestions`
- `GET /api/channels/plugins/web/app/fs/tree`
- `GET /api/channels/plugins/web/app/fs/file`
- `GET /api/channels/plugins/web/app/fs/file-content`
- `POST /api/channels/plugins/web/app/fs/upload`
- `GET /api/channels/plugins/web/app/projects`
- `POST /api/channels/plugins/web/app/projects`
- `GET /api/channels/plugins/web/app/projects/:id`
- `PATCH /api/channels/plugins/web/app/projects/:id`
- `DELETE /api/channels/plugins/web/app/projects/:id`
- `GET /api/channels/plugins/web/app/projects/:projectId/sessions`
- `POST /api/channels/plugins/web/app/projects/:projectId/sessions`
- `GET /api/channels/plugins/web/app/sessions/:id/history`
- `PATCH /api/channels/plugins/web/app/sessions/:id`
- `DELETE /api/channels/plugins/web/app/sessions/:id`
- `POST /api/channels/plugins/web/app/sessions/:id/fork`
- `POST /api/channels/plugins/web/app/sessions/:id/compact`
- `POST /api/channels/plugins/web/app/sessions/:id/turns`
- `GET /api/channels/plugins/web/app/turns/:id`
- `POST /api/channels/plugins/web/app/turns/:id/cancel`
- `POST /api/channels/plugins/web/app/turns/:id/steer`
- `POST /api/channels/plugins/web/app/turns/:id/approval`
- `POST /api/channels/plugins/web/app/turns/:id/approval/timer`
- `GET /api/channels/plugins/web/app/turns/:id/events`
- `GET /api/channels/plugins/web/app/turns/:id/stream`

Responses generally mirror core service responses. Delete routes return `{ deleted: true }` in the web plugin app surface.

## 5. Internal Runner Event Push

### `POST /internal/runner/turns/:turnId/events`

Optional bearer check via `RUNNER_AUTH_TOKEN`.

Accepted event types:

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

Note: `thread.token_usage.updated` is supported by pull-mode `RunnerStreamEvent` ingestion but is not accepted by this push controller schema.

## 6. External HTTP Runner Compatibility

Used only when `RUNNER_MODE=http`.

Base URL defaults to `http://127.0.0.1:4700`.

API calls:

- `GET /runner/health`
- `GET /runner/models?backend=`
- `GET /runner/skills?cwd=&backend=`
- `GET /runner/codex/rate-limits`
- `GET /runner/fs/suggestions`
- `GET /runner/fs/tree`
- `GET /runner/fs/file`
- `GET /runner/fs/file-content`
- `POST /runner/fs/ensure-directory`
- `POST /runner/fs/upload`
- `POST /runner/turns/start`
- `GET /runner/turns/:turnId/stream?since=`
- `POST /runner/turns/steer`
- `POST /runner/turns/cancel`
- `POST /runner/turns/approval`
- `POST /runner/threads/fork`
- `POST /runner/threads/close`
- `POST /runner/threads/compact`

When `RUNNER_AUTH_TOKEN` is set, API sends `Authorization: Bearer <token>`.

## 7. Shared Data Shapes

### AvailableModel

```ts
type AvailableModel = {
  id: string;
  backend: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedEfforts: Array<{ value: string; description: string }>;
  defaultEffort: string | null;
};
```

### TurnStatusResponse

```ts
type TurnStatusResponse = {
  id: string;
  sessionId: string;
  backend: string | null;
  triggerIdentifier: string;
  triggerProvider: string | null;
  triggerIntegrationId: string | null;
  triggerMessageId: string | null;
  status: string;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  requestedBackendConfig: Record<string, unknown> | null;
  effectiveBackendConfig: Record<string, unknown> | null;
  effectiveRuntimeConfig: Record<string, unknown> | null;
  contextRemainingRatio: number | null;
  contextRemainingTokens: number | null;
  contextWindowTokens: number | null;
  contextUpdatedAt: string | null;
  pendingApproval: PendingApproval | null;
};
```

### PendingApproval

```ts
type PendingApproval = {
  id: string; // requestId
  kind: string;
  status: string;
  decision: string | null;
  createdAt: string;
  resolvedAt: string | null;
  payload: Record<string, unknown> & {
    autoApproveAt?: string | null;
    pausedAt?: string | null;
    pausedRemainingMs?: number | null;
  };
};
```

### RunnerStreamEvent / SSE Envelope

```ts
type RunnerStreamEvent = {
  turnId: string;
  seq: number;
  type:
    | 'turn.started'
    | 'assistant.delta'
    | 'turn.approval.requested'
    | 'turn.approval.resolved'
    | 'turn.approval.auto_review'
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
  createdAt: string;
};
```

API-internal persisted event types additionally include:

- `turn.approval.timer_paused`
- `turn.approval.timer_resumed`

Web SSE sends:

```text
id: <seq>
event: <type>
data: {"turnId":"...","seq":1,"type":"...","payload":{},"createdAt":"..."}
```
