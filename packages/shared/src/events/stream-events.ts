export type StreamEventType =
  | 'turn.started'
  | 'assistant.delta'
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
