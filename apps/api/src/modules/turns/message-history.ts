import { Prisma, type Message, type Turn } from "@prisma/client";

/** Call inside the same transaction as the event/turn creating the message. */
export async function createHistoryMessage(
  tx: Prisma.TransactionClient,
  args: { data: Prisma.MessageUncheckedCreateInput },
): Promise<Message> {
  const latest = await tx.message.aggregate({
    where: { sessionId: args.data.sessionId },
    _max: { historySeq: true },
  });
  return tx.message.create({
    data: { ...args.data, historySeq: (latest._max.historySeq ?? 0) + 1 },
  });
}

export function messageSnapshot(message: Message): Record<string, unknown> {
  return { ...message, createdAt: message.createdAt.toISOString() };
}

async function enqueueAssistantMessage(
  tx: Prisma.TransactionClient,
  turn: Turn & { session: { projectId: string } },
  message: Message,
): Promise<void> {
  if (!message.content.trim()) return;
  await tx.botMessage.upsert({
    where: { messageId: message.id },
    update: {},
    create: {
      messageId: message.id,
      projectId: turn.session.projectId,
      sessionId: turn.sessionId,
      kind: "turn_message",
      status: "queued",
      payloadRaw: {
        turnId: turn.id,
        messageId: message.id,
        scope: "assistant_message",
        phase: message.phase,
        state: message.state,
        historySeq: message.historySeq,
        triggerIdentifier: turn.triggerIdentifier,
        triggerProvider: turn.triggerProvider,
        triggerIntegrationId: turn.triggerIntegrationId,
        triggerMessageId: turn.triggerMessageId,
        content: message.content,
      },
    },
  });
}

/** Project the ordered event and its history/outbox changes atomically. */
export async function projectMessageEvent(
  tx: Prisma.TransactionClient,
  event: {
    turnId: string;
    seq: number;
    type: string;
    payload: Prisma.InputJsonValue;
  },
): Promise<Prisma.InputJsonValue> {
  const payload = event.payload as Record<string, unknown>;
  const isAssistant =
    event.type.startsWith("assistant.message.") ||
    (event.type === "assistant.delta" && typeof payload.itemId === "string");
  const isUser = event.type === "user.message.accepted";
  const isTerminal = [
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
  ].includes(event.type);
  if (!isAssistant && !isUser && !isTerminal) return event.payload;

  const turn = await tx.turn.findUniqueOrThrow({
    where: { id: event.turnId },
    include: { session: { select: { projectId: true } } },
  });
  if (isTerminal) {
    if (turn.historyVersion !== 2) return event.payload;
    const unfinished = await tx.message.findMany({
      where: { turnId: turn.id, role: "assistant", state: "streaming" },
    });
    const messages: Record<string, unknown>[] = [];
    for (const message of unfinished) {
      const closed = await tx.message.update({
        where: { id: message.id },
        data: { state: "interrupted", endEventSeq: event.seq },
      });
      await enqueueAssistantMessage(tx, turn, closed);
      messages.push(messageSnapshot(closed));
    }
    await tx.turnInput.updateMany({
      where: { turnId: turn.id, status: "queued" },
      data: {
        status: "unconfirmed",
        errorMessage: "Turn ended before input acceptance was confirmed.",
      },
    });
    await tx.turn.update({
      where: { id: turn.id },
      data: {
        status: event.type.slice(5),
        endedAt: new Date(),
        ...(event.type === "turn.failed"
          ? {
              failureCode:
                typeof payload.code === "string"
                  ? payload.code
                  : "RUNNER_FAILED",
              failureMessage:
                typeof payload.message === "string"
                  ? payload.message
                  : "Runner failed",
            }
          : {}),
      },
    });
    const { content: _content, ...metadata } = payload;
    return json({ ...metadata, historyVersion: 2, messages });
  }

  const itemId = typeof payload.itemId === "string" ? payload.itemId : "";
  if (!itemId) throw new Error(`${event.type} requires itemId`);
  const existing = await tx.message.findUnique({
    where: { turnId_backendItemId: { turnId: turn.id, backendItemId: itemId } },
  });

  if (isUser) {
    const clientId =
      typeof payload.clientId === "string" ? payload.clientId : null;
    const input = clientId
      ? await tx.turnInput.findUnique({
          where: {
            turnId_clientRequestId: {
              turnId: turn.id,
              clientRequestId: clientId,
            },
          },
        })
      : null;
    let message = existing;
    if (!message && payload.initial === true && turn.userMessageId) {
      message = await tx.message.update({
        where: { id: turn.userMessageId },
        data: {
          turnId: turn.id,
          backendItemId: itemId,
          startEventSeq: event.seq,
          endEventSeq: event.seq,
        },
      });
    }
    if (!message) {
      message = await createHistoryMessage(tx, {
        data: {
          sessionId: turn.sessionId,
          turnId: turn.id,
          backendItemId: itemId,
          role: "user",
          content:
            typeof payload.content === "string"
              ? payload.content
              : (input?.content ?? ""),
          startEventSeq: event.seq,
          endEventSeq: event.seq,
        },
      });
    }
    if (input) {
      await tx.turnInput.update({
        where: { id: input.id },
        data: {
          status: "accepted",
          messageId: message.id,
          backendItemId: itemId,
          acceptedAt: input.acceptedAt ?? new Date(),
          errorMessage: null,
        },
      });
    }
    return json({
      ...payload,
      message: messageSnapshot(message),
      clientRequestId: input?.clientRequestId ?? null,
    });
  }

  await tx.turn.update({ where: { id: turn.id }, data: { historyVersion: 2 } });
  const completed = event.type === "assistant.message.completed";
  // Terminal items never reopen on replay or on a late delta.
  if (existing && existing.state !== "streaming") {
    return json({ itemId, messageId: existing.id, ignored: true });
  }
  let message = existing;
  if (!message) {
    const previous = await tx.message.findFirst({
      where: { turnId: turn.id, role: "assistant", endEventSeq: { not: null } },
      orderBy: { endEventSeq: "desc" },
    });
    message = await createHistoryMessage(tx, {
      data: {
        sessionId: turn.sessionId,
        turnId: turn.id,
        backendItemId: itemId,
        role: "assistant",
        content: "",
        state: "streaming",
        startEventSeq: event.seq,
        timelineStartSeq: previous?.endEventSeq ?? 0,
      },
    });
  }
  const text = typeof payload.text === "string" ? payload.text : "";
  message = await tx.message.update({
    where: { id: message.id },
    data: {
      content: completed
        ? text
        : event.type === "assistant.delta"
          ? message.content + text
          : message.content,
      ...(typeof payload.phase === "string" ? { phase: payload.phase } : {}),
      ...(completed ? { state: "completed", endEventSeq: event.seq } : {}),
    },
  });
  if (completed) await enqueueAssistantMessage(tx, turn, message);
  // Deltas stay small. A snapshot is included for lifecycle events or a delta
  // that had to create the item because its start notification was missing.
  return json({
    ...payload,
    messageId: message.id,
    ...(!existing || event.type !== "assistant.delta"
      ? { message: messageSnapshot(message) }
      : {}),
  });
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
