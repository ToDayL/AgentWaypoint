# Claude Agent SDK Documentation Research and Interface Inventory

Last updated: 2026-03-21

## 1. Scope and Outcome

This summary is based on official Anthropic Agent SDK documentation (TypeScript V1, TypeScript V2 preview, Python reference, and migration/overview pages), focused on implementation-level integration details.

Key points:
- Claude Code SDK has been renamed to Claude Agent SDK.
- TypeScript package: `@anthropic-ai/claude-agent-sdk`
- Python package: `claude-agent-sdk` (import path `claude_agent_sdk`)
- TypeScript currently exposes both:
  - V1: async-generator `query()` model
  - V2 preview: session-based `send()` / `stream()` model

## 2. TypeScript SDK (V1) Core Interfaces

Install: `npm install @anthropic-ai/claude-agent-sdk`

### 2.1 Top-level Functions (Core)

- `query({ prompt, options? }) => Query`
  - `prompt`: `string | AsyncIterable<SDKUserMessage>`
  - `options`: `Options`
  - Returns a stream-capable `Query` object (async iterable)

- `tool(name, description, inputSchema, handler, extras?)`
  - Defines a type-safe MCP tool

- `createSdkMcpServer({ name, version?, tools? })`
  - Creates an in-process MCP server

- `listSessions(options?) => Promise<SDKSessionInfo[]>`
  - Lists prior sessions (filterable)

- `getSessionMessages(sessionId, options?) => Promise<SessionMessage[]>`
  - Reads session history

### 2.2 `Options` (Important Fields)

The official type has many fields; commonly used fields include:
- Model and reasoning: `model`, `fallbackModel`, `thinking`, `effort`
- Session control: `resume`, `maxTurns`, `forkSession`
- Permissions and tools: `permissionMode`, `canUseTool`, `allowedTools`, `disallowedTools`
- Prompt/config loading: `systemPrompt`, `settingSources`
- Runtime environment: `cwd`, `additionalDirectories`, `env`
- Extensibility: `mcpServers`, `agents`, `hooks`, `plugins`
- Security/sandbox: `sandbox`

### 2.3 Message Flow and Type Groups (Official)

TS V1 types are documented in these groups:
- Core config types: `Options`, `AgentDefinition`, `McpServerConfig`, `SdkPluginConfig`, etc.
- Message types: `SDKMessage`, `SDKAssistantMessage`, `SDKUserMessage`, `SDKResultMessage`, `SDKSystemMessage`, etc.
- Hook types: `HookEvent`, `HookCallback`, `HookInput`, `HookJSONOutput`, etc.
- Tool input types: built-in tool schemas under `ToolInputSchemas`
- Tool output types: built-in tool schemas under `ToolOutputSchemas`
- Permission types: `PermissionUpdate`, `PermissionRuleValue`, etc.
- Misc types: `ModelInfo`, `McpServerStatus`, `ModelUsage`, `SDKRateLimitEvent`, `SandboxSettings`, etc.

Built-in tools (input/output documented):
- `Agent`
- `AskUserQuestion`
- `Bash`
- `Edit`
- `Read`
- `Write`
- `Glob`
- `Grep`
- `TaskStop`
- `NotebookEdit`
- `WebFetch`
- `WebSearch`
- `TodoWrite`
- `ExitPlanMode`
- `ListMcpResources`
- `ReadMcpResource`
- `Config`
- `EnterWorktree`

## 3. TypeScript SDK (V2 Preview) Interfaces

V2 is an unstable preview and may change.

Core API:
- `unstable_v2_createSession(options) => SDKSession`
- `unstable_v2_resumeSession(sessionId, options) => SDKSession`
- `unstable_v2_prompt(prompt, options) => Promise<SDKResultMessage>`

`SDKSession` interface:
- `sessionId` (readonly)
- `send(message)`
- `stream()`
- `close()`

V2 does not yet expose all V1 capabilities (for some advanced flows, use V1).

## 4. Python SDK Core Interfaces

Install: `pip install claude-agent-sdk`

### 4.1 Top-level Functions

- `query(prompt, options=None, transport=None) -> AsyncIterator[Message]`
  - Starts a new session on each call

- `tool(name, description, input_schema, annotations=None)`
  - MCP tool decorator

- `create_sdk_mcp_server(name, version="1.0.0", tools=None)`

- `list_sessions(directory=None, limit=None, include_worktrees=True) -> list[SDKSessionInfo]`

- `get_session_messages(session_id, directory=None, limit=None, offset=0) -> list[SessionMessage]`

### 4.2 `ClaudeSDKClient` (Multi-turn Sessions)

`ClaudeSDKClient` is intended for persistent multi-turn conversations.

Documented methods:
- `connect(prompt=None)`
- `query(prompt, session_id="default")`
- `receive_messages()`
- `receive_response()`
- `interrupt()`
- `set_permission_mode(mode)`
- `set_model(model=None)`
- `rewind_files(user_message_id)`
- `get_mcp_status()`
- `add_mcp_server(name, config)`
- `remove_mcp_server(name)`
- `get_server_info()`
- `disconnect()`

### 4.3 `ClaudeAgentOptions` (Important Fields)

Common fields (aligned conceptually with TS):
- `model`, `fallback_model`, `thinking`, `effort`
- `permission_mode`, `can_use_tool`, `allowed_tools`, `disallowed_tools`
- `system_prompt`, `setting_sources`
- `cwd`, `add_dirs`, `env`
- `mcp_servers`, `agents`, `hooks`, `plugins`
- `resume`, `max_turns`, `fork_session`
- `sandbox`

Python also documents complete message types, hook types, permission types, content blocks, error types, and sandbox types.

## 5. Full Interface Index (From Official Reference TOCs)

This section is for completeness so interface/type names are not missed. For exact fields and shape details, use official pages.

### 5.1 TypeScript V1 TOC Index

- Functions
  - `query`
  - `tool`
  - `createSdkMcpServer`
  - `listSessions`
  - `getSessionMessages`
- Core/Config Types
  - `Options`
  - `Query object`
  - `SDKControlInitializeResponse`
  - `AgentDefinition`
  - `AgentMcpServerSpec`
  - `SettingSource`
  - `PermissionMode`
  - `CanUseTool`
  - `PermissionResult`
  - `ToolConfig`
  - `McpServerConfig`
  - `SdkPluginConfig`
- Message Types
  - `SDKMessage`
  - `SDKAssistantMessage`
  - `SDKUserMessage`
  - `SDKUserMessageReplay`
  - `SDKResultMessage`
  - `SDKSystemMessage`
  - `SDKPartialAssistantMessage`
  - `SDKCompactBoundaryMessage`
  - `SDKPermissionDenial`
- Hook Types
  - `HookEvent`
  - `HookCallback`
  - `HookCallbackMatcher`
  - `HookInput`
  - `BaseHookInput`
  - `HookJSONOutput`
- Tool Input Types (`ToolInputSchemas`)
  - `Agent`
  - `AskUserQuestion`
  - `Bash`
  - `TaskOutput`
  - `Edit`
  - `Read`
  - `Write`
  - `Glob`
  - `Grep`
  - `TaskStop`
  - `NotebookEdit`
  - `WebFetch`
  - `WebSearch`
  - `TodoWrite`
  - `ExitPlanMode`
  - `ListMcpResources`
  - `ReadMcpResource`
  - `Config`
  - `EnterWorktree`
- Tool Output Types (`ToolOutputSchemas`)
  - `Agent`
  - `AskUserQuestion`
  - `Bash`
  - `Edit`
  - `Read`
  - `Write`
  - `Glob`
  - `Grep`
  - `TaskStop`
  - `NotebookEdit`
  - `WebFetch`
  - `WebSearch`
  - `TodoWrite`
  - `ExitPlanMode`
  - `ListMcpResources`
  - `ReadMcpResource`
  - `Config`
  - `EnterWorktree`
- Permission Types
  - `PermissionUpdate`
  - `PermissionBehavior`
  - `PermissionUpdateDestination`
  - `PermissionRuleValue`
- Other Types
  - `ApiKeySource`
  - `SdkBeta`
  - `SlashCommand`
  - `ModelInfo`
  - `AgentInfo`
  - `McpServerStatus`
  - `McpServerStatusConfig`
  - `AccountInfo`
  - `ModelUsage`
  - `ConfigScope`
  - `NonNullableUsage`
  - `Usage`
  - `CallToolResult`
  - `ThinkingConfig`
  - `SpawnedProcess`
  - `SpawnOptions`
  - `McpSetServersResult`
  - `RewindFilesResult`
  - `SDKStatusMessage`
  - `SDKTaskNotificationMessage`
  - `SDKToolUseSummaryMessage`
  - `SDKHookStartedMessage`
  - `SDKHookProgressMessage`
  - `SDKHookResponseMessage`
  - `SDKToolProgressMessage`
  - `SDKAuthStatusMessage`
  - `SDKTaskStartedMessage`
  - `SDKTaskProgressMessage`
  - `SDKFilesPersistedEvent`
  - `SDKRateLimitEvent`
  - `SDKPromptSuggestionMessage`
  - `AbortError`
  - `SandboxSettings`
  - `SandboxNetworkConfig`
  - `SandboxFilesystemConfig`

### 5.2 Python TOC Index

- Functions
  - `query`
  - `tool`
  - `create_sdk_mcp_server`
  - `list_sessions`
  - `get_session_messages`
- Classes
  - `ClaudeSDKClient`
  - `Transport`
- Core Types
  - `ClaudeAgentOptions`
  - `OutputFormat`
  - `SystemPromptPreset`
  - `SettingSource`
  - `AgentDefinition`
  - `PermissionMode`
  - `CanUseTool`
  - `ToolPermissionContext`
  - `PermissionResult`
  - `PermissionResultAllow`
  - `PermissionResultDeny`
  - `PermissionUpdate`
  - `PermissionRuleValue`
  - `ToolsPreset`
  - `ThinkingConfig`
  - `SdkBeta`
  - `McpSdkServerConfig`
  - `McpServerConfig`
  - `McpServerStatus`
  - `SdkPluginConfig`
- Message Types
  - `Message`
  - `UserMessage`
  - `AssistantMessage`
  - `AssistantMessageError`
  - `SystemMessage`
  - `ResultMessage`
  - `StreamEvent`
  - `TaskStartedMessage`
  - `TaskUsage`
  - `TaskProgressMessage`
  - `TaskNotificationMessage`
- Content Block Types
  - `ContentBlock`
  - `TextBlock`
  - `ThinkingBlock`
  - `ToolUseBlock`
  - `ToolResultBlock`
- Error Types
  - `ClaudeSDKError`
  - `CLINotFoundError`
  - `CLIConnectionError`
  - `ProcessError`
  - `CLIJSONDecodeError`
- Hook Types
  - `HookEvent`
  - `HookCallback`
  - `HookContext`
  - `HookMatcher`
  - `HookInput`
  - `BaseHookInput`
  - `PreToolUseHookInput`
  - `PostToolUseHookInput`
  - `PostToolUseFailureHookInput`
  - `UserPromptSubmitHookInput`
  - `StopHookInput`
  - `SubagentStopHookInput`
  - `PreCompactHookInput`
  - `NotificationHookInput`
  - `SubagentStartHookInput`
  - `PermissionRequestHookInput`
  - `HookJSONOutput`
- Tool Input/Output Types (Built-in)
  - `Agent`
  - `AskUserQuestion`
  - `Bash`
  - `Edit`
  - `Read`
  - `Write`
  - `Glob`
  - `Grep`
  - `NotebookEdit`
  - `WebFetch`
  - `WebSearch`
  - `TodoWrite`
  - `BashOutput`
  - `KillBash`
  - `ExitPlanMode`
  - `ListMcpResources`
  - `ReadMcpResource`
- Sandbox
  - `SandboxSettings`
  - `SandboxNetworkConfig`
  - `SandboxIgnoreViolations`

## 6. Practical Guidance for Our Runner Backend

- Implement against TS/Python V1 semantics first (stable and full-surface).
- Use strict allow-listed mapping for incoming options (do not blindly passthrough unknown keys).
- Keep session, permission, MCP, and sandbox as backend-agnostic abstractions so multiple backends can coexist cleanly.

## 7. Official Sources

- TypeScript SDK reference (V1): https://platform.claude.com/docs/en/agent-sdk/typescript
- TypeScript SDK V2 (preview): https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
- Python SDK reference: https://platform.claude.com/docs/en/agent-sdk/python
- Agent SDK migration guide: https://platform.claude.com/docs/en/agent-sdk/migration-guide
- Agent SDK overview: https://platform.claude.com/docs/en/agent-sdk/overview
- TypeScript SDK repository: https://github.com/anthropics/claude-agent-sdk-typescript
