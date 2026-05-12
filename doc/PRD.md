# AgentWaypoint Product Requirements Document

Last aligned with implementation: 2026-05-11

## 1. Product Summary

AgentWaypoint is a browser UI for backend-driven coding agents. It lets users run Codex or Claude coding sessions from a web app, inspect streaming work, manage workspaces, and connect selected channel providers such as Discord.

## 2. Current Product Status

Status: working local-first implementation.

Implemented runtime:

- Host API + Host Web.
- SQLite persistence.
- Embedded runner for Codex, Claude, and mock backends.
- In-process channel gateway with web and Discord plugins.

## 3. Goals

- Provide a browser-first chat and coding workflow.
- Support streaming responses and rich execution events.
- Manage projects, sessions, workspace paths, and session history.
- Preserve turn state, messages, events, approvals, and backend runtime metadata.
- Support human approval flows for tool/file/permission requests.
- Support local multi-user operation with admin-created accounts.
- Provide channel integration foundations, currently validated with Discord.

## 4. Non-Goals for Current Version

- Full IDE replacement.
- Real-time collaborative editing.
- Enterprise SSO/RBAC/billing.
- Public self-service signup.
- Mobile-native application.
- Production-grade queue/metrics/audit/compliance system.

## 5. Target Users

- Individual developers using Codex or Claude for coding work.
- Small teams wanting a shared browser UI around local agent workflows.
- Technical operators who want to inspect turns, approvals, events, diffs, and tool output.

## 6. Core User Stories

1. As a user, I can sign in with email/password.
2. As an admin, I can create and manage users.
3. As a user, I can create a project bound to a workspace path.
4. As a user, I can create sessions under a project.
5. As a user, I can choose Codex or Claude backend defaults.
6. As a user, I can send prompts and receive streaming responses.
7. As a user, I can inspect events, diffs, reasoning, tool output, and file previews.
8. As a user, I can approve, reject, or auto-approve tool requests.
9. As a user, I can cancel or steer active turns.
10. As a user, I can fork or compact a session.
11. As a user, I can configure a Discord bot integration and interact from Discord.

## 7. Functional Requirements

### Authentication

- Password login.
- Server-side session cookie.
- Admin-created users.
- User activation/deactivation.
- Password change.

### Project and Session Management

- Create/list/read/update/delete projects.
- Create/list/read/update/delete sessions.
- Store backend, backend config, workspace path, and session runtime metadata.
- Prevent deletion when active turns exist.

### Agent Interaction

- Start turn.
- Stream turn events.
- Cancel turn.
- Steer queued/running turns when user setting enables steering.
- Persist messages/events/turn metadata.
- Fork and compact backend thread context.

### Approvals

- Persist approval requests.
- Show one pending approval at a time.
- Support rich decision variants.
- Support auto-approve timeout and pause/resume.

### Workspace Files

- Suggest workspace directories.
- Browse tree.
- Read text files.
- Stream binary file content.
- Upload files.

### Channels

- Manage bot integrations.
- Queue outbound channel messages.
- Dispatch turn messages/events to web and Discord plugins.
- Support Discord commands and inbound trigger rules.

## 8. Non-Functional Requirements

Current practical targets:

- Local-first operation without Docker, Redis, or Postgres.
- Isolated data homes for dev/test.
- SSE reconnect by event sequence cursor.
- Typecheck clean for API and Web.
- API e2e suite runnable without external infrastructure.

Production hardening targets not fully implemented:

- HTTPS-aware secure cookies.
- CSRF and login rate limits.
- Credential encryption.
- Audit logging.
- Metrics and alerting.
- Queue retry/dead-letter operations.

## 9. Success Metrics

Suggested metrics once telemetry exists:

- First successful turn completion rate.
- Failed turn ratio.
- Approval resolution latency.
- Runner stream failure rate.
- Channel delivery success/failure rate.
- Time from prompt submit to first streamed event.

## 10. Risks

- Upstream Codex app-server or Claude Agent SDK changes.
- Security exposure from local workspace operations.
- Discord token handling before credential encryption is added.
- Large single-file Web UI slowing frontend iteration.
- In-memory channel buffers/timers across process restarts.

## 11. Future Scope

- WebAuthn/passkeys.
- Service accounts and API keys.
- Dedicated audit log.
- Componentized frontend.
- Better observability.
- Durable channel retry/dead-letter flows.
- More provider plugins.
- Optional external gateway mode if operationally justified.
