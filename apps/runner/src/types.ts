import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ServerResponse } from 'node:http';

export type StartTurnBody = {
  turnId: string;
  sessionId: string;
  content: string;
  backend?: string | null;
  backendConfig?: Record<string, unknown> | null;
  threadId?: string | null;
  cwd?: string | null;
};

export type ModelListItem = {
  id: string;
  backend: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
};

export type SkillListItem = {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
};

export type CancelTurnBody = {
  turnId: string;
};

export type SteerTurnBody = {
  turnId: string;
  content: string;
};

export type ForkThreadBody = {
  threadId: string;
  backend?: string | null;
  backendConfig?: Record<string, unknown> | null;
  cwd?: string | null;
};

export type CloseThreadBody = {
  threadId: string;
};

export type CompactThreadBody = {
  threadId: string;
  backend?: string | null;
  backendConfig?: Record<string, unknown> | null;
  cwd?: string | null;
};

export type EnsureDirectoryBody = {
  path: string;
};

export type WorkspaceTreeEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type ResolveApprovalBody = {
  turnId: string;
  requestId: string;
  decision:
    | 'accept'
    | 'acceptForSession'
    | 'decline'
    | 'cancel'
    | {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: string[];
        };
      }
    | {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            action: 'allow' | 'deny';
            host: string;
          };
        };
      };
};

export type RunnerEventType =
  | 'turn.started'
  | 'assistant.delta'
  | 'turn.approval.requested'
  | 'turn.approval.resolved'
  | 'thread.token_usage.updated'
  | 'plan.updated'
  | 'reasoning.delta'
  | 'diff.updated'
  | 'tool.started'
  | 'tool.output'
  | 'tool.completed'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled';

export type RunnerBackend = 'codex' | 'claude' | 'mock';

export type ActiveTurnBase = {
  turnId: string;
  sessionId: string;
  content: string;
  startedAt: string;
  finalized: boolean;
  backend: RunnerBackend;
};

export type ActiveMockTurn = ActiveTurnBase & {
  backend: 'mock';
  timers: ReturnType<typeof setTimeout>[];
};

export type ActiveCodexTurn = ActiveTurnBase & {
  backend: 'codex';
  threadId: string | null;
  codexTurnId: string | null;
  assistantText: string;
  completionResolve: (() => void) | null;
  completionReject: ((error: Error) => void) | null;
};

export type ActiveClaudeTurn = ActiveTurnBase & {
  backend: 'claude';
  query: {
    interrupt: () => Promise<void>;
    close: () => void;
  } | null;
  assistantText: string;
  completionResolve: (() => void) | null;
  completionReject: ((error: Error) => void) | null;
};

export type ActiveTurn = ActiveMockTurn | ActiveCodexTurn | ActiveClaudeTurn;

export type BufferedRunnerEvent = {
  turnId: string;
  seq: number;
  type: RunnerEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type RunnerTurnStreamState = {
  turnId: string;
  sessionId: string;
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  nextSeq: number;
  events: BufferedRunnerEvent[];
  listeners: Set<ServerResponse>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

export type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type CodexWorker = {
  process: ChildProcessWithoutNullStreams;
  nextRequestId: number;
  pendingRequests: Map<number, PendingRequest>;
  notificationQueue: Promise<void>;
  readyPromise: Promise<void>;
  closed: boolean;
};

export type PendingApprovalRequest = {
  worker: CodexWorker;
  rawRequestId: string | number;
  requestId: string;
  turnId: string;
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval' | 'item/permissions/requestApproval';
  params: Record<string, unknown>;
};
