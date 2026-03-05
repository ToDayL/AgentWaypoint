export type Role = 'user' | 'assistant' | 'system';

export interface MessageDto {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface CreateTurnRequest {
  content: string;
}

export interface CreateTurnResponse {
  turnId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
}
