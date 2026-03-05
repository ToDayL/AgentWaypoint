# CodexPanel Initial Architecture Design

## 1. Overview
This architecture enables a browser-based Codex experience by placing a Web application and API backend in front of a host-side Codex runner daemon that manages Codex app-server processes.

Primary design goals:
- Fast streaming UX for chat/vibe coding.
- Clear separation between UI, orchestration backend, and Codex integration adapter.
- Safe execution boundary for workspace actions.

## 2. High-Level Architecture

```text
+--------------------+        HTTPS        +---------------------------+
|   Web Frontend     | <-----------------> |   Web API / BFF Backend   |
| (Next.js)          |                     | (Auth, Sessions, Stream)  |
+--------------------+                     +-------------+-------------+
                                                          |
                                                          | Internal API (HTTP/gRPC)
                                                          v
                                            +---------------------------+
                                            | Host Codex Runner Daemon  |
                                            | (process + policy manager)|
                                            +-------------+-------------+
                                                          |
                                                          | stdio JSONL
                                                          v
                                            +---------------------------+
                                            | Codex App Server Process  |
                                            | (per session/project)     |
                                            +---------------------------+

+--------------------+      +----------------------+      +---------------------+
| Relational DB      |      | Cache/Message Bus    |      | Observability Stack |
| users/projects/... |      | Redis (optional)     |      | logs/metrics/traces |
+--------------------+      +----------------------+      +---------------------+
```

## 3. Component Responsibilities

### 3.1 Web Frontend
- Render chat UI, session list, and project context.
- Consume streaming channel (SSE preferred for MVP).
- Show token-by-token assistant output and tool event timeline.
- Provide controls: send prompt, cancel, retry, resume session.

### 3.2 Web API / BFF Backend
- Authenticate requests and authorize project/session access.
- Expose REST endpoints for CRUD and session history.
- Expose streaming endpoint for active turn events.
- Persist messages and events.
- Handle cancellation and turn lifecycle state machine.

### 3.3 Codex Adapter Module (in API)
- Encapsulate internal runner API specifics.
- Convert internal normalized request format -> runner request format.
- Normalize runner stream -> frontend event schema.
- Implement retries/timeouts and compatibility version handling.

### 3.4 Host Codex Runner Daemon
- Spawn and manage `codex app-server` processes on host.
- Enforce workspace path allowlist and execution policy.
- Proxy JSON-RPC requests/responses over stdio.
- Emit normalized stream events back to API.
- Maintain audit trail (`user_id`, `project_id`, `session_id`, `turn_id`).

### 3.5 Persistence Layer
- Primary DB (PostgreSQL recommended) for users, projects, sessions, messages, events.
- Optional Redis for:
  - transient turn state
  - stream fanout buffers
  - rate limiting

### 3.6 Observability
- Structured logs with correlation IDs (`request_id`, `session_id`, `turn_id`).
- Metrics: active turns, stream disconnects, latency, error rates.
- Tracing across BFF -> Runner -> Codex interface.

## 4. Data Model (Initial)

### 4.1 Core Entities
- `users(id, email, password_hash|oauth_id, created_at)`
- `projects(id, owner_user_id, name, repo_path, created_at)`
- `sessions(id, project_id, title, status, created_at, updated_at)`
- `turns(id, session_id, user_message_id, assistant_message_id, status, started_at, ended_at)`
- `messages(id, session_id, role, content, created_at, token_count)`
- `events(id, turn_id, seq, type, payload_json, created_at)`

### 4.2 Event Types (Normalized)
- `turn.started`
- `assistant.delta`
- `tool.started`
- `tool.output`
- `tool.completed`
- `turn.completed`
- `turn.failed`
- `turn.cancelled`

## 5. API Design (Initial)

### 5.1 REST Endpoints
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/sessions?project_id=...`
- `POST /api/sessions`
- `GET /api/sessions/:id/messages`
- `POST /api/sessions/:id/turns`
- `POST /api/turns/:id/cancel`
- `GET /api/health`

### 5.2 Streaming Endpoint
- `GET /api/turns/:id/stream` (SSE)
- SSE event format:
  - `event: assistant.delta`
  - `data: {"turn_id":"...","text":"...","seq":12}`

## 6. Request/Stream Flow
1. User sends prompt from UI.
2. BFF validates auth/session and creates `turn` record (`status=running`).
3. BFF calls host runner with normalized payload.
4. Runner forwards payload to Codex app server process.
5. Incoming Codex chunks/events are normalized and:
   - forwarded to client stream
   - appended to `events`
6. On completion, assistant message is finalized and persisted.
7. Turn status transitions to `completed` (or `failed`/`cancelled`).

## 7. State Model (Turn Lifecycle)
- `queued` -> `running` -> `completed`
- `queued` -> `running` -> `failed`
- `queued` -> `running` -> `cancelled`

Rules:
- Only one active `running` turn per session in MVP.
- Cancel operation is best effort and idempotent.

## 8. Security Design (Initial)
- Auth token validation on every API request.
- Authorization checks: user must own project/session.
- Strict input validation and max payload size.
- Server-side escaping/sanitization for rendered content.
- Secrets in environment/secret manager, never in repo.
- Audit logging for admin-sensitive operations.

## 9. Deployment Topology (MVP)
- Frontend and API run in Docker containers.
- Host-side `codex-runner` daemon runs outside containers.
- `codex-runner` manages `codex app-server` child processes on host.
- PostgreSQL managed instance (or local container for dev).
- Optional Redis managed instance (or local container for dev).
- Use `docker-compose` for local orchestration of `web/api/postgres/redis`; runner is a host process.

Recommended MVP approach:
- Keep runner as a dedicated host process boundary for workspace and privileged operations.
- Keep API adapter module isolated so runner protocol changes do not leak into business modules.

## 10. Technology Options
- Frontend: Next.js (React) + TypeScript.
- Backend: Node.js (NestJS/Express/Fastify) or Go.
- DB: PostgreSQL.
- Streaming: SSE first, WebSocket later if bidirectional control is needed.
- Observability: OpenTelemetry + Prometheus/Grafana + centralized logs.

## 11. Reliability and Scaling Notes
- Use connection keepalive and heartbeat for SSE.
- Reconnect support with `Last-Event-ID` where feasible.
- Backpressure handling on event bursts.
- Queue heavy/long-running operations if direct request path becomes unstable.

## 12. Milestone Plan
1. Milestone 1: Auth, project/session CRUD, non-streaming single-turn chat.
2. Milestone 2: SSE streaming and cancel support.
3. Milestone 3: History/resume, observability baseline, hardening.
4. Milestone 4: UX refinement for vibe coding workflows.

## 13. Key Decisions to Confirm
- Should host runner bind localhost-only or secured internal network endpoint?
- Which operations require explicit user approval (for example Docker commands)?
- SSE vs WebSocket for MVP? (recommended: SSE)
- Local workspace model and permission boundary design.
- Persistence of full tool output vs summarized output.
