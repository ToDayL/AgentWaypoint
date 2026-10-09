export type StreamEnvelope = {
  turnId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type TurnEventHistoryItem = {
  turnId?: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
};

export type TurnEventHistoryResponse = {
  turnId: string;
  events: TurnEventHistoryItem[];
} | TurnEventHistoryItem[];

export function normalizeTurnEventPage(
  response: TurnEventHistoryResponse,
  fallbackTurnId: string,
): { events: StreamEnvelope[]; eventCount: number } {
  // Accept the previous array response while API and Web versions roll out.
  const items = Array.isArray(response) ? response : response.events;
  const turnId = Array.isArray(response) ? fallbackTurnId : response.turnId;
  const events: StreamEnvelope[] = [];
  for (const item of items) {
    if (typeof item.seq !== 'number' || !Number.isFinite(item.seq)) continue;
    events.push({
      turnId: item.turnId?.trim() || turnId || fallbackTurnId,
      seq: item.seq,
      type: typeof item.type === 'string' && item.type.trim() ? item.type.trim() : 'event',
      payload: item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
        ? item.payload as Record<string, unknown>
        : {},
      createdAt: typeof item.createdAt === 'string' && item.createdAt
        ? item.createdAt
        : new Date().toISOString(),
    });
  }
  return { events, eventCount: items.length };
}
