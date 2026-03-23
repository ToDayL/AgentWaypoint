# Claude Agent SDK Documentation Research and Interface Inventory

Last updated: 2026-03-23

## 1. Scope and Outcome

This summary is based on official Anthropic Agent SDK documentation, focused on integration details required by AgentWaypoint.

Key points:
- Claude Code SDK was renamed to Claude Agent SDK.
- TypeScript package: `@anthropic-ai/claude-agent-sdk`
- TypeScript currently provides:
  - V1 `query()` async-iterable model (used in our implementation)
  - V2 preview session APIs (`unstable_v2_*`)

## 2. TypeScript SDK (V1) Core Interfaces

Install:
- `npm install @anthropic-ai/claude-agent-sdk`

### 2.1 Core functions

- `query({ prompt, options? }) => Query`
- `tool(name, description, inputSchema, handler, extras?)`
- `createSdkMcpServer({ name, version?, tools? })`
- `listSessions(options?) => Promise<SDKSessionInfo[]>`
- `getSessionMessages(sessionId, options?) => Promise<SessionMessage[]>`
- `forkSession(sessionId, options?) => Promise<{ sessionId: string, ... }>`

### 2.2 Common `Options` fields used by us

- Session and turn control:
  - `resume`, `sessionId`, `maxTurns`, `forkSession`
- Model/config sources:
  - `model`, `systemPrompt`, `settingSources`
- Streaming behavior:
  - `includePartialMessages`
- Permissions and tools:
  - `permissionMode`, `canUseTool`
- Runtime:
  - `cwd`, `sandbox`
- Hooks:
  - `hooks`

### 2.3 Discovery helpers on Query object

Using a query stream, SDK exposes:
- `supportedModels()`
- `supportedCommands()`

Current implementation usage:
- Model list: `settingSources: ['user']`
- Slash command list: `settingSources: ['user', 'project', 'local']` with workspace `cwd`

## 3. TypeScript SDK (V2 Preview)

V2 is preview/unstable and not used in current backend.

Core APIs:
- `unstable_v2_createSession(options)`
- `unstable_v2_resumeSession(sessionId, options)`
- `unstable_v2_prompt(prompt, options)`

`SDKSession` exposes:
- `send(message)`
- `stream()`
- `close()`

## 4. Python SDK (Reference Only)

Install:
- `pip install claude-agent-sdk`

Useful parity concepts:
- `query(...)`
- `list_sessions(...)`
- `get_session_messages(...)`
- `fork_session` (option)
- `interrupt()` on client abstractions

## 5. Message/Type Families Worth Tracking

From official TS reference:
- Message types:
  - `SDKMessage`, `SDKAssistantMessage`, `SDKPartialAssistantMessage`, `SDKSystemMessage`, `SDKResultMessage`, etc.
- Usage and limits:
  - `ModelUsage`, `SDKRateLimitEvent`
- Permissions:
  - `PermissionMode`, `PermissionResult`, `PermissionUpdate`
- Tools:
  - built-in tool input/output schemas for `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`-related flows

## 6. Integration Notes Confirmed by Implementation

### 6.1 Long-lived turn stream

A single turn can be implemented as one long-lived `query(...)` call by providing `prompt` as `AsyncIterable<SDKUserMessage>`.
- Initial user message enters the queue at turn start.
- Steer appends later user messages to the same queue.
- No extra `query()` call is needed for steer.

### 6.2 Approval callback shape constraints

For `canUseTool` return values:
- `allow` branch requires `updatedInput` in our validated flow.
- `deny` branch should include `message`.
- `acceptForSession` can include `updatedPermissions` when SDK suggestions are present.

### 6.3 Session close limitation

Current TS V1 surface does not provide a documented direct `deleteSession` API.
Our close-thread behavior therefore uses local Claude session file deletion by session id + encoded cwd.

### 6.4 Context usage extraction

`SDKResultMessage` carries usage data, but context-window ratio is not always directly available in one canonical field.
Current implementation computes context remaining via `/context` command output parsing (`Tokens: used / total`).

## 7. Practical Guidance for Runner Integrations

- Use V1 `query()` as baseline unless V2 becomes stable and feature-complete.
- Keep API layer backend-agnostic; parse provider payloads only in runner backend.
- Treat SDK message payloads strictly; do not infer undocumented fields.

## 8. Official Sources

- TypeScript SDK reference (V1): https://platform.claude.com/docs/en/agent-sdk/typescript
- TypeScript SDK V2 preview: https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
- Python SDK reference: https://platform.claude.com/docs/en/agent-sdk/python
- Migration guide: https://platform.claude.com/docs/en/agent-sdk/migration-guide
- Overview: https://platform.claude.com/docs/en/agent-sdk/overview
- TS SDK repository: https://github.com/anthropics/claude-agent-sdk-typescript
