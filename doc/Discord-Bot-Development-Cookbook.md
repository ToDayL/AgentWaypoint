# Discord Bot Development Cookbook (Official-Docs Only)

This document is a source-grounded implementation reference for Discord plugin development.
Every normative statement below comes from official Discord documentation pages.

## 1) Official Sources Used

- Discord Developer Docs home: https://docs.discord.com/
- Build your first app (official quickstart): https://docs.discord.com/developers/quick-start/getting-started
- API reference (auth, headers, API versions, content types): https://docs.discord.com/developers/reference
- OAuth2 (bot auth flow, scopes, self-bot policy): https://docs.discord.com/developers/topics/oauth2
- Permissions (bitwise flags, hierarchy, implicit rules): https://docs.discord.com/developers/topics/permissions
- Rate limits: https://docs.discord.com/developers/topics/rate-limits
- Gateway (connection lifecycle, intents, privileged intents, limits): https://docs.discord.com/developers/events/gateway
- Gateway events catalog: https://docs.discord.com/developers/events/gateway-events
- Interactions overview (HTTP endpoint validation, PING/PONG, signature headers): https://docs.discord.com/developers/interactions/overview
- Receiving/responding to interactions (callback types, followups, deadlines): https://docs.discord.com/developers/interactions/receiving-and-responding
- Application commands (types, limits, contexts, permissions): https://docs.discord.com/developers/interactions/application-commands
- Message resource (create/edit/delete, embeds, allowed mentions, flags): https://docs.discord.com/developers/resources/message
- Channels resource (threads, typing indicator, channel operations): https://docs.discord.com/developers/resources/channel
- Guild resource (member moderation, bans, roles, prune): https://docs.discord.com/developers/resources/guild
- Webhook resource (execute/edit/delete webhook messages): https://docs.discord.com/developers/resources/webhook
- Discord official API docs repository: https://github.com/discord/discord-api-docs

## 2) Bot Account Model and Policy Constraints

- Discord docs explicitly distinguish bot users from standard users.
- Discord terms/policy note in docs: automating normal user accounts (“self-bots”) is not allowed outside OAuth2/bot API.
- Bot users are added through OAuth2, cannot accept normal invites, cannot join Group DMs like normal users, and use separate rate limits.

Source:
- https://docs.discord.com/developers/topics/oauth2#bot-vs-user-accounts

## 3) Installation and Authorization: What Must Be Configured

### 3.1 Application and credentials

From the official quickstart:
- Create app in Developer Portal.
- Retrieve Application ID and Public Key.
- Generate/reset bot token on Bot page.
- Keep token secret.

Source:
- https://docs.discord.com/developers/quick-start/getting-started

### 3.2 OAuth2 scopes for bot/plugin installs

Documented key scopes:
- `bot` (adds bot to guild)
- `applications.commands` (register commands in guilds; included by default with `bot` scope)
- `applications.commands.permissions.update` (update command permissions)
- `applications.commands.update` (update commands with client credentials token)

Source:
- https://docs.discord.com/developers/topics/oauth2
- https://docs.discord.com/developers/interactions/application-commands

### 3.3 Bot authorization flow

Discord documents bot invite URL params:
- `client_id`
- `scope` including `bot`
- `permissions` (bitfield)
- optional `guild_id`, `disable_guild_select`

Source:
- https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow

## 4) Two Interaction Delivery Modes (Mutually Exclusive)

Discord documents two ways to receive interactions:
- Gateway (`INTERACTION_CREATE` event)
- HTTP outgoing webhook to configured Interactions Endpoint URL

These are documented as mutually exclusive.

Source:
- https://docs.discord.com/developers/interactions/overview
- https://docs.discord.com/developers/interactions/receiving-and-responding

## 5) If Using HTTP Interactions: Security and Handshake Requirements

Officially required before endpoint validation:
- Respond to `PING` interaction (`type: 1`) with `PONG` payload (`type: 1`) and HTTP 200.
- Validate request headers:
  - `X-Signature-Ed25519`
  - `X-Signature-Timestamp`
- On failed signature validation, return 401.
- Discord states it performs ongoing automated invalid-signature checks and may remove invalid endpoints.

Source:
- https://docs.discord.com/developers/interactions/overview#configuring-an-interactions-endpoint-url

## 6) Commands: Types, Limits, Context Controls

### 6.1 Command types

Documented command types:
- `CHAT_INPUT` (slash)
- `USER`
- `MESSAGE`
- `PRIMARY_ENTRY_POINT`

Source:
- https://docs.discord.com/developers/interactions/application-commands

### 6.2 Quantity/rate limits for command definitions

Discord documents:
- 100 global `CHAT_INPUT`
- 15 global `USER`
- 15 global `MESSAGE`
- 1 global `PRIMARY_ENTRY_POINT`
- Global create rate limit: 200 application command creates/day/guild

Source:
- https://docs.discord.com/developers/interactions/application-commands

### 6.3 Context gating

Discord documents two context systems:
- `integration_types` (install contexts)
- `contexts` (interaction surfaces: `GUILD`, `BOT_DM`, `PRIVATE_CHANNEL`)

Source:
- https://docs.discord.com/developers/interactions/application-commands#contexts

### 6.4 Command permissions

Discord documents:
- Per-command allow/deny for roles/users/channels.
- Up to 100 overwrites.
- Requires Bearer token + `applications.commands.permissions.update` scope for command-permission APIs.

Source:
- https://docs.discord.com/developers/interactions/application-commands#permissions

## 7) What Messages a Bot Can Send

From `Create Message` and interaction/webhook message payload docs, a bot can send:
- Plain text content (up to 2000 chars)
- TTS
- Embeds (up to 10 rich embeds; up to 6000 characters total for embeds in message create/edit docs)
- Components
- Stickers (up to 3 in message create)
- Files/attachments (`multipart/form-data` upload flow)
- Polls
- Shared client theme object (documented field)
- Reply/forward via `message_reference`

Important documented constraints:
- At least one of content/embeds/stickers/components/files/poll/shared_client_theme is required for create message (except forwarding case using `message_reference`).
- `IS_COMPONENTS_V2` flag makes message component-driven; content/embeds/stickers/files/poll/shared_client_theme become invalid for that create payload.

Sources:
- https://docs.discord.com/developers/resources/message#create-message
- https://docs.discord.com/developers/resources/message
- https://docs.discord.com/developers/components/overview
- https://docs.discord.com/developers/components/reference

## 8) Mention and Notification Control

Discord documents `allowed_mentions` behavior:
- Controls whether user/role/everyone mentions in message content/components are parsed.
- Defaults differ by context:
  - Regular messages: parse users/roles/everyone
  - Interactions/webhooks: parse users only
- `SUPPRESS_NOTIFICATIONS` flag can disable push notifications (badge-only behavior).

Source:
- https://docs.discord.com/developers/resources/message#allowed-mentions-object

## 9) Interaction Response Capabilities

Documented callback types include:
- `PONG`
- `CHANNEL_MESSAGE_WITH_SOURCE`
- `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`
- `DEFERRED_UPDATE_MESSAGE`
- `UPDATE_MESSAGE`
- `APPLICATION_COMMAND_AUTOCOMPLETE_RESULT`
- `MODAL`
- `LAUNCH_ACTIVITY`

Documented timing rules:
- Interaction token valid for 15 minutes.
- Initial response must be sent within 3 seconds or token is invalidated.

Documented followup behavior:
- Followups use webhook-style endpoints.
- `EPHEMERAL` and `IS_COMPONENTS_V2` supported for followups.
- In specific user-install-only scenarios, followups are limited to 5 per interaction.

Source:
- https://docs.discord.com/developers/interactions/receiving-and-responding

## 10) Bot Actions It Can Take (Official Endpoints and Permissions)

Representative actions from official resource docs:

### 10.1 Messaging/channel actions
- Create/edit/delete messages, bulk delete, reactions, pins, typing indicator, thread operations.
- Permission requirements are endpoint-specific (examples: `SEND_MESSAGES`, `READ_MESSAGE_HISTORY`, `MANAGE_MESSAGES`, `ADD_REACTIONS`).

Sources:
- https://docs.discord.com/developers/resources/message
- https://docs.discord.com/developers/resources/channel

### 10.2 Member moderation and server management
- Add guild member (with user OAuth2 token + `guilds.join`, bot token auth, and guild permission requirements)
- Modify member attributes (nick/roles/mute/deaf/move/timeout)
- Kick member (`KICK_MEMBERS`)
- Ban/unban (`BAN_MEMBERS`)
- Bulk ban up to 200 users (`BAN_MEMBERS` + `MANAGE_GUILD`)
- Create/modify/delete roles (`MANAGE_ROLES`)
- Prune operations (`MANAGE_GUILD` + `KICK_MEMBERS`)

Source:
- https://docs.discord.com/developers/resources/guild

### 10.3 Webhook-based posting
- Create and execute webhooks, edit/delete webhook messages.
- Execute webhook requires message payload with at least one content mode (`content`, `embeds`, `components`, `file`, or `poll`).

Source:
- https://docs.discord.com/developers/resources/webhook

## 11) Intents, Data Visibility, and Gateway Limits

Documented intent behavior:
- Intents are required for v8+ identify flow.
- Invalid intent -> close code `4013`; unapproved privileged intent -> `4014`.
- Privileged intents: `GUILD_PRESENCES`, `GUILD_MEMBERS`, `MESSAGE_CONTENT`.
- `MESSAGE_CONTENT` affects access to content-bearing fields (`content`, `embeds`, `attachments`, `components`, `poll`) rather than mapping to specific event names.

Documented gateway operational limits:
- 120 gateway events per connection per 60 seconds.
- 1000 `IDENTIFY` calls / 24h across all shards (excluding `RESUME`), with severe enforcement if exceeded.
- Gateway payloads must be JSON/ETF and <= 4096 bytes.

Sources:
- https://docs.discord.com/developers/events/gateway
- https://docs.discord.com/developers/events/gateway-events

## 12) HTTP/API Operational Requirements

From API + rate-limit docs:
- Use `Authorization: Bot <token>` or `Authorization: Bearer <token>` as appropriate.
- Provide valid `User-Agent` and `Content-Type` headers.
- Parse rate-limit headers; do not hardcode limits.
- Global documented bot limit: up to 50 requests/sec.
- Invalid request limit (Cloudflare restriction): currently 10,000 invalid requests / 10 minutes (invalid includes 401/403/429; with documented note about shared 429 handling).
- Interaction endpoints are not bound to bot global rate limit.

Sources:
- https://docs.discord.com/developers/reference
- https://docs.discord.com/developers/topics/rate-limits

## 13) Implementation Checklist for Our Plugin (Doc-Derived)

1. Create app and securely store `APPLICATION_ID`, `PUBLIC_KEY`, and bot token.
2. Decide interaction ingress mode: Gateway or HTTP endpoint (not both simultaneously for interactions).
3. If HTTP mode: implement PING/PONG and signature verification (`X-Signature-Ed25519`, `X-Signature-Timestamp`).
4. Build install URL with required scopes (`bot`, `applications.commands` as needed) and permission bitfield.
5. Register commands via HTTP API; set `integration_types`, `contexts`, and `default_member_permissions` explicitly.
6. Implement response pipeline for 3-second initial ack requirement and 15-minute followup window.
7. Implement send/edit/delete message operations using documented payload fields and limits.
8. Implement mention safety via `allowed_mentions` defaults/overrides.
9. Enable only required intents; request privileged intents when needed.
10. Implement rate-limit handling using headers + retry-after and track invalid-request rate.

All checklist items above map directly to official docs cited in sections 3-12.
