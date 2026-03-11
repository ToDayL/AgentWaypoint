# Codex App Server Documentation (Checked Copy)

- Source URL: https://developers.openai.com/codex/app-server/
- Checked on: 2026-03-05
- Purpose: Project-local reference for AgentWaypoint integration planning.

## 1. What It Is
Codex App Server is the interface used by Codex rich clients. It is intended for deep product integration (auth, history, approvals, streamed agent events). For CI/job automation, the docs recommend using Codex SDK instead.

## 2. Transport and Protocol
- Protocol: JSON-RPC 2.0 style messages (wire format omits the `jsonrpc` header).
- Transport options:
  - `stdio` (default), newline-delimited JSON (JSONL).
  - `websocket` (experimental), one JSON-RPC message per WS text frame.
- WebSocket overload behavior: server can reject new requests with error `-32001`; client should retry with exponential backoff + jitter.

## 3. Message Types
- Request: includes `method`, `id`, `params`.
- Response: echoes `id` and includes either `result` or `error`.
- Notification: includes `method`, `params`, and no `id`.

## 4. Recommended Handshake and Core Flow
1. Start server: `codex app-server` (or `--listen ws://127.0.0.1:4500` for experimental WS).
2. Send `initialize` request immediately after connection opens.
3. Send `initialized` notification.
4. Start or resume thread (`thread/start`, `thread/resume`, `thread/fork`).
5. Start turn with `turn/start` and stream notifications.
6. Optionally steer active turn via `turn/steer`.

## 5. Important Concepts
- Thread: conversation container.
- Turn: one user request plus generated work.
- Item: unit of input/output/tool activity (message, command run, file change, tool call, etc.).

## 6. Thread Operations (Observed in docs)
- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/archive`
- `thread/unarchive`
- `thread/compact/start`
- `thread/rollback`

## 7. Turn Input and Overrides
- `turn/start` accepts `input` list with item types including text/image/localImage.
- Per-turn overrides are supported (e.g., model/personality/cwd/sandbox settings).
- `outputSchema` applies to current turn only.

## 8. Item Lifecycle and Streaming
Common lifecycle notifications:
- `item/started`
- `item/completed`

Common delta notifications:
- `item/agentMessage/delta`
- `item/plan/delta`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/textDelta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`

Observed item categories in docs include: `agentMessage`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall` (experimental), `collabToolCall`, `webSearch`, `imageView`, `contextCompaction`.

## 9. Approvals and User Input
- App server can request user approval/input using `tool/requestUserInput`.
- Client responses are resolved via `serverRequest/resolved` notifications.
- Tool calls with side effects may require approval; destructive operations are explicitly approval-gated.

## 10. Experimental API Gating
- Experimental fields/methods are behind `capabilities.experimentalApi` in `initialize`.
- If experimental methods are used without opt-in, server rejects them.

## 11. Schema Generation
Docs indicate generation commands to lock schema to your installed Codex version:
- `codex app-server generate-ts --out ./schemas`
- `codex app-server generate-json-schema --out ./schemas`

## 12. Skills Integration Notes
- Skill invocation can be triggered with `$<skill-name>` in text.
- Recommended: also send a `skill` input item so full instructions are injected directly.
- `skills/list` supports scoped lookup by `cwds`, optional `forceReload`, and extra roots.

## 13. AgentWaypoint Integration Guidance (Initial)
- Start with `stdio` transport in host `codex-runner` daemon for lower complexity.
- Normalize app-server notifications to frontend event model:
  - `item/started` -> tool/event timeline start
  - `item/*/delta` -> streaming UI updates
  - `item/completed` -> final authoritative event
- Persist thread/turn/item IDs exactly as provided for resumability.
- API should call runner over internal API; runner owns app-server process lifecycle.
- Implement reconnect and idempotent retry policy before enabling experimental WS transport.
- Keep experimental APIs disabled by default in production until feature-specific validation is complete.

## 14. Canonical References
- Official page: https://developers.openai.com/codex/app-server/
- Open-source implementation link referenced by docs:
  - https://github.com/openai/codex/tree/main/codex-rs/app-server
