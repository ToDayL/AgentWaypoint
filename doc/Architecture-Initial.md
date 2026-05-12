# AgentWaypoint Architecture

Last aligned with implementation: 2026-05-11

This document describes the architecture that exists in the current repository. Older plans around Docker Compose, PostgreSQL, Redis, and a separate `codex-runner` process have been superseded by the lightweight host runtime.

## 1. Overview

AgentWaypoint is a browser UI for backend-driven coding agents. It runs as two host processes:

- `apps/api`: NestJS/Fastify API, Prisma/SQLite persistence, auth, project/session/turn orchestration, embedded runner, channel gateway, Discord plugin.
- `apps/web`: Next.js single-page web UI, proxied through `/api/[...path]` to the API.

The API embeds the runner implementation by default. The runner can execute Codex, Claude, or mock turns without Docker, Redis, Postgres, or a separate runner daemon.

## 2. Runtime Topology

```text
-------------------------+        HTTP/SSE         +-------------------------------+
| Next.js Web            | <---------------------> | NestJS/Fastify API            |
| apps/web               |                         | apps/api                      |
| /api/[...path] proxy   |                         |                               |
+-------------------------+                         | - Auth/session guard          |
                                                    | - Projects/sessions/turns     |
                                                    | - ChannelsGatewayService      |
                                                    | - EmbeddedRunnerService       |
                                                    +---------------+---------------+
                                                                    |
                                                                    | Prisma
                                                                    v
                                                    +-------------------------------+
                                                    | SQLite database               |
                                                    | AGENTWAYPOINT_HOME/*.db       |
                                                    +-------------------------------+
                                                                    |
                                                                    | child process / SDK
                                                                    v
                         +--------------------------+--------------------------+
                         | Codex CLI app-server     | Claude Agent SDK         |
                         | or mock backend          |                          |
                         +--------------------------+--------------------------+
```

Default state directory:

```text
~/.agentwaypoint/
  config.json
  agentwaypoint.db
  logs/
  workspaces/
```

Development should use an isolated home such as `./.agentwaypoint-dev` or `/tmp/agentwaypoint-dev`.

## 3. Component Responsibilities

### Web Frontend

- Renders the app shell, project/session navigation, chat timeline, file browser, settings, bot integration controls, and turn insights.
- Uses cookie session auth plus optional dev `x-user-email` forwarding.
- Calls the API through Next's generic `/api/[...path]` proxy.
- Main app workflow uses the web channel plugin surface: `/api/channels/plugins/web/app/*`.

### API

- Boots local config from `AGENTWAYPOINT_HOME/config.json` or prompts on first `./agent-waypoint start`.
- Runs `prisma db push --skip-generate` against SQLite during bootstrap/start.
- Stores users, sessions, projects, messages, turns, events, approvals, bot integrations, bot messages, and channel files.
- Owns auth, ownership checks, validation, SSE streaming, approval queues, and channel gateway dispatch.

### Embedded Runner

- Selected by `RUNNER_MODE=embedded` (default).
- Supports backend routing for `codex`, `claude`, and `mock`.
- Uses `RUNNER_SUPPORTED_BACKENDS` to restrict exposed backends when needed.
- Provides normalized runner operations through the `RunnerAdapter` interface:
  - start/steer/cancel turns
  - resolve approvals
  - fork/compact/close threads
  - list models and skills
  - read/write workspace files
  - read Codex rate limits

### HTTP Runner Adapter

`RUNNER_MODE=http` remains available for compatibility with an external runner-compatible service. In that mode the API calls `/runner/*` endpoints at `RUNNER_BASE_URL`, secured by optional `RUNNER_AUTH_TOKEN`.

### Channels Gateway

- Runs in-process as `ChannelsGatewayService`.
- Loads `WebPlugin` and `DiscordPlugin`.
- Uses `BotMessage` rows as the outbound queue.
- Dispatches turn events and turn messages to plugins.
- Supports Discord as a real provider plugin in the current code.

## 4. Data Model

The active Prisma schema uses SQLite and includes:

- `User`
- `AuthSession`
- `Project`
- `Session`
- `Message`
- `Turn`
- `TurnApproval`
- `Event`
- `BotIntegration`
- `BotMessage`
- `ChannelFile`
- `BotAuthSession`

Important implementation details:

- `Project.backend` defaults to `codex`.
- `Project.backendConfig` stores backend-specific defaults.
- `Session.backendThreadId` stores backend conversation identity.
- `Session.meta.runtime` stores resolved runtime config for that session.
- `Turn` snapshots requested/effective backend/runtime config.
- `TurnApproval` includes queued/pending approval state and auto-approve timer metadata.

## 5. API Surface

Primary route groups:

- `/api/auth/*`
- `/api/projects/*`
- `/api/projects/:projectId/sessions/*`
- `/api/sessions/*`
- `/api/turns/*`
- `/api/models`
- `/api/skills`
- `/api/fs/*`
- `/api/settings/*`
- `/api/channels/*`
- `/api/channels/plugins/web/app/*`
- `/internal/runner/turns/:turnId/events`

The detailed contract inventory is maintained in [Web-API-Runner-Contract-Inventory.md](./Web-API-Runner-Contract-Inventory.md).

## 6. Turn Lifecycle

Current statuses:

- `queued`
- `running`
- `waiting_approval`
- `completed`
- `failed`
- `cancelled`

Flow:

1. User submits a prompt through Web or a channel plugin.
2. API creates a user `Message` and a `Turn(status=queued)`.
3. API dispatches to the selected runner backend.
4. API consumes normalized runner events and persists them as `Event` rows.
5. API streams persisted events to Web over SSE and queues mirrored `BotMessage(kind=event)` rows for channels.
6. On completion/cancel/failure, API creates/finalizes assistant messages and terminal turn state.

Only one active turn is allowed per session.

## 7. Security Model

- Password login creates server-side `AuthSession` rows and an HTTP-only cookie.
- `AUTH_DEV_EMAIL_HEADER=1` enables dev-only `x-user-email` fallback.
- Business routes use `AuthGuard` and owner-scoped lookups.
- Admin user management routes under `/api/settings/users` require `role=admin`.
- Runner event push endpoint optionally checks `RUNNER_AUTH_TOKEN`.
- Provider credentials are stored in `BotIntegration.credentialsEncrypted`, but the current implementation stores JSON payloads directly rather than envelope-encrypting them.

## 8. Operations

Host launcher:

```bash
./agent-waypoint start
./agent-waypoint status
./agent-waypoint logs api
./agent-waypoint logs web
./agent-waypoint stop
```

Dev wrappers:

```bash
./scripts/dev-up.sh
./scripts/dev-status.sh
./scripts/dev-down.sh
```

Test:

```bash
./scripts/test-api-e2e.sh
corepack pnpm --filter @agentwaypoint/api typecheck
corepack pnpm --filter @agentwaypoint/web typecheck
```

## 9. Current Constraints

- SQLite is the only active database provider in schema.
- No Redis-backed queue exists; queue state is stored in SQLite tables and in-memory timers/buffers.
- No Docker Compose runtime exists in the repository.
- The web package currently has no test files.
- The API can use an external HTTP runner, but the default runtime is embedded.
