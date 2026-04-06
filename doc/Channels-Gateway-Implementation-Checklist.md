# Channels Gateway Implementation Checklist

## Current Alignment (2026-04-03)
This section reflects the actual implemented state and should be treated as source-of-truth over legacy checkbox drift below.

### Implemented
- In-process gateway runtime in API (`ChannelsGatewayService`), plugin lifecycle boot/shutdown, dispatch loop.
- Core channels schema/tables in use: `BotIntegration`, `BotMessage`, `ChannelFile`, `BotAuthSession`.
- Web plugin app surface is live under `/api/channels/plugins/web/app/*`:
  - projects/sessions/turns
  - models/skills
  - fs suggestions/tree/file/file-content/upload
- Frontend chat/session/project/models/skills/fs calls are routed to web plugin app endpoints.
- PluginContext pattern is implemented and used by web plugin; controller -> plugin -> gateway context -> core services.
- Binding-driven outbound dispatch implemented:
  - session bindings resolved from `BotIntegration.pluginConfig`
  - plugin `bindAllSessions` policy supported (web plugin set to `true`)
  - `sendMessage` receives binding + trigger context.
- Trigger metadata is explicit and persisted:
  - inbound supports `triggerProvider` + `triggerIntegrationId`
  - turn stores `triggerIdentifier`, `triggerProvider`, `triggerIntegrationId`, `triggerMessageId`
  - migration created: `20260402160403`.
- Event delivery path implemented through dispatcher:
  - runner events persisted to `Event`
  - events also enqueued as `BotMessage(kind=event)`
  - web plugin consumes dispatched events.
- Web SSE durability behavior:
  - reads durable DB events (replay/reconnect safe)
  - merges dispatched plugin buffer (per-session latest-turn).
- Removed web-plugin outbox endpoint and storage (no production message leak via outbox).
- `GET /api/channels/messages` now owner-scoped even without filters.

### Implemented But Simplified
- Session binding source is currently `BotIntegration.pluginConfig` conventions, not a dedicated binding table.
- Web plugin dispatched buffer is in-memory (per-session latest-turn only).

### Not Implemented Yet
- Externalized runtime mode (`/api/channels/gateway/*`, M2M token, scope guard) as an active path.
- Raw/normalized/action triple queue (`channels_raw_event_queue`, `channels_normalized_event_queue`, `channels_action_queue`).
- Dedicated mapping/binding tables and full CRUD UI for bindings.
- Real provider adapter rollout (Discord/Telegram/WeChat/Feishu production adapter).

## Scope
- Build a platform-agnostic channels core first.
- Keep provider list open (do not hardcode final platforms now).
- Validate early with one pilot provider plus one mock provider.
- Defer auth implementation details until onboarding a provider that requires auth.
- Default deployment: gateway/plugin runtime runs inside API container/process (not as a separate gateway container).

## Milestones
- M1: Core contracts + schema + internal runtime service contracts are ready.
- M2: Queue pipelines + gateway runtime are stable.
- M3: Mock provider end-to-end passes.
- M4: One real pilot provider is online for `turn_message` routing.
- M5: Approval/file flows and web management MVP are usable, with non-approval interactions handled by gateway/plugin.

## Slice Mapping (Design Doc Alignment)
- Slice 1 -> Phase 1 + Phase 2
- Slice 2 -> Phase 3a + 3b + 3c
- Slice 3 -> Phase 4
- Slice 4 -> Phase 5
- Slice 5 -> Phase 6
- Slice 6 -> Phase 7
- Slice 7 -> Phase 8

## Phase 0 - Contract Freeze
Dependency: none
### 0.1 Provider abstraction
- [ ] Define provider plugin interface (`boot`, `shutdown`, `parseInboundEvent`, `sendMessage`, auth methods).
- [ ] Confirm gateway stays capability-agnostic; plugin owns provider-specific interaction/file behavior.
- [ ] Allow extensible provider ids (not limited to a fixed enum).

### 0.2 API contracts
- [ ] Freeze user-facing endpoints under `/api/channels/*`.
- [ ] Freeze internal runtime service interfaces for inbound/outbound/heartbeat/files.
- [ ] Externalized mode only: freeze compatibility endpoints under `/api/channels/gateway/*`.
- [ ] Freeze event schema (`raw`, `normalized`, `action`) and event type taxonomy.
- [ ] Freeze outbound queue kinds (`turn_message`, `approval_request`, `user_input_request`, `event`).
- [ ] Document auth callback + commit contract as deferred (activate when first auth-required provider is selected).

### 0.3 Acceptance
- [ ] One review meeting completed with backend and web owners (and runtime owner role if assigned).
- [ ] Request/response examples are documented for all user endpoints under `/api/channels/*`.
- [ ] Internal service interface examples are documented for runtime integration points.
- [ ] Event schema examples exist for `message.created`, `approval.decision`, `file.uploaded`, and `interaction.observed`.

## Phase 1 - Data Model and Migrations
Dependency: Phase 0 completed
### 1.1 Core tables
- [ ] Add `BotIntegration`.
- [ ] Add `BotMessage`.
- [ ] Add `ChannelFile`.
- [ ] Add `BotAuthSession`.
- [ ] Ensure `BotMessage` includes `projectId`, `sessionId`, and delivery state/retry fields.
- [ ] Add channel-runtime-owned mapping store tables for provider routing state.

### 1.2 Queue tables
- [ ] Add `channels_raw_event_queue`.
- [ ] Add `channels_normalized_event_queue`.
- [ ] Add `channels_action_queue`.
- [ ] Add claim lease fields (claimedBy, claimedAt, leaseExpireAt).
- [ ] Add retry/dead-letter fields (attemptCount, nextAttemptAt, deadLetteredAt, lastError).

### 1.3 Indexes and constraints
- [ ] Add idempotency index on provider event id.
- [ ] Add queue polling indexes (`status`, `nextAttemptAt`, `createdAt`).
- [ ] Add uniqueness constraints for message/session ownership consistency (`projectId`, `sessionId`).
- [ ] Add mapping-store uniqueness constraints in gateway domain (`provider scope -> session`).

### 1.4 Acceptance
- [ ] `corepack pnpm --filter @agentwaypoint/api prisma migrate dev` succeeds on clean local DB.
- [ ] `corepack pnpm --filter @agentwaypoint/api prisma migrate deploy` succeeds in containerized API env.
- [ ] `corepack pnpm --filter @agentwaypoint/api prisma migrate status` shows no pending drift after apply.
- [ ] Drift detection procedure documented using `prisma migrate diff` and `prisma migrate resolve`.
- [ ] Rollback strategy documented as forward-fix migration (no destructive rollback in production).
- [ ] Local reset procedure documented: `corepack pnpm --filter @agentwaypoint/api prisma migrate reset`.

## Phase 2 - API Skeleton (User Side)
Dependency: Phase 1 completed
### 2.1 Integration management
- [ ] Implement create/list/get/update.
- [ ] Implement activate/pause/disable/delete.

### 2.2 Auth sessions (deferred)
- [ ] Defer implementation by default.
- [ ] Activate only when onboarding a provider that requires auth.
- [ ] When activated, implement:
  - `auth/preflight` (no integration id required)
  - `auth-sessions/:id` polling/submit/cancel
  - create-with-auth-session commit flow
  - existing-integration re-auth (`auth/start` + `auth/commit`)
  - timeout policy (5-minute TTL, 5-second polling baseline, expired transition)

### 2.3 Inbound/Outbound API contracts
- [ ] Implement outbound send APIs targeting `projectId/sessionId` (no provider topology fields).
- [ ] Implement inbound ingest API expecting plugin-resolved `projectId/sessionId`.
- [ ] Remove/avoid API topology and binding CRUD endpoints.
- [ ] Enforce API ownership checks for resolved inbound/outbound context (`projectId`, `sessionId`).

### 2.4 Message APIs
- [ ] Implement send APIs for `turn_message` and `approval_request` (file-send intent is marker-based in message payload).
- [ ] Implement message query and retry APIs.
- [ ] Implement file reference query APIs.
- [ ] Define and implement turn-creation failure handling classification (retryable 5xx/timeout/429 vs non-retryable 4xx).
- [ ] Define and validate marker grammar: `<send_file>(relative-or-absolute-path)</send_file>`.

### 2.5 Acceptance
- [ ] Contract tests exist for endpoint groups (integrations/auth/messages/gateway-ingest).
- [ ] Invalid payloads return 400 with schema errors for at least 10 negative cases.
- [ ] Unauthorized/forbidden access tests cover cross-user access to `projectId`, `sessionId`, and `messageId`.
- [ ] API e2e suite passes with channels module enabled.

## Phase 3a - Runtime Boundary and Callback Security
Dependency: Phase 2 completed
### 3a.1 M2M auth
- [ ] Externalized mode only: implement gateway token issuing (`client_credentials`).
- [ ] Externalized mode only: implement scope checks for gateway endpoints.
- [ ] Externalized mode only: implement token refresh strategy in gateway client.
- [ ] Implement webhook shared-secret validation for MVP (`X-Gateway-Secret` + timestamp window).
- [ ] Implement OAuth state signing/verification (HMAC-SHA256 with nonce + expiry).
- [ ] Ensure default in-process mode has no public/internal gateway HTTP path dependency.

### 3a.2 Acceptance
- [ ] Externalized mode: token endpoint `/api/channels/gateway/token` issues short-lived JWT with configured scopes.
- [ ] Externalized mode: gateway rejects expired tokens and missing-scope tokens with deterministic error codes.
- [ ] Externalized mode: unit tests for gateway scope guard cover deny cases for all required scopes.

## Phase 3b - Gateway Service Endpoints
Dependency: Phase 3a completed
### 3b.1 Gateway endpoints
- [ ] Implement internal service calls for active integration pull.
- [ ] Implement internal service calls for outbound pull/claim/result.
- [ ] Implement internal service call for inbound ingest.
- [ ] Implement internal heartbeat/liveness update path.
- [ ] Implement internal/admin dead-letter replay operation.
- [ ] Implement lifecycle event table polling path (MVP default) for integration reload.
- [ ] Implement configurable poll interval (default 30s) and full reconcile interval (default 10m).
- [ ] Externalized mode only: provide compatibility `/api/channels/gateway/*` endpoints.

### 3b.2 Acceptance
- [ ] Queue claim endpoint enforces lease ownership and lease timeout.
- [ ] Inbound ingest endpoint enforces idempotency by provider event id.
- [ ] Heartbeat endpoint updates gateway liveness record visible in API status query.
- [ ] Duplicate inbound provider events return success without duplicate side effects.

## Phase 3c - Gateway File Endpoints
Dependency: Phase 3b completed
### 3c.1 File endpoints for gateway
- [ ] Implement internal file-ingest service path.
- [ ] Ensure outbound file delivery status is reported via message-level result endpoint (not file-level result endpoint).
- [ ] Implement gateway marker parser for `<send_file>(...)` and temp-file staging workflow.
- [ ] Implement temp-file cleanup policy after successful/failed plugin send.

### 3c.2 Acceptance
- [ ] Runtime<->API file path uses metadata/reference only; no large binary body contract.
- [ ] File policy checks (size/mime) are validated in automated tests.
- [ ] File ingest endpoint updates `ChannelFile` metadata with workspace-relative path correctly.
- [ ] Channel and workspace files are verified to use same project workspace filesystem (no physical storage isolation).

## Phase 4 - In-API Runtime and Queue Workers
Dependency: Phase 3a + 3b + 3c completed
### 4.1 Runtime bootstrap
- [ ] In-API channel runtime startup full pull of active integrations.
- [ ] Build adapter instance lifecycle (create/update/stop).
- [ ] Add incremental sync (`updatedAfter`) + full reconcile timer.
- [ ] Add leader election for full reconcile jobs (advisory lock or equivalent).
- [ ] Document multi-instance strategy (single instance now, hash sharding option later).
- [ ] Configure and verify runtime DB/client connection pool bounds (10-20 baseline).

### 4.2 Event pipelines
- [ ] Ingest raw events into `raw_event_queue`.
- [ ] Normalize into `normalized_event_queue`.
- [ ] Generate executable actions into `action_queue`.
- [ ] Implement claim/ack/fail/retry/dead-letter handling.
- [ ] Wire integration lifecycle events (`integration.created/updated/activated/paused/disabled/deleted`) into runtime reconcile path.
- [ ] Add ordering and causality checks for `(projectId, sessionId)` streams.
- [ ] Implement plugin-owned unresolved routing policy (create/guidance/drop) before ingest.
- [ ] Implement recovery when resolved target session/project is missing or deleted.
- [ ] Implement approval timeout handling (default 24h -> implicit deny + notify).

### 4.3 Outbound dispatch
- [ ] Implement message dispatch worker (`pull -> claim -> send -> result`) via internal service calls.
- [ ] Implement retry with backoff.
- [ ] Implement per-integration circuit breaker with open/half-open/close transitions.

### 4.4 Acceptance
- [ ] At-least-once delivery verified with replay test.
- [ ] Dead-letter transition verified after max retry threshold.
- [ ] Queue lag, retry count, and dead-letter count metrics exported.
- [ ] Worker restart recovery test passes without message loss.
- [ ] Circuit breaker isolation verified (one integration open does not block others).
- [ ] Graceful shutdown test: stop claim, wait 30s, release leases, adapter shutdown.

## Phase 5 - Mock Provider E2E (Early Validation)
Dependency: Phase 4 completed
### 5.1 Mock adapter
- [ ] Implement mock provider adapter and callback simulator.
- [ ] Implement mock routing discovery.
- [ ] Implement deterministic mock provider routing fixture.
- [ ] Implement configurable failure injection (send failure, callback timeout, file transfer failure).
- [ ] Implement simulated callback endpoints for message, approval decision, and file upload events.
- [ ] Add token-refresh concurrency test (single refresh lock per integration).

### 5.1.1 Testing strategy
- [ ] Unit tests for adapter behaviors and queue worker logic.
- [ ] Integration tests for mock-provider end-to-end flows.
- [ ] Load test target: 1000 messages/s queue throughput baseline.
- [ ] Fault-injection tests: API latency spikes, DB disconnect, provider 5xx.

### 5.2 E2E scenarios
- [ ] Inbound `message.created` -> session turn.
- [ ] First inbound event with unresolved routing follows plugin policy and produces deterministic outcome.
- [ ] Outbound assistant message -> provider sink.
- [ ] Outbound marker `<send_file>(...)</send_file>` triggers provider file send via plugin and temp cleanup.
- [ ] Approval decision callback -> turn approval resolution.
- [ ] Inbound and outbound file flows.
- [ ] Non-approval interaction callback handled in gateway/plugin and recorded as informational event in API.
- [ ] Duplicate event replay does not create duplicate turn/message side effects.
- [ ] Network partition simulation and recovery reconcile pass.
- [ ] `create` command in DM auto-creates session and mapping in gateway domain.
- [ ] Unbound DM behavior follows policy (`autoCreateSessionOnUnbound` on/off).

### 5.3 Acceptance
- [ ] Deterministic local E2E script passes 10 consecutive runs.
- [ ] CI job includes mock provider integration tests and is required for merge.

## Phase 6 - Pilot Real Provider
Dependency: Phase 5 completed
### 6.1 Pilot integration
- [ ] Select one pilot provider (recommended: Discord).
- [ ] Implement auth/bootstrap and webhook/callback handling.
- [ ] Enable `turn_message` + resolved routing first.
- [ ] Implement provider token refresh flow and error state transition on refresh failure.
- [ ] Implement provider HTTP 429 handling with backoff and retry.

### 6.2 Capability ramp-up
- [ ] Add approval round-trip support.
- [ ] Add inbound/outbound file support.

### 6.3 Acceptance
- [ ] Pilot provider can run for 24h in staging without manual restart.
- [ ] Send failures surface expected error codes and can be retried from queue.

## Phase 7 - Web Management MVP
Dependency: Phase 2 + Phase 6 completed
### 7.1 Core pages
- [ ] Add Channel Management navigation and page shell.
- [ ] Build integration list/detail pages.
- [ ] Build create/edit integration form.
- [ ] Ensure project/session delete operations work for any creation source (web/gateway/provider command).

### 7.2 Auth and routing UX
- [ ] Build multi-step auth wizard (QR/polling/manual code placeholders).
- [ ] Build integration configuration UI for plugin-specific routing controls.
- [ ] Build quick session-target mapping controls exposed by gateway domain.

### 7.3 Operations UX
- [ ] Build message delivery log view.
- [ ] Add manual retry action.
- [ ] Display file/approval statuses and informational interaction records.
- [ ] Web chat renders `<send_file>(...)</send_file>` as clickable preview entries.

### 7.4 Acceptance
- [ ] A new bot integration can be created, activated, and route messages to target sessions from Web with no DB/manual intervention.
- [ ] Auth wizard polling states render correctly for pending/success/failed.
- [ ] Deleting a runtime/provider-created session from Web succeeds and subsequent inbound message can re-create session by policy.

## Phase 8 - Security, Ops, and Release
Dependency: Phase 4 + Phase 6 + Phase 7 completed
### 8.1 Security hardening
- [ ] Encrypt provider credentials at rest.
- [ ] Mask secret fields in all API responses.
- [ ] Enforce file policy (size/mime) for inbound and outbound.
- [ ] Add provider event idempotency and replay protection.
- [ ] Implement credential rotation runbook (90-day cadence + re-encryption job).
- [ ] Verify `/api/channels/gateway/*` is disabled or internal-only in default in-process deployment.

### 8.2 Observability
- [ ] Add metrics: queue depth, dequeue latency, send success/failure rate.
- [ ] Add alerts for sustained queue backlog and auth failures.
- [ ] Add audit logs for integration changes and routing-mapping changes.
- [ ] Expose `/metrics` endpoint and verify scrape in staging.
- [ ] Add alerts for dead-letter spike and missed gateway heartbeat.

### 8.3 Release
- [ ] Run staged rollout (internal alpha -> limited beta -> wider rollout).
- [ ] Publish operator runbook (recovery, retry, reconciliation, token rotation).

### 8.4 Acceptance
- [ ] Go-live checklist signed by backend/web/ops owners.
- [ ] On-call runbook includes token rotation, queue drain, dead-letter replay, and reconciliation operations.
- [ ] Post-launch monitoring dashboard and alert routing verified in staging.
- [ ] Health/readiness checks validated against dependency outages (API unavailable, queue unavailable).

## Out of Scope for Initial Delivery
- Provider parity across all platforms.
- Complex routing rules (one endpoint to multiple sessions by custom rules).
- Full production malware scanning pipeline (placeholder hooks only).
