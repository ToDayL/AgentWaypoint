# Third-Party Bot / Channel Integration Design

Last aligned with implementation: 2026-05-11

## 1. Current Scope

The channel system is implemented as an in-process API subsystem. It supports:

- Web plugin for the primary browser UI.
- Discord plugin as a real provider integration.
- Generic integration records through `BotIntegration`.
- Generic outbound queue records through `BotMessage`.
- Event mirroring from turns to channel plugins.

The larger external gateway design remains future work.

## 2. Runtime Topology

```text
API process
  ChannelsGatewayService
    WebPlugin
    DiscordPlugin
  ChannelsService
  BotIntegration / BotMessage / ChannelFile / BotAuthSession tables
```

There is no separate gateway process/container and no active `/api/channels/gateway/*` HTTP controller.

## 3. Domain Model

### BotIntegration

Represents one provider integration owned by a user.

Active fields:

- `id`
- `ownerUserId`
- `provider`
- `name`
- `status`: `active`, `paused`, or `error`
- `credentialsEncrypted`: JSON payload
- `pluginConfig`: provider-specific JSON payload
- `lastSyncAt`
- `lastErrorAt`
- `lastErrorMessage`
- `createdAt`
- `updatedAt`

For Discord, `credentialsEncrypted` contains `botToken`.

### BotMessage

Outbound queue item.

Active fields include:

- `projectId`
- `sessionId`
- `kind`: `turn_message`, `approval_request`, `user_input_request`, or `event`
- `payloadRaw`
- `status`: `queued`, `sending`, `sent`, `delivered`, or `failed`
- claim/lease fields
- provider delivery fields
- error fields

### ChannelFile

File metadata table exists for channel files. The full provider attachment pipeline is not complete.

### BotAuthSession

Schema exists for multi-step bot auth flows. OAuth/QR/device-code flows are not implemented.

## 4. User-Facing API

All routes are guarded by `AuthGuard`.

### Integrations

- `POST /api/channels/integrations`
- `GET /api/channels/integrations`
- `GET /api/channels/integrations/:botIntegrationId`
- `PATCH /api/channels/integrations/:botIntegrationId`
- `POST /api/channels/integrations/:botIntegrationId/activate`
- `POST /api/channels/integrations/:botIntegrationId/pause`
- `DELETE /api/channels/integrations/:botIntegrationId`

Discord create payload requires:

```json
{
  "provider": "discord",
  "name": "Discord Bot",
  "credentialsEncrypted": {
    "botToken": "..."
  },
  "pluginConfig": {
    "trigger": {
      "requireMention": true,
      "allowedUsers": [],
      "allowedGuilds": [],
      "allowedChannels": [],
      "allowDM": false
    },
    "message": {
      "sendStyle": "reply",
      "allowEveryoneMention": false,
      "ignoreBotMessages": true,
      "maxInboundLength": 2000
    }
  }
}
```

Generic non-Discord providers are accepted by the API schema, but only Discord has a concrete runtime plugin besides web.

### Messages

- `POST /api/channels/messages/send`
- `POST /api/channels/messages/send-approval`
- `GET /api/channels/messages`
- `GET /api/channels/messages/:messageId`

These APIs enqueue/read `BotMessage` rows and enforce project/session ownership.

## 5. Plugin Interface

Current plugin shape is defined in `apps/api/src/modules/channels/plugins/plugin.types.ts`.

Important methods/properties:

- `provider`
- `bindingPolicy`
- `boot(ctx)`
- `shutdown()`
- `sendMessage(message, dispatchContext)`

`ChannelPluginContext` exposes service operations for:

- projects
- sessions
- turns
- approvals
- models
- skills
- workspace files
- integration plugin config updates
- event retrieval

## 6. Web Plugin

The browser UI uses:

```text
/api/channels/plugins/web/app/*
```

Implemented route groups:

- `models`
- `skills`
- `fs/*`
- `projects`
- `projects/:projectId/sessions`
- `sessions/:id/*`
- `turns/:id/*`

The web plugin has `bindAllSessions=true`, so it receives dispatched events for all sessions without explicit provider bindings.

## 7. Discord Plugin

The Discord plugin uses `discord.js` Gateway mode, not HTTP interactions mode.

Implemented commands:

- `/project list`
- `/project info`
- `/project create`
- `/project bind`
- `/project change`
- `/session list`
- `/session create`
- `/session bind`
- `/session info`
- `/session history`
- `/session change`
- `/cancel`
- `/fs get`
- `/fs ls`
- `/fs tree`

Implemented inbound controls:

- require mention
- allowed users
- allowed guilds
- allowed channels
- allow/deny DM
- ignore bot messages
- max inbound length

Implemented outbound behavior:

- reply or new-message send style
- allowed mention controls
- message splitting to fit Discord length limits
- approval select menus
- typing heartbeat while turns are active
- reconnect attempts with backoff
- proxy env support

Bindings are stored in Discord `pluginConfig` as channel/session binding maps.

## 8. Message Flow

### Web Turn

1. Web calls `POST /api/channels/plugins/web/app/sessions/:id/turns`.
2. Web plugin delegates to `TurnsService`.
3. Turn events are persisted to `Event`.
4. Events are also queued as `BotMessage(kind=event)`.
5. Gateway dispatches to plugins.
6. Web SSE merges durable events with web plugin buffer.

### Discord Inbound

1. Discord message/command reaches `DiscordPlugin`.
2. Plugin checks trigger policy and resolves/binds project/session.
3. Plugin calls context methods to create project/session, create turn, steer, cancel, resolve approval, or read files.
4. API persists resulting messages/turns/events.

### Outbound Dispatch

1. API queues `BotMessage`.
2. `ChannelsGatewayService` pulls claimable messages.
3. Gateway resolves plugin bindings.
4. Plugin sends provider-specific output.
5. API marks message sent/failed.

## 9. Security and Operations

Implemented:

- User auth and owner checks on `/api/channels/*`.
- Discord trigger allowlists.
- Discord mention safety defaults.
- Runtime health/error fields on `BotIntegration`.

Not implemented:

- Credential envelope encryption.
- Provider webhook signature verification, because Discord currently uses Gateway mode.
- Externalized gateway M2M auth.
- Queue metrics/dead-letter alerts.
- Full audit log.

## 10. Future Work

1. Encrypt and rotate provider credentials.
2. Add durable binding tables if `pluginConfig` becomes too hard to manage.
3. Add queue retry/dead-letter policy and admin retry endpoints.
4. Add focused Discord automated tests.
5. Implement `BotAuthSession` flows when adding a provider that needs OAuth/QR/device-code auth.
6. Revisit externalized gateway mode only if operational requirements need a separate process.
