# Claude Agent SDK Integration Design Doc

## Overview

Add Claude Agent SDK support to AgentWaypoint as an alternative backend to the existing Codex CLI backend.

## Architecture

### Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      HTTP Server (main.ts)                  │
│  - Route handling                                          │
│  - Event streaming via SSE                                  │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
┌───────────────────┐     ┌───────────────────────────┐
│ FilesystemBackend │     │    CodexBackend            │
│ - Path validation │     │ - Spawns codex worker      │
│ - Cwd resolution  │     │ - JSON-RPC over stdio      │
└───────────────────┘     └───────────────────────────┘
```

### Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      HTTP Server (main.ts)                │
│  - Route handling                                          │
│  - Event streaming via SSE                                 │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        ▼               ▼               ▼
┌───────────────┐ ┌──────────────┐ ┌─────────────────────┐
│FilesystemBackend│ │ CodexBackend │ │ClaudeAgentBackend  │
│   (shared)    │ │   (codex)    │ │  (claude-agent)   │
└───────────────┘ └──────────────┘ └─────────────────────┘
```

## Endpoint Design

### Per-Backend Endpoints

The runner will have separate endpoint paths for each backend:

| Path | Backend | Description |
|------|---------|-------------|
| `/runner/codex/*` | Codex | Codex CLI backend |
| `/runner/claude-agent/*` | Claude Agent | Claude Agent SDK backend |
| `/runner/fs/*` | (shared) | Filesystem operations |

### API to Runner Mapping

| API Interface Method | Codex Endpoint | Claude Agent Endpoint |
|---------------------|----------------|----------------------|
| `startTurn` | POST `/runner/codex/turns/start` | POST `/runner/claude-agent/turns/start` |
| `consumeTurnEvents` | GET `/runner/codex/turns/{id}/stream` | GET `/runner/claude-agent/turns/{id}/stream` |
| `steerTurn` | POST `/runner/codex/turns/steer` | POST `/runner/claude-agent/turns/steer` |
| `cancelTurn` | POST `/runner/codex/turns/cancel` | POST `/runner/claude-agent/turns/cancel` |
| `resolveTurnApproval` | POST `/runner/codex/turns/approval` | POST `/runner/claude-agent/turns/approval` |
| `readAccountRateLimits` | GET `/runner/codex/account/rate-limits` | GET `/runner/claude-agent/account/rate-limits` |
| `listModels` | GET `/runner/codex/models` | GET `/runner/claude-agent/models` |
| `forkThread` | POST `/runner/codex/threads/fork` | POST `/runner/claude-agent/threads/fork` |
| `closeThread` | POST `/runner/codex/threads/close` | POST `/runner/claude-agent/threads/close` |
| `ensureDirectory` | POST `/runner/fs/ensure-directory` | (shared) |
| `suggestWorkspaceDirectories` | GET `/runner/fs/suggestions` | (shared) |

## Runner Implementation

### Files to Create

1. **apps/runner/src/backends/backend.interface.ts** - Abstract interface

```typescript
interface IRunnerBackend {
  readonly backendType: RunnerBackend;
  listModels(): Promise<ModelListItem[]>;
  readAccountRateLimits(): Promise<Record<string, unknown>>;
  startTurn(input: StartTurnBody): Promise<void>;
  forkThread(input: ForkThreadBody): Promise<string>;
  closeThread(input: CloseThreadBody): Promise<void>;
  steerTurn(input: SteerTurnBody): Promise<void>;
  cancelTurn(turnId: string): Promise<void>;
  resolvePendingApproval(input: ResolveApprovalBody): Promise<void>;
  disposePendingApprovalsForTurn(turnId: string, decision: 'decline' | 'cancel'): Promise<void>;
  silentlyDisposeTurn(turnId: string): void;
}
```

2. **apps/runner/src/claude-agent-backend.ts** - Claude Agent backend implementation

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `RUNNER_CLAUDE_API_KEY` | Anthropic API key | Yes | - |
| `RUNNER_CLAUDE_BASE_URL` | API base URL | No | `https://api.anthropic.com` |
| `RUNNER_CLAUDE_DEFAULT_MODEL` | Default model | No | `claude-sonnet-4-20250514` |

### SDK Initialization

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: userMessage,
  options: {
    canUseTool: async (toolName, input) => {
      // Emit approval request event
      // Wait for user decision
      return { behavior: "allow", updatedInput: input };
    }
  }
})) {
  // Handle message events
}
```

### Event Mapping

Claude Agent SDK events to Runner events:

| SDK Event | Runner Event |
|-----------|-------------|
| `tool` (canUseTool callback) | `turn.approval.requested` |
| text content delta | `assistant.delta` |
| tool execution | `tool.started`, `tool.output`, `tool.completed` |
| message_stop | `turn.completed` |
| error | `turn.failed` |

## Database Schema Changes

### Project Model

```prisma
model Project {
  id                    String    @id @default(cuid())
  ownerUserId           String
  name                  String
  repoPath              String?
  defaultModel          String?
  defaultSandbox        String?
  defaultApprovalPolicy String?
  backend              String?   // 'codex' | 'claude-agent', null = default to codex
  createdAt             DateTime  @default(now())
  sessions              Session[]
  owner                 User      @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)

  @@index([ownerUserId])
}
```

### Session Model

```prisma
model Session {
  id                     String    @id @default(cuid())
  projectId              String
  title                  String
  status                 String
  cwdOverride            String?
  modelOverride          String?
  sandboxOverride        String?
  approvalPolicyOverride String?
  codexThreadId          String?
  claudeSessionId       String?   // For Claude Agent sessions
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt
  messages               Message[]
  turns                  Turn[]
  project                Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId])
}
```

## Approval Handling

Both Codex and Claude Agent support approvals, but differently:

### Codex

- Built-in via JSON-RPC notifications
- Methods: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`
- Policy support: `never`, `always`, per-action

### Claude Agent

- Uses `canUseTool` callback in SDK
- Returns `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }`
- Also handles `AskUserQuestion` for clarifying questions

## Implementation Phases

### Phase 1: Backend Interface & Types
- Create `backend.interface.ts`
- Update `types.ts` with new types

### Phase 2: Claude Agent Backend
- Create `claude-agent-backend.ts`
- Implement all IRunnerBackend methods
- Add `@anthropic-ai/claude-agent-sdk` dependency

### Phase 3: Runner Integration
- Add endpoint routing for each backend
- Update main.ts to route to correct backend
- Add health endpoints per backend

### Phase 4: Database & API
- Add `backend` field to Project schema
- Add `claudeSessionId` to Session schema
- Update HttpRunnerAdapter to route to correct endpoint

### Phase 5: Web Module
- Ensure backend field is passed through in API requests

## Verification

1. **Typecheck:**
   ```bash
   corepack pnpm --filter @agentwaypoint/runner typecheck
   corepack pnpm --filter @agentwaypoint/api typecheck
   ```

2. **Integration Test:**
   - Set `RUNNER_CLAUDE_API_KEY` env var
   - Create project with `backend: 'claude-agent'`
   - Start a turn and verify streaming
   - Verify tool execution events
   - Verify turn completion
