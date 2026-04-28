import { Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { Prisma, TurnApproval } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueSignalService } from '../queue-signal/queue-signal.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';

const APPROVAL_PUBLISHED_STATUS = 'pending';
const APPROVAL_QUEUED_STATUS = 'queued';
const APPROVAL_TERMINAL_STATUSES = new Set(['approved', 'rejected']);

type EnqueueInput = {
  turnId: string;
  requestId: string;
  kind: string;
  payload: Prisma.InputJsonValue;
};

/**
 * Owns serial publishing and auto-approve timers for tool approval requests.
 *
 * Approvals enter the queue with status='queued' and are bumped to 'pending'
 * one-at-a-time per turn so the UI is never asked to handle multiple at once.
 * When the active turn's effectiveRuntimeConfig.autoApprove is true, a Node
 * timer is armed at publish-time; on expiry the queue forwards an `accept`
 * decision to the runner, which kicks off the normal `turn.approval.resolved`
 * ingest path. Pause/resume freezes/re-arms the timer; restart-safe via the
 * `autoApproveAt` / `pausedAt` columns on TurnApproval.
 */
@Injectable()
export class ApprovalQueueService implements OnModuleInit {
  private readonly logger = new Logger(ApprovalQueueService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QueueSignalService) private readonly queueSignalService: QueueSignalService,
    @Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.recoverTimers();
  }

  /** Insert (or refresh) an approval row in the queue and try to publish next. */
  async enqueueApprovalRequest(input: EnqueueInput): Promise<void> {
    await this.prisma.turnApproval.upsert({
      where: {
        turnId_requestId: {
          turnId: input.turnId,
          requestId: input.requestId,
        },
      },
      update: {
        kind: input.kind,
        status: APPROVAL_QUEUED_STATUS,
        decision: null,
        resolvedAt: null,
        publishedAt: null,
        autoApproveAt: null,
        pausedAt: null,
        pausedRemainingMs: null,
        payload: input.payload,
      },
      create: {
        turnId: input.turnId,
        requestId: input.requestId,
        kind: input.kind,
        status: APPROVAL_QUEUED_STATUS,
        payload: input.payload,
      },
    });

    await this.tryPublishNext(input.turnId);
  }

  /**
   * Promote the oldest queued approval for a turn to 'pending' (visible to
   * the user). No-op if a pending approval already exists for the turn.
   * Called after `enqueueApprovalRequest` and after every resolution.
   */
  async tryPublishNext(turnId: string): Promise<void> {
    const pendingCount = await this.prisma.turnApproval.count({
      where: { turnId, status: APPROVAL_PUBLISHED_STATUS },
    });
    if (pendingCount > 0) {
      return;
    }

    const next = await this.prisma.turnApproval.findFirst({
      where: { turnId, status: APPROVAL_QUEUED_STATUS },
      orderBy: { createdAt: 'asc' },
    });
    if (!next) {
      return;
    }

    await this.publish(next);
  }

  /** Cancel any auto-approve timer for this approval (manual resolve path). */
  cancelLocalTimer(turnId: string, requestId: string): void {
    const key = this.timerKey(turnId, requestId);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  async pauseTimer(turnId: string, requestId: string): Promise<TurnApproval> {
    const approval = await this.requirePendingApproval(turnId, requestId);
    if (approval.pausedAt) {
      throw new NotFoundException({ message: 'Approval timer is already paused' });
    }
    if (!approval.autoApproveAt) {
      throw new NotFoundException({ message: 'Approval has no auto-approve timer to pause' });
    }

    const now = new Date();
    const remainingMs = Math.max(0, approval.autoApproveAt.getTime() - now.getTime());

    this.cancelLocalTimer(turnId, requestId);

    const updated = await this.prisma.turnApproval.update({
      where: { id: approval.id },
      data: {
        autoApproveAt: null,
        pausedAt: now,
        pausedRemainingMs: remainingMs,
      },
    });

    await this.appendEvent(turnId, 'turn.approval.timer_paused', {
      requestId,
      pausedAt: now.toISOString(),
      pausedRemainingMs: remainingMs,
    });

    return updated;
  }

  async resumeTimer(turnId: string, requestId: string): Promise<TurnApproval> {
    const approval = await this.requirePendingApproval(turnId, requestId);
    if (!approval.pausedAt) {
      throw new NotFoundException({ message: 'Approval timer is not paused' });
    }
    const remainingMs = approval.pausedRemainingMs ?? 0;
    const now = new Date();
    const autoApproveAt = new Date(now.getTime() + remainingMs);

    const updated = await this.prisma.turnApproval.update({
      where: { id: approval.id },
      data: {
        autoApproveAt,
        pausedAt: null,
        pausedRemainingMs: null,
      },
    });

    this.armTimer(turnId, requestId, remainingMs);

    await this.appendEvent(turnId, 'turn.approval.timer_resumed', {
      requestId,
      autoApproveAt: autoApproveAt.toISOString(),
    });

    return updated;
  }

  // -- internal helpers ------------------------------------------------------

  private async publish(approval: TurnApproval): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: approval.turnId },
      select: {
        id: true,
        status: true,
        effectiveRuntimeConfig: true,
        triggerIdentifier: true,
        triggerProvider: true,
        triggerIntegrationId: true,
        triggerMessageId: true,
        sessionId: true,
        session: { select: { projectId: true } },
      },
    });
    if (!turn) {
      this.logger.warn(`Cannot publish approval: turn ${approval.turnId} disappeared`);
      return;
    }
    if (APPROVAL_TERMINAL_STATUSES.has(turn.status) || turn.status === 'cancelled' || turn.status === 'failed' || turn.status === 'completed') {
      // Turn already done — drop the queued approval silently.
      await this.prisma.turnApproval.update({
        where: { id: approval.id },
        data: { status: 'rejected', decision: 'cancel', resolvedAt: new Date() },
      });
      return;
    }

    const config = readAutoApproveConfig(turn.effectiveRuntimeConfig);
    const now = new Date();
    const autoApproveAt =
      config.autoApprove && config.timeoutSeconds > 0
        ? new Date(now.getTime() + config.timeoutSeconds * 1000)
        : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.turnApproval.update({
        where: { id: approval.id },
        data: {
          status: APPROVAL_PUBLISHED_STATUS,
          publishedAt: now,
          autoApproveAt,
          pausedAt: null,
          pausedRemainingMs: null,
        },
      });
      if (turn.status !== 'waiting_approval') {
        await tx.turn.update({
          where: { id: turn.id },
          data: {
            status: 'waiting_approval',
            startedAt: turn.status === 'queued' ? now : undefined,
          },
        });
      }

      if (turn.triggerIdentifier !== 'web') {
        await tx.botMessage.create({
          data: {
            projectId: turn.session.projectId,
            sessionId: turn.sessionId,
            kind: 'approval_request',
            payloadRaw: {
              turnId: turn.id,
              approvalId: approval.requestId,
              kind: approval.kind,
              payload: approval.payload as Prisma.InputJsonValue,
              triggerIdentifier: turn.triggerIdentifier,
              triggerProvider: turn.triggerProvider,
              triggerIntegrationId: turn.triggerIntegrationId,
              triggerMessageId: turn.triggerMessageId,
            },
            status: 'queued',
          },
        });
      }
    });

    const enrichedPayload = enrichApprovalPayload(approval.payload, autoApproveAt, null, null);
    await this.appendEvent(turn.id, 'turn.approval.requested', enrichedPayload);

    if (config.autoApprove) {
      if (config.timeoutSeconds <= 0) {
        // Fire as soon as the current event-loop tick drains so the UI never
        // sees a 0-second countdown.
        process.nextTick(() => {
          void this.fireAutoApprove(approval.turnId, approval.requestId);
        });
      } else if (autoApproveAt) {
        const remainingMs = Math.max(0, autoApproveAt.getTime() - Date.now());
        this.armTimer(approval.turnId, approval.requestId, remainingMs);
      }
    }
  }

  private armTimer(turnId: string, requestId: string, remainingMs: number): void {
    this.cancelLocalTimer(turnId, requestId);
    const key = this.timerKey(turnId, requestId);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.fireAutoApprove(turnId, requestId);
    }, Math.max(0, remainingMs));
    this.timers.set(key, timer);
  }

  private async fireAutoApprove(turnId: string, requestId: string): Promise<void> {
    try {
      const approval = await this.prisma.turnApproval.findFirst({
        where: { turnId, requestId },
        select: { id: true, status: true, pausedAt: true },
      });
      if (!approval) {
        return;
      }
      if (approval.status !== APPROVAL_PUBLISHED_STATUS) {
        return; // already resolved or paused
      }
      if (approval.pausedAt) {
        return; // race: paused after the timer entered the queue
      }

      await this.runnerAdapter.resolveTurnApproval({
        turnId,
        requestId,
        decision: 'accept',
      });
      // The runner will emit `turn.approval.resolved`, which the existing
      // `ingestRunnerEvent` path persists and which then triggers
      // `tryPublishNext` for the next queued approval.
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown auto-approve failure';
      this.logger.error(`Auto-approve failed for turn=${turnId} request=${requestId}: ${message}`);
    }
  }

  private async requirePendingApproval(turnId: string, requestId: string): Promise<TurnApproval> {
    const approval = await this.prisma.turnApproval.findFirst({
      where: { turnId, requestId, status: APPROVAL_PUBLISHED_STATUS },
    });
    if (!approval) {
      throw new NotFoundException({ message: 'Pending approval not found' });
    }
    return approval;
  }

  private async appendEvent(turnId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const latest = await this.prisma.event.findFirst({
      where: { turnId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const event = await this.prisma.event.create({
      data: {
        turnId,
        seq: (latest?.seq ?? 0) + 1,
        type,
        payload: payload as Prisma.InputJsonValue,
      },
    });

    const turn = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: {
        sessionId: true,
        triggerIdentifier: true,
        triggerProvider: true,
        triggerIntegrationId: true,
        triggerMessageId: true,
        session: { select: { projectId: true } },
      },
    });
    if (!turn) {
      return;
    }

    await this.prisma.botMessage.create({
      data: {
        projectId: turn.session.projectId,
        sessionId: turn.sessionId,
        kind: 'event',
        payloadRaw: {
          turnId,
          seq: event.seq,
          type,
          payload: payload as Prisma.InputJsonValue,
          createdAt: event.createdAt.toISOString(),
          triggerIdentifier: turn.triggerIdentifier,
          triggerProvider: turn.triggerProvider,
          triggerIntegrationId: turn.triggerIntegrationId,
          triggerMessageId: turn.triggerMessageId,
        },
        status: 'queued',
      },
    });
    await this.queueSignalService.publishOutboundWake();
  }

  private async recoverTimers(): Promise<void> {
    const pending = await this.prisma.turnApproval.findMany({
      where: {
        status: APPROVAL_PUBLISHED_STATUS,
        autoApproveAt: { not: null },
        pausedAt: null,
      },
      select: { turnId: true, requestId: true, autoApproveAt: true },
    });
    for (const row of pending) {
      if (!row.autoApproveAt) continue;
      const remaining = row.autoApproveAt.getTime() - Date.now();
      if (remaining <= 0) {
        // Past deadline — fire immediately once the event loop is ready.
        process.nextTick(() => {
          void this.fireAutoApprove(row.turnId, row.requestId);
        });
      } else {
        this.armTimer(row.turnId, row.requestId, remaining);
      }
    }
    if (pending.length > 0) {
      this.logger.log(`Recovered ${pending.length} pending auto-approve timer(s) on startup`);
    }
  }

  private timerKey(turnId: string, requestId: string): string {
    return `${turnId}:${requestId}`;
  }
}

function readAutoApproveConfig(effectiveRuntimeConfig: Prisma.JsonValue | null): {
  autoApprove: boolean;
  timeoutSeconds: number;
} {
  if (!effectiveRuntimeConfig || typeof effectiveRuntimeConfig !== 'object' || Array.isArray(effectiveRuntimeConfig)) {
    return { autoApprove: false, timeoutSeconds: 10 };
  }
  const record = effectiveRuntimeConfig as Record<string, unknown>;
  const autoApprove = typeof record.autoApprove === 'boolean' ? record.autoApprove : false;
  const timeoutRaw = record.autoApproveTimeoutSeconds;
  const timeoutSeconds =
    typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw >= 0
      ? Math.floor(timeoutRaw)
      : 10;
  return { autoApprove, timeoutSeconds };
}

function enrichApprovalPayload(
  payload: Prisma.JsonValue,
  autoApproveAt: Date | null,
  pausedAt: Date | null,
  pausedRemainingMs: number | null,
): Record<string, unknown> {
  const base =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return {
    ...base,
    autoApproveAt: autoApproveAt ? autoApproveAt.toISOString() : null,
    pausedAt: pausedAt ? pausedAt.toISOString() : null,
    pausedRemainingMs,
  };
}
