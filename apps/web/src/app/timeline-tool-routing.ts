type ToolTimelineEvent = {
  kind: string;
  toolKey?: string;
  detailRef?: string;
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

export function findTargetToolTimelineIndex(
  events: ToolTimelineEvent[],
  toolKey: string,
  detailRef?: string,
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.kind === 'tool' &&
      (detailRef ? event.detailRef === detailRef : event.toolKey === toolKey)
    ) {
      return index;
    }
  }
  return -1;
}

export function resolveToolDetailRef(envelope: ToolEnvelope): string | undefined {
  const detailRef = envelope.payload.detailRef;
  return typeof detailRef === 'string' && detailRef.trim().length > 0
    ? detailRef.trim()
    : undefined;
}

export function isCommandToolKind(kind: string | undefined): boolean {
  if (!kind) {
    return false;
  }
  const normalized = kind.replace(/[^a-z0-9]+/gi, '').toLowerCase();
  return ['bash', 'command', 'commandexecution', 'localcommand', 'shell'].includes(normalized);
}
