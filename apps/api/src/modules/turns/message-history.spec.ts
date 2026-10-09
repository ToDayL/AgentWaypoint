import "reflect-metadata";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  restoreEnv,
  setupSqliteTestDatabase,
  type SqliteTestDatabase,
} from "../../test-utils/sqlite-test-database";
import type { PrismaService } from "../prisma/prisma.service";
import type { RunnerAdapter } from "../runner/runner.types";
import type { SettingsService } from "../settings/settings.service";
import type { QueueSignalService } from "../queue-signal/queue-signal.service";
import type { ApprovalQueueService } from "./approval-queue.service";
import type { ProjectsService } from "../projects/projects.service";
import { SessionsService } from "../sessions/sessions.service";
import { TurnsService } from "./turns.service";
import { createHistoryMessage } from "./message-history";

describe("durable message history", () => {
  let database: SqliteTestDatabase;
  let prisma: PrismaClient;
  const previousEnv = Object.fromEntries(
    ["AGENTWAYPOINT_HOME", "DATABASE_URL", "DEFAULT_WORKSPACE_ROOT"].map(
      (key) => [key, process.env[key]],
    ),
  );

  beforeAll(async () => {
    database = await setupSqliteTestDatabase("agentwaypoint-message-history-");
    prisma = new PrismaClient();
  }, 30_000);
  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.cleanup();
    for (const [key, value] of Object.entries(previousEnv))
      restoreEnv(key, value);
  });

  async function fixture() {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });
    const project = await prisma.project.create({
      data: { ownerUserId: user.id, name: "test" },
    });
    const session = await prisma.session.create({
      data: { projectId: project.id, title: "test", status: "active" },
    });
    const message = await prisma.$transaction((tx) =>
      createHistoryMessage(tx, {
        data: { sessionId: session.id, role: "user", content: "initial input" },
      }),
    );
    const turn = await prisma.turn.create({
      data: {
        sessionId: session.id,
        userMessageId: message.id,
        status: "running",
        historyVersion: 2,
        backend: "codex",
      },
    });
    await prisma.message.update({
      where: { id: message.id },
      data: { turnId: turn.id },
    });
    const steer = vi
      .fn<RunnerAdapter["steerTurn"]>()
      .mockResolvedValue(undefined);
    const runner = { steerTurn: steer } as unknown as RunnerAdapter;
    const service = new TurnsService(
      prisma as PrismaService,
      runner,
      {
        getAppSettings: async () => ({ turnSteerEnabled: true }),
      } as unknown as SettingsService,
      {
        publishOutboundWake: async () => undefined,
      } as unknown as QueueSignalService,
      {} as ApprovalQueueService,
    );
    const sessions = new SessionsService(
      prisma as PrismaService,
      {} as ProjectsService,
      runner,
    );
    const emit = (
      type: Parameters<TurnsService["ingestRunnerEvent"]>[1],
      payload: Record<string, unknown>,
    ) => service.ingestRunnerEvent(turn.id, type, payload);
    const history = () => sessions.getHistoryForSession(user.id, session.id);
    return {
      user,
      session,
      turn,
      message,
      steer,
      service,
      sessions,
      emit,
      history,
    };
  }

  it('compacts timeline snapshots while retaining full durable history and terminal recovery', async () => {
    const f = await fixture();
    await f.emit('assistant.message.started', { itemId: 'answer', phase: 'final_answer', runnerSeq: 1 });
    await f.emit('assistant.delta', { itemId: 'answer', text: 'Draft', runnerSeq: 2 });
    await f.emit('assistant.message.completed', { itemId: 'answer', text: 'Final answer', phase: 'final_answer', runnerSeq: 3 });
    await f.emit('assistant.message.started', { itemId: 'interrupted', runnerSeq: 4 });
    await f.emit('assistant.delta', { itemId: 'interrupted', text: 'Partial answer', runnerSeq: 5 });
    await f.emit('turn.failed', { message: 'Disconnected', runnerSeq: 6 });

    const events = await f.service.getEventsForTurn(f.user.id, f.turn.id, 0);
    const completed = events.find((event) => event.type === 'assistant.message.completed')!;
    const payload = completed.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('text');
    expect(payload.message).toMatchObject({ content: 'Final answer', state: 'completed', endEventSeq: completed.seq });
    for (const key of ['sessionId', 'turnId', 'backendItemId', 'tokenCount']) {
      expect(payload.message).not.toHaveProperty(key);
    }
    const terminal = events.find((event) => event.type === 'turn.failed')!;
    expect(terminal.payload).toMatchObject({
      message: 'Disconnected', messages: [{ backendItemId: 'interrupted', content: 'Partial answer', state: 'interrupted' }],
    });
    const durable = await prisma.event.findUniqueOrThrow({ where: { id: completed.id } });
    expect(durable.payload).toMatchObject({
      text: 'Final answer', message: { sessionId: f.session.id, turnId: f.turn.id, backendItemId: 'answer' },
    });
    const history = await f.history();
    expect(history.messages.find((entry) => entry.backendItemId === 'answer')).toMatchObject({
      content: 'Final answer', state: 'completed', turnId: f.turn.id,
    });
    await f.service.onModuleDestroy();
  });

  it('returns bounded turn metadata and retains pending inputs from older turns', async () => {
    const f = await fixture();
    const archivedIds = Array.from({ length: 30 }, () => crypto.randomUUID());
    await prisma.turn.createMany({
      data: archivedIds.map((id, index) => ({
        id,
        sessionId: f.session.id,
        status: 'completed',
        createdAt: new Date(Date.now() - (60 - index) * 1000),
        effectiveBackendConfig: { archivedOnly: 'old configuration'.repeat(500) },
      })),
    });
    await prisma.turnInput.createMany({
      data: ['unconfirmed', 'accepted'].map((status) => ({
        turnId: archivedIds[0]!,
        clientRequestId: status,
        content: status,
        status,
      })),
    });
    await prisma.turn.update({
      where: { id: f.turn.id },
      data: { effectiveBackendConfig: { model: 'current model' }, contextRemainingRatio: 0.75 },
    });
    await f.emit('assistant.message.started', { itemId: 'live' });
    const history = await f.sessions.getHistoryForSession(f.user.id, f.session.id, { limit: 1 });
    expect(history).not.toHaveProperty('turns');
    expect(history.turnCount).toBe(31);
    expect(history.activeTurn).toMatchObject({
      id: f.turn.id,
      historyVersion: 2,
      eventCursor: 1,
      effectiveBackendConfig: { model: 'current model' },
    });
    expect(history.activeTurn).not.toHaveProperty('events');
    expect(history.latestTurn).toMatchObject({ id: f.turn.id, contextRemainingRatio: 0.75 });
    expect(JSON.stringify(history)).not.toContain('archivedOnly');
    expect(history.pendingInputs.map((input) => input.status)).toEqual(['unconfirmed']);
    await f.emit('turn.cancelled', {});
    expect((await f.history()).activeTurn).toBeNull();
    expect((await f.history()).latestTurn?.id).toBe(f.turn.id);
    await f.service.onModuleDestroy();
  });

  it('loads complete history and calibrates only the requested turn, including legacy associations', async () => {
    const f = await fixture();
    const legacy = await prisma.message.create({
      data: { sessionId: f.session.id, role: 'assistant', content: 'Legacy response', historySeq: 2 },
    });
    const oldTurn = await prisma.turn.create({
      data: { sessionId: f.session.id, status: 'completed', assistantMessageId: legacy.id },
    });
    await prisma.message.createMany({
      data: Array.from({ length: 25 }, (_, index) => ({
        sessionId: f.session.id, turnId: oldTurn.id, role: 'assistant',
        content: `Older message ${index}`, historySeq: index + 3,
      })),
    });
    await f.emit('assistant.message.completed', { itemId: 'live', text: 'Current response' });
    await f.emit('turn.completed', {});
    const full = await f.history();
    expect(full.messages).toHaveLength(28);
    expect(full.hasMore).toBe(false);
    const scoped = await f.sessions.getHistoryForSession(f.user.id, f.session.id, { turnId: f.turn.id });
    expect(scoped.messages.map((message) => message.content)).toEqual(['initial input', 'Current response']);
    expect(scoped.messageTurn).toMatchObject({ id: f.turn.id, historyVersion: 2, eventCursor: 2, status: 'completed' });
    expect(scoped.activeTurn).toBeNull();
    expect(scoped).not.toHaveProperty('turns');
    const older = await f.sessions.getHistoryForSession(f.user.id, f.session.id, { turnId: oldTurn.id });
    expect(older.messages).toHaveLength(26);
    expect(older.messages[0]).toMatchObject({ id: legacy.id, turnId: oldTurn.id });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: legacy.id } })).turnId).toBeNull();
    await expect(f.sessions.getHistoryForSession('another user', f.session.id, { turnId: f.turn.id })).rejects.toThrow('Turn not found');
    const other = await fixture();
    await expect(f.sessions.getHistoryForSession(f.user.id, f.session.id, { turnId: other.turn.id })).rejects.toThrow('Turn not found');
    await f.service.onModuleDestroy();
    await other.service.onModuleDestroy();
  });

  it('resolves legacy message associations on older pages and leaves copied history unlinked', async () => {
    const f = await fixture();
    const legacyMessage = await prisma.$transaction((tx) =>
      createHistoryMessage(tx, {
        data: { sessionId: f.session.id, role: 'assistant', content: 'legacy response' },
      }),
    );
    const archivedTurn = await prisma.turn.create({
      data: {
        sessionId: f.session.id,
        status: 'completed',
        assistantMessageId: legacyMessage.id,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.$transaction((tx) =>
      createHistoryMessage(tx, {
        data: { sessionId: f.session.id, role: 'assistant', content: 'copied response' },
      }),
    );
    const page = await f.sessions.getHistoryForSession(f.user.id, f.session.id, { limit: 1 });
    expect(page.messages[0]).toMatchObject({ content: 'copied response', turnId: null });
    const older = await f.sessions.getHistoryForSession(f.user.id, f.session.id, {
      limit: 1,
      before: page.nextBefore!,
    });
    expect(older.messages[0]).toMatchObject({ id: legacyMessage.id, turnId: archivedTurn.id });
    expect(older.latestTurn?.id).toBe(f.turn.id);
    expect(older.activeTurn?.id).toBe(f.turn.id);
    expect(older).not.toHaveProperty('turns');
    await expect(f.sessions.getHistoryForSession('another user', f.session.id)).rejects.toThrow(
      'Session not found',
    );
    await f.service.onModuleDestroy();
  });

  it.each(['turn.completed', 'turn.cancelled', 'turn.failed'] as const)(
    'stores turnId when writing a legacy assistant message on %s',
    async (terminal) => {
      const f = await fixture();
      await prisma.turn.update({ where: { id: f.turn.id }, data: { historyVersion: 1 } });
      await f.emit('assistant.delta', { text: 'legacy output' });
      await f.emit(terminal, { content: 'legacy output', code: 'STOP', message: 'Stopped' });
      expect(
        await prisma.message.findFirst({ where: { sessionId: f.session.id, role: 'assistant' } }),
      ).toMatchObject({ content: 'legacy output', turnId: f.turn.id });
      await f.service.onModuleDestroy();
    },
  );

  it("commits each completed item before turn end and replaces deltas with authoritative text", async () => {
    const f = await fixture();
    await f.emit("assistant.message.started", {
      itemId: "a",
      phase: "commentary",
    });
    await f.emit("assistant.delta", { itemId: "a", text: "streamed draft" });
    await f.emit("assistant.message.completed", {
      itemId: "a",
      text: "First complete message",
      phase: "commentary",
    });
    let history = await f.history();
    expect(history.activeTurnId).toBe(f.turn.id);
    expect(history.messages.map((m) => m.content)).toEqual([
      "initial input",
      "First complete message",
    ]);
    expect(
      await prisma.botMessage.count({
        where: { sessionId: f.session.id, kind: "turn_message" },
      }),
    ).toBe(1);
    const endA = history.messages[1]?.endEventSeq;
    // A complete item can arrive without either start or deltas.
    await f.emit("assistant.message.completed", {
      itemId: "b",
      text: "Second message",
      phase: "final_answer",
    });
    await f.emit("assistant.message.completed", {
      itemId: "b",
      text: "Second message",
      phase: "final_answer",
    });
    await f.emit("assistant.delta", { itemId: "b", text: "late duplicate" });
    await f.emit("turn.completed", {
      content: "obsolete whole turn concatenation",
    });
    history = await f.history();
    expect(history.messages.map((m) => m.content)).toEqual([
      "initial input",
      "First complete message",
      "Second message",
    ]);
    expect(history.messages[2]?.timelineStartSeq).toBe(endA);
    expect(history.activeTurnId).toBeNull();
    expect(
      await prisma.botMessage.count({
        where: { sessionId: f.session.id, kind: "turn_message" },
      }),
    ).toBe(2);
    await f.service.onModuleDestroy();
  });

  it("keeps identical steer requests queued until their own receipt and orders history by receipt", async () => {
    const f = await fixture();
    const first = await f.service.steerTurnForUser(f.user.id, f.turn.id, {
      content: "same text",
      clientRequestId: "one",
    });
    await f.service.steerTurnForUser(f.user.id, f.turn.id, {
      content: "same text",
      clientRequestId: "one",
    });
    await f.service.steerTurnForUser(f.user.id, f.turn.id, {
      content: "same text",
      clientRequestId: "two",
    });
    await vi.waitFor(() => expect(f.steer).toHaveBeenCalledTimes(2));
    expect(first).toHaveProperty("input.status", "queued");
    expect((await f.history()).messages).toHaveLength(1);
    expect((await f.history()).pendingInputs).toHaveLength(2);
    await f.emit("assistant.message.completed", {
      itemId: "a",
      text: "Before receipt",
    });
    await f.emit("user.message.accepted", {
      itemId: "input-two",
      clientId: "two",
      content: "same text",
    });
    await f.emit("assistant.message.completed", {
      itemId: "b",
      text: "Between receipts",
    });
    await f.emit("user.message.accepted", {
      itemId: "input-one",
      clientId: "one",
      content: "same text",
    });
    await f.emit("user.message.accepted", {
      itemId: "input-one",
      clientId: "one",
      content: "same text",
    });
    // The initial echoed input must not add a second initial message.
    await f.emit("user.message.accepted", {
      itemId: "initial",
      initial: true,
      content: "initial input",
    });
    const history = await f.history();
    expect(history.messages.map((m) => m.content)).toEqual([
      "initial input",
      "Before receipt",
      "same text",
      "Between receipts",
      "same text",
    ]);
    expect(history.messages[2]?.backendItemId).toBe("input-two");
    expect(history.pendingInputs).toEqual([]);
    expect(history.messages.every((m) => m.turnId === f.turn.id)).toBe(true);
    await f.emit("turn.completed", {});
    const replay = await f.service.steerTurnForUser(f.user.id, f.turn.id, {
      content: "same text",
      clientRequestId: "one",
    });
    expect(replay).toHaveProperty("input.status", "accepted");
    expect(f.steer).toHaveBeenCalledTimes(2);
    await f.service.onModuleDestroy();
  });

  it("keeps acceptance when a late RPC failure arrives, and preserves partial output on cancellation", async () => {
    const f = await fixture();
    let reject!: (error: Error) => void;
    f.steer.mockImplementation(
      () =>
        new Promise<void>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    await f.service.steerTurnForUser(f.user.id, f.turn.id, {
      content: "steer",
      clientRequestId: "request",
    });
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
    await f.emit("assistant.delta", {
      itemId: "partial",
      text: "Partial output",
    });
    await f.emit("user.message.accepted", {
      itemId: "input",
      clientId: "request",
      content: "steer",
    });
    reject(new Error("RPC timed out"));
    await vi.waitFor(async () =>
      expect(
        await prisma.turnInput.findFirst({ where: { turnId: f.turn.id } }),
      ).toHaveProperty("status", "accepted"),
    );
    await f.emit("turn.cancelled", {});
    const history = await f.history();
    expect(history.messages.map((m) => m.content)).toEqual([
      "initial input",
      "Partial output",
      "steer",
    ]);
    expect(history.messages[1]?.state).toBe("interrupted");
    expect(history.pendingInputs).toHaveLength(0);
    await f.service.onModuleDestroy();
  });

  it("flushes boundaries in source order and persists the upstream cursor independently from API events", async () => {
    const f = await fixture();
    await f.emit("assistant.message.started", { itemId: "a", runnerSeq: 10 });
    await f.emit("assistant.delta", { itemId: "a", text: "A", runnerSeq: 11 });
    await f.emit("assistant.delta", { itemId: "a", text: "B", runnerSeq: 12 });
    await f.emit("user.message.accepted", {
      itemId: "u",
      content: "interrupt",
      runnerSeq: 13,
    });
    const events = await prisma.event.findMany({
      where: { turnId: f.turn.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map((e) => e.type)).toEqual([
      "assistant.message.started",
      "assistant.delta",
      "user.message.accepted",
    ]);
    expect(events[1]?.payload).toMatchObject({ text: "AB", runnerSeq: 12 });
    expect(
      await prisma.turn.findUnique({ where: { id: f.turn.id } }),
    ).toHaveProperty("runnerCursor", 13);
    await f.emit("assistant.delta", { itemId: "a", text: "B", runnerSeq: 12 });
    await f.emit("assistant.message.completed", {
      itemId: "a",
      text: "AB",
      runnerSeq: 14,
    });
    expect((await f.history()).messages[1]?.content).toBe("AB");
    const page = await f.sessions.getHistoryForSession(
      f.user.id,
      f.session.id,
      { limit: 2 },
    );
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const older = await f.sessions.getHistoryForSession(
      f.user.id,
      f.session.id,
      { limit: 2, before: page.nextBefore! },
    );
    expect(older.messages.map((m) => m.content)).toEqual(["initial input"]);
    expect(
      (await f.service.getEventsForTurn(f.user.id, f.turn.id, 1, 20, 2)).map(
        (e) => e.seq,
      ),
    ).toEqual([2]);
    await f.emit("turn.completed", { runnerSeq: 15 });
    await f.service.onModuleDestroy();
  });

  it("does not put rejected or unconfirmed input in formal history", async () => {
    const f = await fixture();
    f.steer.mockRejectedValueOnce(
      new Error("Turn is not ready for steering yet"),
    );
    await f.service.steerTurnForUser(f.user.id, f.turn.id, {
      content: "rejected",
      clientRequestId: "rejected",
    });
    await vi.waitFor(async () =>
      expect(
        await prisma.turnInput.findFirst({ where: { turnId: f.turn.id } }),
      ).toHaveProperty("status", "failed"),
    );
    await f.service.steerTurnForUser(f.user.id, f.turn.id, {
      content: "not received",
      clientRequestId: "pending",
    });
    await vi.waitFor(() => expect(f.steer).toHaveBeenCalledTimes(2));
    await f.emit("turn.failed", { code: "STOPPED", message: "Process exited" });
    const history = await f.history();
    expect(history.messages.map((m) => m.content)).toEqual(["initial input"]);
    expect(history.pendingInputs.map((input) => input.status)).toEqual([
      "failed",
      "unconfirmed",
    ]);
    await f.service.onModuleDestroy();
  });
});
