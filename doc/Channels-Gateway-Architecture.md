# Channels Gateway Architecture

Last aligned with implementation: 2026-05-11

```mermaid
flowchart TB
  subgraph Client["Client / Provider Layer"]
    FE["Web Frontend"]
    DC["Discord Gateway"]
  end

  subgraph API["API Process"]
    WAC["WebPluginAppController\n/api/channels/plugins/web/app/*"]
    CC["ChannelsController\n/api/channels/*"]
    GW["ChannelsGatewayService\nplugin lifecycle + dispatch loop"]
    WP["WebPlugin\nbindAllSessions=true"]
    DP["DiscordPlugin\ndiscord.js client + slash commands"]
    CS["ChannelsService\nintegrations + queue ops"]
    T["TurnsService"]
    S["ProjectsService / SessionsService"]
    R["RunnerAdapter\nembedded/mock/http"]
    Q[("BotMessage Queue\nSQLite")]
    E[("Event Store\nSQLite")]
    BI[("BotIntegration\nSQLite")]
  end

  FE -->|"HTTP API + SSE"| WAC
  FE -->|"integration management"| CC
  DC -->|"messages, commands, interactions"| DP

  WAC --> WP
  WP --> GW
  DP --> GW
  GW --> S
  GW --> T
  GW --> R
  GW --> CS
  CS --> Q
  CS --> BI
  T --> E
  T --> Q

  GW -->|"pull queued messages"| CS
  GW -->|"sendMessage(message, dispatchContext)"| WP
  GW -->|"sendMessage(message, dispatchContext)"| DP
  WP -->|"per-session dispatched event buffer"| WP
```

## Current Model

- The channel gateway runs inside the API process.
- Plugins are Nest providers booted by `ChannelsGatewayService`.
- Implemented plugins:
  - `WebPlugin`
  - `DiscordPlugin`
- `BotMessage` is the active outbound queue table.
- Runner events are persisted to `Event`; `BotMessage(kind=event)` stores an `eventId` outbox reference, which the gateway hydrates before plugin dispatch.
- Dispatch routing is binding-driven:
  - Web plugin binds all sessions.
  - Discord bindings live in `BotIntegration.pluginConfig`.
- No `/api/channels/gateway/*` externalized HTTP controller is implemented.

## Web Plugin Flow

- Web UI calls `/api/channels/plugins/web/app/*`.
- Controller delegates to `WebPlugin`.
- `WebPlugin` delegates through `ChannelPluginContext`.
- The context calls core services for projects, sessions, turns, models, skills, filesystem, and event streams.
- Web SSE merges persisted DB events with the web plugin's latest-turn in-memory dispatch buffer.

## Discord Plugin Flow

- Discord integrations are stored as `BotIntegration(provider="discord")`.
- Credentials/config come from `credentialsEncrypted` and `pluginConfig`.
- The plugin uses `discord.js` Gateway mode.
- Supported commands include:
  - `/project`
  - `/session`
  - `/cancel`
  - `/fs`
- Inbound Discord messages can create turns after trigger/user/guild/channel policy checks.
- Outbound turn messages/events are dispatched back to Discord through `BotMessage`.
- Approval requests use Discord select menus where possible.

## Known Limits

- Plugin runtime state is in-memory.
- Queue retry/backoff is basic compared with the larger future gateway design.
- Dedicated binding tables are not implemented.
- Externalized gateway M2M auth is not implemented.
- Credentials are stored as JSON payloads; envelope encryption is a future hardening task.
