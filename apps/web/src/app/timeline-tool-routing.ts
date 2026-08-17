type ToolTimelineEvent = {
  kind: string;
  toolKey?: string;
};

type ToolEnvelope = {
  seq: number;
  payload: Record<string, unknown>;
};

export function resolveToolKey(envelope: ToolEnvelope): string {
  const payload = envelope.payload;
  const keyCandidate =
    payload.toolCallId ??
    payload.tool_call_id ??
    payload.toolId ??
    payload.itemId ??
    payload.item_id ??
    payload.callId ??
    payload.id ??
    payload.title ??
    payload.kind;
  if (typeof keyCandidate === 'string' && keyCandidate.trim().length > 0) {
    return keyCandidate.trim();
  }
  return `seq-${envelope.seq}`;
}

export function findTargetToolTimelineIndex(events: ToolTimelineEvent[], toolKey: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'tool' && event.toolKey === toolKey) {
      return index;
    }
  }
  return -1;
}
