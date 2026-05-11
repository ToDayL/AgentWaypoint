# Channels Gateway Implementation Checklist

Last aligned with implementation: 2026-05-11

## Implemented

- [x] In-process gateway runtime in API (`ChannelsGatewayService`).
- [x] Plugin lifecycle: `boot(ctx)` and `shutdown()`.
- [x] Plugin context for project/session/turn/model/skill/filesystem operations.
- [x] Web plugin under `/api/channels/plugins/web/app/*`.
- [x] Discord plugin using `discord.js` Gateway mode.
- [x] User-facing integration APIs:
  - `POST /api/channels/integrations`
  - `GET /api/channels/integrations`
  - `GET /api/channels/integrations/:botIntegrationId`
  - `PATCH /api/channels/integrations/:botIntegrationId`
  - `POST /api/channels/integrations/:botIntegrationId/activate`
  - `POST /api/channels/integrations/:botIntegrationId/pause`
  - `DELETE /api/channels/integrations/:botIntegrationId`
- [x] User-facing message APIs:
  - `POST /api/channels/messages/send`
  - `POST /api/channels/messages/send-approval`
  - `GET /api/channels/messages`
  - `GET /api/channels/messages/:messageId`
- [x] Prisma models:
  - `BotIntegration`
  - `BotMessage`
  - `ChannelFile`
  - `BotAuthSession`
- [x] `BotMessage` queue pull/claim/report service methods for in-process dispatch.
- [x] Runner events mirrored into `BotMessage(kind=event)`.
- [x] Trigger metadata persisted on turns:
  - `triggerIdentifier`
  - `triggerProvider`
  - `triggerIntegrationId`
  - `triggerMessageId`
- [x] Web SSE path merges persisted events and web-plugin dispatched buffer.
- [x] Discord commands:
  - `/project list|info|create|bind|change`
  - `/session list|create|bind|info|history|change`
  - `/cancel`
  - `/fs get|ls|tree`
- [x] Discord trigger filters:
  - mention required flag
  - allowed users
  - allowed guilds
  - allowed channels
  - DM allow/deny
  - bot-message ignore flag
  - inbound length cap
- [x] Discord approval menu handling.
- [x] Discord outbound message splitting and mention safety controls.
- [x] Proxy env support for Discord HTTP/WebSocket traffic.

## Implemented But Simplified

- [x] Bindings are stored in `BotIntegration.pluginConfig`, not dedicated binding tables.
- [x] Queue storage uses SQLite tables, not Redis/Kafka/raw-normalized-action queues.
- [x] Plugin reload is handled by polling/boot-time reconciliation and runtime checks, not a durable integration lifecycle event table.
- [x] Web plugin event buffer is in-memory and scoped to latest session turn.
- [x] `credentialsEncrypted` is a JSON field but current code does not perform envelope encryption.
- [x] Channel file model exists, but full provider attachment pipeline is not complete.

## Not Implemented

- [ ] Externalized gateway runtime.
- [ ] `/api/channels/gateway/*` HTTP controller.
- [ ] Gateway M2M token issuing and scope guard.
- [ ] Raw/normalized/action event queues.
- [ ] Dedicated provider routing/binding tables.
- [ ] Admin message retry endpoint.
- [ ] Dead-letter queue and replay UI.
- [ ] Provider credential encryption/rotation.
- [ ] Full OAuth/QR/device-code auth flows using `BotAuthSession`.
- [ ] Production metrics/alerts for queue depth, send success rate, and dead letters.

## Current Verification

Use the normal repo checks:

```bash
corepack pnpm --filter @agentwaypoint/api typecheck
corepack pnpm --filter @agentwaypoint/web typecheck
./scripts/test-api-e2e.sh
```

For Discord manual verification:

1. Create a Discord integration in Web Config.
2. Provide bot token and trigger rules.
3. Confirm runtime status becomes active/no recent error.
4. Use `/project create` or `/project bind`.
5. Use `/session create` or `/session bind`.
6. Send a trigger message and verify a turn starts.
7. Verify assistant output and approval controls are dispatched back to Discord.

## Next Work

1. Add focused e2e/unit coverage for Discord integration lifecycle and command routing.
2. Add credential encryption before treating Discord tokens as production-ready.
3. Add durable plugin reload events for integration create/update/delete.
4. Add queue retry/dead-letter policies and admin retry UX.
5. Decide whether externalized gateway mode is still needed; if yes, implement M2M auth and controller paths deliberately.
