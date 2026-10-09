import { describe, expect, it } from "vitest";
import {
  applyHistoryEvent,
  applyInputEvent,
  eventInMessageRange,
  mergeQueuedInput,
  mergeHistoryMessages,
  type ChatMessage,
  type QueuedInput,
} from "./history-messages";

const message: ChatMessage = {
  id: "a",
  turnId: "turn",
  backendItemId: "item-a",
  role: "assistant",
  content: "A",
  state: "streaming",
  historySeq: 2,
  createdAt: "2026-09-17T00:00:00Z",
  lastEventSeq: 5,
  timelineStartSeq: 2,
  startEventSeq: 3,
};
const queued: QueuedInput = {
  id: "pending",
  turnId: "turn",
  clientRequestId: "request",
  content: "steer",
  status: "queued",
  createdAt: "2026-09-17T00:00:01Z",
};

describe("message history streaming", () => {
  it('restores compact message associations and calibrates content after missing deltas', () => {
    const { turnId: _turnId, backendItemId: _backendItemId, ...snapshot } = message;
    const result = applyHistoryEvent([], {
      turnId: 'turn', seq: 10, type: 'assistant.message.completed',
      payload: {
        itemId: 'item-a', messageId: 'a',
        message: { ...snapshot, content: 'Final answer', state: 'completed', endEventSeq: 10 },
      },
    });
    expect(result[0]).toMatchObject({
      id: 'a', turnId: 'turn', backendItemId: 'item-a', content: 'Final answer',
      state: 'completed', lastEventSeq: 10, timelineStartSeq: 2, endEventSeq: 10,
    });
    expect(eventInMessageRange(result[0]!, 10)).toBe(true);
    expect(applyHistoryEvent(result, {
      turnId: 'turn', seq: 6, type: 'assistant.delta',
      payload: { itemId: 'item-a', messageId: 'a', text: 'Late delta' },
    })).toEqual(result);
  });

  it('restores each interrupted message from a compact terminal snapshot', () => {
    const { turnId: _turnId, ...snapshot } = message;
    expect(applyHistoryEvent([], {
      turnId: 'turn', seq: 10, type: 'turn.failed',
      payload: { message: 'Connection failed', messages: [{ ...snapshot, state: 'interrupted' }] },
    })[0]).toMatchObject({ turnId: 'turn', backendItemId: 'item-a', state: 'interrupted', lastEventSeq: 10 });
  });

  it('merges turn calibration without dropping older messages or overwriting newer SSE data', () => {
    const older = { ...message, id: 'older', turnId: 'old-turn', historySeq: 1, content: 'Old history' };
    const staleSnapshot = { ...message, content: 'Stale', lastEventSeq: 4 };
    const merged = mergeHistoryMessages([older, message], [staleSnapshot]);
    expect(merged.map((entry) => entry.content)).toEqual(['Old history', 'A']);
    const completed = { ...message, content: 'Complete', state: 'completed', lastEventSeq: 6 };
    expect(mergeHistoryMessages(merged, [completed]).map((entry) => entry.content)).toEqual(['Old history', 'Complete']);
    expect(mergeHistoryMessages(merged, [message])).toHaveLength(2);
  });
  it("does not reapply deltas already represented by a history snapshot", () => {
    const event = {
      turnId: "turn",
      seq: 5,
      type: "assistant.delta",
      payload: { itemId: "item-a", messageId: "a", text: "A" },
    };
    expect(applyHistoryEvent([message], event)[0]?.content).toBe("A");
    const next = applyHistoryEvent([message], {
      ...event,
      seq: 6,
      payload: { ...event.payload, text: "B" },
    });
    expect(applyHistoryEvent(next, { ...event, seq: 6 })[0]?.content).toBe(
      "AB",
    );
  });

  it("replaces the streamed draft, keeps its position and tolerates missing deltas", () => {
    const user: ChatMessage = {
      id: "u",
      role: "user",
      content: "steer",
      createdAt: queued.createdAt,
      historySeq: 3,
    };
    const result = applyHistoryEvent([message, user], {
      turnId: "turn",
      seq: 10,
      type: "assistant.message.completed",
      payload: {
        message: {
          ...message,
          content: "Final text",
          state: "completed",
          endEventSeq: 10,
        },
      },
    });
    expect(result.map((entry) => entry.id)).toEqual(["a", "u"]);
    expect(result[0]?.content).toBe("Final text");
    expect(
      applyHistoryEvent([], {
        turnId: "turn",
        seq: 10,
        type: "assistant.message.completed",
        payload: { message: result[0] },
      }),
    ).toHaveLength(1);
  });

  it("does not resurrect queued input when the response arrives after acceptance", () => {
    const accepted = applyInputEvent([queued], {
      turnId: "turn",
      seq: 8,
      type: "user.message.accepted",
      payload: { clientRequestId: "request" },
    });
    expect(mergeQueuedInput(accepted, queued)[0]?.status).toBe("accepted");
    expect(
      mergeQueuedInput(accepted, { ...queued, status: "unconfirmed" })[0]
        ?.status,
    ).toBe("accepted");
  });

  it("uses a half-open timeline interval without affecting the enclosing turn", () => {
    const completed = { ...message, endEventSeq: 10 };
    expect(eventInMessageRange(completed, 2)).toBe(false);
    expect(eventInMessageRange(completed, 3)).toBe(true);
    expect(eventInMessageRange(completed, 10)).toBe(true);
    expect(eventInMessageRange(completed, 11)).toBe(false);
    expect(eventInMessageRange(null, 11)).toBe(true);
  });
});
