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

export type EnsureDirectoryInput = {
  path: string;
};

export type EnsureDirectoryResult = {
  path: string;
  created: boolean;
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
  listModels(): Promise<AvailableModel[]>;
  forkThread(input: ForkThreadInput): Promise<ForkThreadResult>;
  ensureDirectory(input: EnsureDirectoryInput): Promise<EnsureDirectoryResult>;
}

export const RUNNER_ADAPTER = Symbol('RUNNER_ADAPTER');
