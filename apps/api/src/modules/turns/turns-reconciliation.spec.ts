import { ConflictException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { RunnerAdapter } from '../runner/runner.types';
import type { SettingsService } from '../settings/settings.service';
import type { QueueSignalService } from '../queue-signal/queue-signal.service';
import type { ApprovalQueueService } from './approval-queue.service';
import { TurnsService, type RunnerEventType } from './turns.service';

type TestableTurnsService = {
  ensureRunnerEventConsumer(turnId: string): void;
  getTurnForUser(userId: string, turnId: string): Promise<{ status: string; sessionId: string }>;
  ingestRunnerEvent(turnId: string, type: RunnerEventType, payload: Record<string, unknown>): Promise<void>;
  failTurn(
    turnId: string,
    previousStatus: string,
    failureCode: string,
    failureMessage: string,
    eventPayload: unknown,
  ): Promise<void>;
};

function createService(options?: {
  consumeTurnEvents?: RunnerAdapter['consumeTurnEvents'];
  cancelTurn?: RunnerAdapter['cancelTurn'];
  steerTurn?: RunnerAdapter['steerTurn'];
}) {
  const prisma = {
    turn: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'turn-1',
        sessionId: 'session-1',
        status: 'running',
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    event: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    message: {
      create: vi.fn().mockResolvedValue({ id: 'message-1' }),
    },
  };
  const runner = {
    consumeTurnEvents:
      options?.consumeTurnEvents ??
      vi.fn(async () => {
        await new Promise<void>(() => undefined);
      }),
    cancelTurn: options?.cancelTurn ?? vi.fn().mockResolvedValue(true),
    steerTurn: options?.steerTurn ?? vi.fn().mockResolvedValue(undefined),
  };
  const service = new TurnsService(
    prisma as unknown as PrismaService,
    runner as unknown as RunnerAdapter,
    {
      getAppSettings: vi.fn().mockResolvedValue({ turnSteerEnabled: true }),
    } as unknown as SettingsService,
    {} as QueueSignalService,
    {} as ApprovalQueueService,
  );
  return {
    prisma,
    runner,
    service,
    internals: service as unknown as TestableTurnsService,
  };
}

describe('turn reconciliation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('restarts event consumption after a transient database timeout', async () => {
    vi.useFakeTimers();
    const consumeTurnEvents = vi
      .fn<RunnerAdapter['consumeTurnEvents']>()
      .mockRejectedValueOnce(new Error('Socket timeout (the database failed to respond)'))
      .mockImplementation(async () => {
        await new Promise<void>(() => undefined);
      });
    const { internals } = createService({ consumeTurnEvents });

    internals.ensureRunnerEventConsumer('turn-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(consumeTurnEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(consumeTurnEvents).toHaveBeenCalledTimes(2);
    expect(consumeTurnEvents.mock.calls[1]?.[0]).toEqual({
      turnId: 'turn-1',
      sinceSeq: 0,
    });
  });

  it('closes a stale database turn when runner cancellation finds nothing', async () => {
    const cancelTurn = vi.fn().mockResolvedValue(false);
    const { internals, prisma, service } = createService({ cancelTurn });
    vi.spyOn(internals, 'getTurnForUser').mockResolvedValue({
      status: 'running',
      sessionId: 'session-1',
    });
    const ingest = vi.spyOn(internals, 'ingestRunnerEvent').mockResolvedValue(undefined);
    prisma.turn.findUnique.mockResolvedValue({
      id: 'turn-1',
      status: 'cancelled',
    });

    await expect(service.cancelTurnForUser('user-1', 'turn-1')).resolves.toEqual({
      id: 'turn-1',
      status: 'cancelled',
    });
    expect(ingest).toHaveBeenCalledWith(
      'turn-1',
      'turn.cancelled',
      expect.objectContaining({ code: 'ORPHANED_TURN_CANCELLED' }),
    );
  });

  it('marks an in-flight database turn failed when reconciliation cannot find it in the runner', async () => {
    const consumeTurnEvents = vi.fn().mockRejectedValue(new Error('Turn not found: turn-1'));
    const { internals } = createService({ consumeTurnEvents });
    const failTurn = vi.spyOn(internals, 'failTurn').mockResolvedValue(undefined);

    internals.ensureRunnerEventConsumer('turn-1');

    await vi.waitFor(() => {
      expect(failTurn).toHaveBeenCalledWith(
        'turn-1',
        'running',
        'ORPHANED_TURN',
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  it('repairs a stale running turn when steering finds no active runner turn', async () => {
    const steerTurn = vi.fn().mockRejectedValue(new Error('Active turn not found'));
    const { internals, service } = createService({ steerTurn });
    vi.spyOn(internals, 'getTurnForUser').mockResolvedValue({
      status: 'running',
      sessionId: 'session-1',
    });
    const failTurn = vi.spyOn(internals, 'failTurn').mockResolvedValue(undefined);

    await expect(service.steerTurnForUser('user-1', 'turn-1', { content: 'status?' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(failTurn).toHaveBeenCalledWith('turn-1', 'running', 'ORPHANED_TURN', expect.any(String), expect.any(Object));
  });
});
