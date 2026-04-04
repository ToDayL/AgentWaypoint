# Channels Gateway Architecture (Current)

```mermaid
flowchart TB
  subgraph Client["Client Layer"]
    FE["Web Frontend"]
  end

  subgraph API["API Process (In-Process Gateway Core)"]
    WPC["Web Plugin App Controller\n/api/channels/plugins/web/app/*"]
    GW["ChannelsGatewayService\n(dispatch loop + plugin context)"]
    WP["WebPluginPlugin\n(bindAllSessions=true)"]
    CS["ChannelsService\n(bindings + queue ops)"]
    T["TurnsService"]
    S["SessionsService / ProjectsService"]
    R["RunnerAdapter\n(http/mock)"]
    Q[("BotMessage Queue\nPostgres")]
    E[("Event Store\nPostgres")]
  end

  FE -->|"HTTP API + SSE"| WPC
  WPC --> WP
  WP -->|"PluginContext methods"| GW
  GW --> S
  GW --> T
  GW --> R
  GW --> CS

  %% Inbound
  FE -->|"create turn"| WPC
  WPC -->|"createTurnForSession"| WP
  WP --> GW
  GW --> T
  T --> R

  %% Runner events
  R -->|"runner events"| T
  T -->|"appendEvent"| E
  T -->|"enqueue kind=event / turn_message"| Q

  %% Outbound dispatcher
  GW -->|"pull queued messages"| CS
  CS --> Q
  GW -->|"resolve session bindings\n(integrationId + guid/channel/thread)"| CS
  GW -->|"sendMessage(message, dispatchContext)"| WP
  WP -->|"capture dispatched events\n(per-session latest-turn buffer)"| WP
  GW -->|"mark sent/failed"| CS
  CS --> Q

  %% SSE source (new)
  WPC -->|"turn stream reads dispatched buffer"| WP
```

## Notes
- Web plugin no longer reads turn SSE directly from `Event` table; stream is fed by gateway-dispatched messages captured by web plugin.
- Dispatch routing is binding-driven (session bindings + plugin `bindAllSessions` policy), not identifier parsing.
- Dispatch context includes structured trigger metadata:
  - `triggerProvider`
  - `triggerIntegrationId`
  - `isTriggeredByYou`
  - binding target fields (`integrationId`, `guid`, `channel`, `thread`)

