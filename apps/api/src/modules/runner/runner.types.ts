export type StartTurnInput = {
  turnId: string;
  sessionId: string;
  content: string;
  threadId?: string | null;
  cwd?: string | null;
  model?: string | null;
  sandbox?: string | null;
  approvalPolicy?: string | null;
};

export type AvailableModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
};

export type CancelTurnInput = {
  turnId: string;
};

export type SteerTurnInput = {
  turnId: string;
  content: string;
};

export type ForkThreadInput = {
  threadId: string;
  cwd?: string | null;
  model?: string | null;
  sandbox?: string | null;
  approvalPolicy?: string | null;
};

export type ForkThreadResult = {
  threadId: string;
};

export type CloseThreadInput = {
  threadId: string;
};

export type CompactThreadInput = {
  threadId: string;
  cwd?: string | null;
  model?: string | null;
  sandbox?: string | null;
  approvalPolicy?: string | null;
};

export type EnsureDirectoryInput = {
  path: string;
};

export type EnsureDirectoryResult = {
  path: string;
  created: boolean;
};

export type WorkspaceSuggestionInput = {
  prefix: string;
  limit?: number;
};

export type WorkspaceTreeInput = {
  path: string;
  limit?: number;
};

export type WorkspaceTreeEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type WorkspaceFileInput = {
  path: string;
  maxBytes?: number;
};

export type WorkspaceFileResult = {
  path: string;
  content: string;
  truncated: boolean;
};

export type WorkspaceUploadInput = {
  body: NodeJS.ReadableStream;
  contentType: string;
  contentLength?: string | null;
};

export type WorkspaceUploadResult = {
  path: string;
  relativePath: string;
  size: number;
  mimeType: string;
};

export type RateLimitWindow = {
  usedPercent: number | null;
  resetsAt: number | null;
  windowDurationMins: number | null;
};

export type RateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  credits: {
    balance: string | null;
    hasCredits: boolean;
    unlimited: boolean;
  } | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
};

export type AccountRateLimits = {
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
};

export type ApprovalDecisionInput =
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

export type ResolveTurnApprovalInput = {
  turnId: string;
  requestId: string;
  decision: ApprovalDecisionInput;
};

export type RunnerStreamEvent = {
  turnId: string;
  seq: number;
  type:
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
  payload: Record<string, unknown>;
  createdAt: string;
};

export interface RunnerAdapter {
  startTurn(input: StartTurnInput): Promise<void>;
  consumeTurnEvents(
    input: { turnId: string; sinceSeq?: number },
    onEvent: (event: RunnerStreamEvent) => Promise<void>,
  ): Promise<void>;
  steerTurn(input: SteerTurnInput): Promise<void>;
  cancelTurn(input: CancelTurnInput): Promise<void>;
  resolveTurnApproval(input: ResolveTurnApprovalInput): Promise<void>;
  readAccountRateLimits(): Promise<AccountRateLimits>;
  listModels(): Promise<AvailableModel[]>;
  forkThread(input: ForkThreadInput): Promise<ForkThreadResult>;
  closeThread(input: CloseThreadInput): Promise<void>;
  compactThread(input: CompactThreadInput): Promise<void>;
  ensureDirectory(input: EnsureDirectoryInput): Promise<EnsureDirectoryResult>;
  suggestWorkspaceDirectories(input: WorkspaceSuggestionInput): Promise<string[]>;
  listWorkspaceTree(input: WorkspaceTreeInput): Promise<WorkspaceTreeEntry[]>;
  readWorkspaceFile(input: WorkspaceFileInput): Promise<WorkspaceFileResult>;
  uploadWorkspaceFile(input: WorkspaceUploadInput): Promise<WorkspaceUploadResult>;
}

export const RUNNER_ADAPTER = Symbol('RUNNER_ADAPTER');
