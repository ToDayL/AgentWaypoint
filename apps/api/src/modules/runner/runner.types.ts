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

export interface RunnerAdapter {
  startTurn(input: StartTurnInput): Promise<void>;
  steerTurn(input: SteerTurnInput): Promise<void>;
  cancelTurn(input: CancelTurnInput): Promise<void>;
  resolveTurnApproval(input: ResolveTurnApprovalInput): Promise<void>;
  listModels(): Promise<AvailableModel[]>;
  forkThread(input: ForkThreadInput): Promise<ForkThreadResult>;
}

export const RUNNER_ADAPTER = Symbol('RUNNER_ADAPTER');
