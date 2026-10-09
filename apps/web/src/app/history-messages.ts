export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  turnId?: string | null;
  backendItemId?: string | null;
  historySeq?: number | null;
  state?: string;
  phase?: string | null;
  startEventSeq?: number | null;
  endEventSeq?: number | null;
  timelineStartSeq?: number | null;
  lastEventSeq?: number;
};

export type QueuedInput = {
  id: string;
  turnId: string;
  clientRequestId: string;
  content: string;
  status: "queued" | "accepted" | "failed" | "unconfirmed";
  createdAt: string;
  errorMessage?: string | null;
};

type HistoryEvent = {
  turnId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
};

export function readHistoryMessageSnapshot(event: HistoryEvent): ChatMessage | undefined {
  const snapshot = event.payload.message as ChatMessage | undefined;
  if (!snapshot?.id) return undefined;
  return {
    ...snapshot,
    turnId: snapshot.turnId ?? event.turnId,
    backendItemId: snapshot.backendItemId ??
      (typeof event.payload.itemId === 'string' ? event.payload.itemId : undefined),
  };
}

export function mergeHistoryMessages(
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (previous && (previous.lastEventSeq ?? 0) > (message.lastEventSeq ?? 0))
      continue;
    byId.set(message.id, { ...previous, ...message });
  }
  return Array.from(byId.values()).sort((a, b) => {
    if (typeof a.historySeq === "number" && typeof b.historySeq === "number")
      return a.historySeq - b.historySeq;
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

export function applyHistoryEvent(
  current: ChatMessage[],
  event: HistoryEvent,
): ChatMessage[] {
  if (event.payload.ignored === true) return current;
  const snapshot = readHistoryMessageSnapshot(event);
  if (snapshot?.id)
    return mergeHistoryMessages(current, [
      { ...snapshot, lastEventSeq: event.seq },
    ]);
  if (Array.isArray(event.payload.messages)) {
    return mergeHistoryMessages(
      current,
      (event.payload.messages as ChatMessage[]).map((message) => ({
        ...message,
        turnId: message.turnId ?? event.turnId,
        lastEventSeq: event.seq,
      })),
    );
  }
  if (
    event.type !== "assistant.delta" ||
    typeof event.payload.itemId !== "string"
  )
    return current;
  return current.map((message) => {
    if (
      message.id !== event.payload.messageId ||
      message.state !== "streaming" ||
      (message.lastEventSeq ?? 0) >= event.seq
    )
      return message;
    return {
      ...message,
      content:
        message.content +
        (typeof event.payload.text === "string" ? event.payload.text : ""),
      lastEventSeq: event.seq,
    };
  });
}

export function mergeQueuedInput(
  current: QueuedInput[],
  input: QueuedInput,
): QueuedInput[] {
  const previous = current.find(
    (entry) =>
      entry.clientRequestId === input.clientRequestId &&
      entry.turnId === input.turnId,
  );
  // An HTTP acknowledgement or queued event can arrive after acceptance.
  if (
    previous?.status === "accepted" ||
    (previous && previous.status !== "queued" && input.status === "queued")
  )
    return current;
  return [
    ...current.filter((entry) => entry !== previous),
    { ...previous, ...input },
  ].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export function applyInputEvent(
  current: QueuedInput[],
  event: HistoryEvent,
): QueuedInput[] {
  if (
    ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)
  ) {
    return current.map((input) =>
      input.turnId === event.turnId && input.status === "queued"
        ? {
            ...input,
            status: "unconfirmed",
            errorMessage: "Turn ended before input acceptance was confirmed.",
          }
        : input,
    );
  }
  if (event.type === "turn.input.updated" && event.payload.input) {
    return mergeQueuedInput(current, event.payload.input as QueuedInput);
  }
  if (
    event.type === "user.message.accepted" &&
    typeof event.payload.clientRequestId === "string"
  ) {
    const message = event.payload.message as ChatMessage | undefined;
    return mergeQueuedInput(current, {
      id: event.payload.clientRequestId,
      clientRequestId: event.payload.clientRequestId,
      turnId: event.turnId,
      content: message?.content ?? "",
      createdAt: message?.createdAt ?? "",
      status: "accepted",
    });
  }
  return current;
}

export function eventInMessageRange(
  message: ChatMessage | null,
  seq: number,
): boolean {
  return (
    !message ||
    (seq > (message.timelineStartSeq ?? 0) &&
      (message.endEventSeq == null || seq <= message.endEventSeq))
  );
}
