export type StreamEventType =
  | 'turn.started'
  | 'assistant.delta'
  | 'turn.approval.requested'
  | 'turn.approval.resolved'
  | 'turn.approval.auto_review'
  | 'plan.updated'
  | 'reasoning.delta'
  | 'diff.updated'
  | 'tool.started'
  | 'tool.output'
  | 'tool.completed'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled';

export interface StreamEvent<TPayload = Record<string, unknown>> {
  type: StreamEventType;
  turnId: string;
  seq: number;
  payload: TPayload;
}
