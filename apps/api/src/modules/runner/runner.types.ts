export type StartTurnInput = {
  turnId: string;
  sessionId: string;
  content: string;
  threadId?: string | null;
  cwd?: string | null;
};

export type CancelTurnInput = {
  turnId: string;
};

export type ResolveTurnApprovalInput = {
  turnId: string;
  requestId: string;
  decision: 'approve' | 'reject';
};

export interface RunnerAdapter {
  startTurn(input: StartTurnInput): Promise<void>;
  cancelTurn(input: CancelTurnInput): Promise<void>;
  resolveTurnApproval(input: ResolveTurnApprovalInput): Promise<void>;
}

export const RUNNER_ADAPTER = Symbol('RUNNER_ADAPTER');
