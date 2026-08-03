import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_ADAPTER, RunnerAdapter, RunnerStreamEvent } from '../runner/runner.types';
import { SettingsService } from '../settings/settings.service';
import { CreateTurnBody, ResolveTurnApprovalBody, SteerTurnBody } from './turns.schemas';
import { QueueSignalService } from '../queue-signal/queue-signal.service';
import { ApprovalQueueService } from './approval-queue.service';

const ACTIVE_TURN_STATUSES = ['queued', 'running', 'waiting_approval'];
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const STEERABLE_TURN_STATUSES = ['queued', 'running'];

export type RunnerEventType =
  | 'turn.started'
  | 'assistant.delta'
  | 'turn.approval.requested'
  | 'turn.approval.resolved'
  | 'turn.approval.timer_paused'
  | 'turn.approval.timer_resumed'
  | 'turn.approval.auto_review'
  | 'thread.token_usage.updated'
  | 'plan.updated'
  | 'reasoning.delta'
  | 'diff.updated'
  | 'tool.started'
  | 'tool.output'
  | 'tool.completed'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled';

type PendingApprovalSummary = {
  id: string;
  kind: string;
  status: string;
  decision: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  payload: Record<string, unknown>;
};

type InternalCreateTurnInput = {
  content: string;
  triggerIdentifier?: string;
  triggerProvider?: string;
  triggerIntegrationId?: string;
  triggerMessageId?: string | null;
};

type GatewayCreateTurnInput = {
  content: string;
  triggerIdentifier: string;
  triggerProvider?: string;
  triggerIntegrationId?: string;
  triggerMessageId?: string | null;
};

type PendingCoalescedEvent = {
  turnId: string;
  type: RunnerEventType;
  payload: Prisma.InputJsonValue;
  timer: ReturnType<typeof setTimeout>;
};

const COALESCED_EVENT_FLUSH_MS = 250;
const RUNNER_CONSUMER_RETRY_MS = 1_000;
const RUNNER_RECONCILE_INTERVAL_MS = 15_000;
const LAST_WRITE_WINS_EVENT_TYPES = new Set<RunnerEventType>([
  'diff.updated',
  'plan.updated',
  'thread.token_usage.updated',
]);
const TEXT_COALESCED_EVENT_TYPES = new Set<RunnerEventType>(['assistant.delta', 'reasoning.delta', 'tool.output']);

@Injectable()
export class TurnsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TurnsService.name);
  private readonly runnerConsumers = new Map<string, Promise<void>>();
  private readonly reasoningOpenTurns = new Set<string>();
  private readonly pendingCoalescedEvents = new Map<string, PendingCoalescedEvent>();
  private readonly activeCoalescedFlushesByTurn = new Map<string, Set<Promise<void>>>();
  private readonly eventWriteQueues = new Map<string, Promise<void>>();
  private readonly runnerEventCursors = new Map<string, number>();
  private readonly runnerConsumerRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private runnerReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private runnerReconcileInProgress = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter,
    @Inject(SettingsService) private readonly settingsService: SettingsService,
    @Inject(QueueSignalService)
    private readonly queueSignalService: QueueSignalService,
    @Inject(ApprovalQueueService)
    private readonly approvalQueue: ApprovalQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reconcileInFlightTurnsOnStartup();
    this.runnerReconcileTimer = setInterval(() => {
      void this.reconcileInFlightTurns().catch((error: unknown) => {
        this.logger.error(
          `Periodic in-flight turn reconciliation failed: ${formatErrorMessage(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      });
    }, RUNNER_RECONCILE_INTERVAL_MS);
    this.runnerReconcileTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.runnerReconcileTimer) {
      clearInterval(this.runnerReconcileTimer);
      this.runnerReconcileTimer = null;
    }
    for (const timer of this.runnerConsumerRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.runnerConsumerRetryTimers.clear();
    await this.flushAllPendingCoalescedEvents();
    await Promise.allSettled(this.eventWriteQueues.values());
  }

  async createTurnForSession(userId: string, sessionId: string, input: CreateTurnBody) {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        project: {
          ownerUserId: userId,
        },
      },
      select: {
        id: true,
        meta: true,
        backendThreadId: true,
      },
    });
    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }

    return this.createTurnWithResolvedSession(session, input);
  }

  async createTurnForGateway(sessionId: string, input: GatewayCreateTurnInput) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        meta: true,
        backendThreadId: true,
      },
    });
    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }

    return this.createTurnWithResolvedSession(session, input);
  }

  private async createTurnWithResolvedSession(
    session: {
      id: string;
      meta: Prisma.JsonValue | null;
      backendThreadId: string | null;
    },
    input: InternalCreateTurnInput,
  ) {
    const sessionId = session.id;

    const runtime = readSessionRuntimeFromMeta(session.meta);
    const cwd = runtime.cwd;
    const backend = runtime.backend;
    const backendConfig = runtime.backendConfig;

    const activeTurn = await this.prisma.turn.findFirst({
      where: {
        sessionId,
        status: { in: ACTIVE_TURN_STATUSES },
      },
      select: { id: true },
    });
    if (activeTurn) {
      throw new ConflictException({
        message: 'An active turn already exists for this session',
      });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const userMessage = await tx.message.create({
        data: {
          sessionId,
          role: 'user',
          content: input.content,
        },
      });

      const turn = await tx.turn.create({
        data: {
          sessionId,
          userMessageId: userMessage.id,
          triggerIdentifier: normalizeTriggerIdentifier(input.triggerIdentifier),
          triggerProvider: normalizeTriggerProvider(input.triggerProvider),
          triggerIntegrationId: normalizeTriggerIntegrationId(input.triggerIntegrationId),
          triggerMessageId: normalizeTriggerMessageId(input.triggerMessageId),
          status: 'queued',
          backend,
          requestedBackendConfig: buildRequestedBackendConfig(backendConfig, cwd),
          // Snapshot the session's auto-approve policy at turn-start so the
          // approval queue can read it even before `turn.started` is ingested
          // (and so cron-launched turns can override it without touching the
          // session record).
          effectiveRuntimeConfig: {
            autoApprove: runtime.autoApprove,
            autoApproveTimeoutSeconds: runtime.autoApproveTimeoutSeconds,
          },
        },
      });
      return {
        turn,
        userMessageId: userMessage.id,
      };
    });

    void this.runnerAdapter
      .startTurn({
        turnId: created.turn.id,
        sessionId,
        content: input.content,
        backend,
        backendConfig,
        threadId: session.backendThreadId,
        cwd,
      })
      .then(() => {
        this.ensureRunnerEventConsumer(created.turn.id);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Runner start failed';
        void this.failTurn(
          created.turn.id,
          created.turn.status,
          'RUNNER_DISPATCH_FAILED',
          message,
          this.normalizePayload({ code: 'RUNNER_DISPATCH_FAILED', message }),
        );
        if (error instanceof Error) {
          this.logger.error(`Failed to dispatch turn ${created.turn.id} to runner: ${error.message}`, error.stack);
          return;
        }
        this.logger.error(`Failed to dispatch turn ${created.turn.id} to runner`);
      });

    return {
      turnId: created.turn.id,
      messageId: created.userMessageId,
      status: created.turn.status,
    };
  }

  async cancelTurnForUser(userId: string, turnId: string) {
    const turn = await this.getTurnForUser(userId, turnId);
    if (!ACTIVE_TURN_STATUSES.includes(turn.status)) {
      return this.prisma.turn.findUnique({
        where: { id: turnId },
      });
    }

    let cancelledByRunner = false;
    try {
      cancelledByRunner = await this.runnerAdapter.cancelTurn({ turnId });
    } catch (error: unknown) {
      if (!isRunnerTurnMissingError(error)) {
        throw error;
      }
    }

    if (!cancelledByRunner) {
      await this.ingestRunnerEvent(turnId, 'turn.cancelled', {
        code: 'ORPHANED_TURN_CANCELLED',
        message: 'The runner no longer had this active turn; AgentWaypoint closed the stale turn.',
      });
    }

    return this.prisma.turn.findUnique({
      where: { id: turnId },
    });
  }

  async steerTurnForUser(userId: string, turnId: string, input: SteerTurnBody) {
    const settings = await this.settingsService.getAppSettings(userId);
    if (!settings.turnSteerEnabled) {
      throw new ConflictException({ message: 'Turn steering is disabled' });
    }

    const turn = await this.getTurnForUser(userId, turnId);
    if (!STEERABLE_TURN_STATUSES.includes(turn.status)) {
      throw new ConflictException({
        message: 'Only running or queued turns can be steered',
      });
    }

    await this.prisma.message.create({
      data: {
        sessionId: turn.sessionId,
        role: 'user',
        content: input.content,
      },
    });

    try {
      await this.runnerAdapter.steerTurn({
        turnId,
        content: input.content,
      });
    } catch (error: unknown) {
      if (!isRunnerTurnMissingError(error)) {
        throw error;
      }
      const message = 'The runner no longer has this turn; AgentWaypoint closed the stale running record.';
      await this.failTurn(
        turnId,
        turn.status,
        'ORPHANED_TURN',
        message,
        this.normalizePayload({
          code: 'ORPHANED_TURN',
          message,
        }),
      );
      throw new ConflictException({
        message: 'This turn is no longer active. Its stale running state has been repaired.',
      });
    }

    return this.getTurnStatusForUser(userId, turnId);
  }

  async resolveTurnApprovalForUser(userId: string, turnId: string, input: ResolveTurnApprovalBody) {
    await this.getTurnForUser(userId, turnId);

    const approval = await this.prisma.turnApproval.findFirst({
      where: {
        requestId: input.approvalId,
        turnId,
        status: 'pending',
      },
      select: {
        id: true,
        requestId: true,
      },
    });
    if (!approval) {
      throw new NotFoundException({ message: 'Pending approval not found' });
    }

    await this.runnerAdapter.resolveTurnApproval({
      turnId,
      requestId: approval.requestId,
      decision: normalizeApprovalDecisionInput(input.decision),
    });

    return this.getTurnStatusForUser(userId, turnId);
  }

  async controlApprovalTimerForUser(
    userId: string,
    turnId: string,
    input: { approvalId: string; action: 'pause' | 'resume' },
  ) {
    await this.getTurnForUser(userId, turnId);
    if (input.action === 'pause') {
      await this.approvalQueue.pauseTimer(turnId, input.approvalId);
    } else {
      await this.approvalQueue.resumeTimer(turnId, input.approvalId);
    }
    return this.getTurnStatusForUser(userId, turnId);
  }

  async resolveTurnApprovalForGateway(turnId: string, input: ResolveTurnApprovalBody) {
    const turn = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: { id: true, status: true },
    });
    if (!turn) {
      throw new NotFoundException({ message: 'Turn not found' });
    }

    const approval = await this.prisma.turnApproval.findFirst({
      where: {
        requestId: input.approvalId,
        turnId,
        status: 'pending',
      },
      select: {
        requestId: true,
      },
    });
    if (!approval) {
      throw new NotFoundException({ message: 'Pending approval not found' });
    }

    await this.runnerAdapter.resolveTurnApproval({
      turnId,
      requestId: approval.requestId,
      decision: normalizeApprovalDecisionInput(input.decision),
    });

    const latest = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: { id: true, status: true },
    });
    return {
      turnId,
      status: latest?.status ?? turn.status,
      accepted: true as const,
    };
  }

  async getEventsForTurn(userId: string, turnId: string, sinceSeq: number) {
    await this.getTurnForUser(userId, turnId);
    return this.prisma.event.findMany({
      where: {
        turnId,
        seq: {
          gt: sinceSeq,
        },
      },
      orderBy: { seq: 'asc' },
    });
  }

  async getTurnForUser(userId: string, turnId: string) {
    const turn = await this.prisma.turn.findFirst({
      where: {
        id: turnId,
        session: {
          project: {
            ownerUserId: userId,
          },
        },
      },
    });

    if (!turn) {
      throw new NotFoundException({ message: 'Turn not found' });
    }

    return turn;
  }

  async getTurnStatusForUser(userId: string, turnId: string) {
    const turn = await this.getTurnForUser(userId, turnId);
    const pendingApproval = await this.getPendingApproval(turn.id);
    return {
      id: turn.id,
      sessionId: turn.sessionId,
      backend: turn.backend,
      triggerIdentifier: turn.triggerIdentifier,
      triggerProvider: turn.triggerProvider,
      triggerIntegrationId: turn.triggerIntegrationId,
      triggerMessageId: turn.triggerMessageId,
      status: turn.status,
      failureCode: turn.failureCode,
      failureMessage: turn.failureMessage,
      createdAt: turn.createdAt,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      requestedBackendConfig: normalizeJsonRecord(turn.requestedBackendConfig),
      effectiveBackendConfig: normalizeJsonRecord(turn.effectiveBackendConfig),
      effectiveRuntimeConfig: normalizeJsonRecord(turn.effectiveRuntimeConfig),
      contextRemainingRatio: turn.contextRemainingRatio === null ? null : Number(turn.contextRemainingRatio),
      contextRemainingTokens: turn.contextRemainingTokens,
      contextWindowTokens: turn.contextWindowTokens,
      contextUpdatedAt: turn.contextUpdatedAt,
      pendingApproval,
    };
  }

  async ingestRunnerEvent(turnId: string, type: RunnerEventType, payload: Record<string, unknown>) {
    const turn = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: {
        id: true,
        sessionId: true,
        status: true,
        backend: true,
        requestedBackendConfig: true,
        effectiveRuntimeConfig: true,
        triggerIdentifier: true,
        triggerProvider: true,
        triggerIntegrationId: true,
        triggerMessageId: true,
        session: {
          select: { projectId: true },
        },
      },
    });
    if (!turn) {
      throw new NotFoundException({ message: 'Turn not found' });
    }

    if (type !== 'reasoning.delta' && type !== 'turn.started') {
      await this.closeReasoningBlockIfOpen(turnId);
    }

    switch (type) {
      case 'turn.started': {
        const threadId = payload.threadId;
        if (typeof threadId === 'string' && threadId.length > 0) {
          await this.prisma.session.update({
            where: { id: turn.sessionId },
            data: { backendThreadId: threadId },
          });
        }
        if (turn.status === 'queued') {
          await this.prisma.turn.update({
            where: { id: turnId },
            data: {
              status: 'running',
              startedAt: new Date(),
              effectiveBackendConfig: buildEffectiveBackendConfig(payload, turn),
              effectiveRuntimeConfig: buildEffectiveRuntimeConfig(payload, turn.effectiveRuntimeConfig),
            },
          });
        } else {
          await this.prisma.turn.update({
            where: { id: turnId },
            data: {
              effectiveBackendConfig: buildEffectiveBackendConfig(payload, turn),
              effectiveRuntimeConfig: buildEffectiveRuntimeConfig(payload, turn.effectiveRuntimeConfig),
            },
          });
        }
        await this.appendEvent(turnId, 'turn.started', this.normalizePayload(payload));
        return;
      }
      case 'assistant.delta': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const text = payload.text;
        if (typeof text !== 'string' || text.length === 0) {
          throw new ConflictException({
            message: 'assistant.delta requires payload.text',
          });
        }
        const normalizedPayload = this.normalizePayload({ text });
        if (!this.coalesceEvent(turnId, 'assistant.delta', normalizedPayload)) {
          await this.appendEvent(turnId, 'assistant.delta', normalizedPayload);
        }
        return;
      }
      case 'reasoning.delta': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        if (delta.length === 0) {
          return;
        }
        await this.openReasoningBlockIfNeeded(turnId);
        const reasoningPayload = this.normalizePayload({ delta });
        const assistantPayload = this.normalizePayload({
          text: delta,
          isReasoning: true,
        });
        if (!this.coalesceEvent(turnId, 'reasoning.delta', reasoningPayload)) {
          await this.appendEvent(turnId, 'reasoning.delta', reasoningPayload);
        }
        if (!this.coalesceEvent(turnId, 'assistant.delta', assistantPayload)) {
          await this.appendEvent(turnId, 'assistant.delta', assistantPayload);
        }
        return;
      }
      case 'turn.approval.requested': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
        const kind = typeof payload.kind === 'string' ? payload.kind.trim() : '';
        if (!requestId || !kind) {
          throw new ConflictException({
            message: 'turn.approval.requested requires payload.requestId and payload.kind',
          });
        }

        const normalizedPayload = this.normalizePayload(payload);
        await this.flushPendingCoalescedEventsForTurn(turnId);
        // Hand off to the approval queue, which inserts the row as 'queued',
        // promotes it to 'pending' (and emits the user-visible event) only
        // when no other approval is in flight for this turn, and arms an
        // auto-approve timer if the turn's effectiveRuntimeConfig says so.
        await this.approvalQueue.enqueueApprovalRequest({
          turnId,
          requestId,
          kind,
          payload: normalizedPayload,
        });
        return;
      }
      case 'turn.approval.resolved': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
        const decision = typeof payload.decision === 'string' ? payload.decision.trim() : '';
        if (!requestId || !decision) {
          throw new ConflictException({
            message: 'turn.approval.resolved requires payload.requestId and payload.decision',
          });
        }

        const normalizedPayload = this.normalizePayload(payload);
        await this.flushPendingCoalescedEventsForTurn(turnId);
        await this.prisma.$transaction(async (tx) => {
          await tx.turnApproval.updateMany({
            where: { turnId, requestId, status: 'pending' },
            data: {
              status: isApprovalAccepted(decision) ? 'approved' : 'rejected',
              decision,
              resolvedAt: new Date(),
            },
          });

          if (turn.status === 'waiting_approval') {
            await tx.turn.update({
              where: { id: turnId },
              data: { status: 'running' },
            });
          }
        });

        this.approvalQueue.cancelLocalTimer(turnId, requestId);
        await this.appendEvent(turnId, 'turn.approval.resolved', normalizedPayload);
        // Promote the next queued approval (if any) for this turn.
        await this.approvalQueue.tryPublishNext(turnId);
        return;
      }
      case 'turn.approval.auto_review': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        await this.appendEvent(turnId, 'turn.approval.auto_review', this.normalizePayload(payload));
        return;
      }
      case 'plan.updated':
      case 'diff.updated':
      case 'tool.output': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const normalizedPayload = this.normalizePayload(payload);
        if (!this.coalesceEvent(turnId, type, normalizedPayload)) {
          await this.appendEvent(turnId, type, normalizedPayload);
        }
        return;
      }
      case 'tool.started':
      case 'tool.completed': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        await this.flushPendingCoalescedEventsForTurn(turnId);
        await this.appendEvent(turnId, type, this.normalizePayload(payload));
        return;
      }
      case 'thread.token_usage.updated': {
        const ratio = readFiniteNumber(payload.remainingRatio);
        const remainingTokens = readFiniteNumber(payload.remainingTokens);
        const windowTokens = readFiniteNumber(payload.modelContextWindow);
        const hasAnyUsageSignal = ratio !== null || remainingTokens !== null || windowTokens !== null;
        if (!hasAnyUsageSignal) {
          const normalizedPayload = this.normalizePayload(payload);
          if (!this.coalesceEvent(turnId, type, normalizedPayload)) {
            await this.appendEvent(turnId, type, normalizedPayload);
          }
          return;
        }
        await this.prisma.turn.update({
          where: { id: turnId },
          data: {
            contextRemainingRatio: ratio === null ? undefined : ratio,
            contextRemainingTokens: remainingTokens === null ? undefined : Math.max(0, Math.round(remainingTokens)),
            contextWindowTokens: windowTokens === null ? undefined : Math.max(0, Math.round(windowTokens)),
            contextUpdatedAt: new Date(),
          },
        });
        const normalizedPayload = this.normalizePayload(payload);
        if (!this.coalesceEvent(turnId, type, normalizedPayload)) {
          await this.appendEvent(turnId, type, normalizedPayload);
        }
        return;
      }
      case 'turn.completed': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const content = payload.content;
        if (typeof content !== 'string') {
          throw new ConflictException({
            message: 'turn.completed requires payload.content',
          });
        }

        await this.flushPendingCoalescedEventsForTurn(turnId);
        const assistantContentFromEvents = await this.collectAssistantDeltaContent(turnId);
        const assistantContent =
          assistantContentFromEvents.full.length > 0
            ? assistantContentFromEvents.nonReasoning.length > 0
              ? assistantContentFromEvents.full
              : `${assistantContentFromEvents.full}${content}`
            : content;
        const normalizedAssistantContent = ensureBalancedThinkTags(assistantContent);

        await this.prisma.$transaction(async (tx) => {
          const assistantMessage = await tx.message.create({
            data: {
              sessionId: turn.sessionId,
              role: 'assistant',
              content: normalizedAssistantContent,
            },
          });

          await tx.turn.update({
            where: { id: turnId },
            data: {
              assistantMessageId: assistantMessage.id,
              status: 'completed',
              endedAt: new Date(),
              startedAt: turn.status === 'queued' ? new Date() : undefined,
            },
          });

          await tx.botMessage.create({
            data: {
              projectId: turn.session.projectId,
              sessionId: turn.sessionId,
              kind: 'turn_message',
              payloadRaw: {
                turnId: turn.id,
                triggerIdentifier: turn.triggerIdentifier,
                triggerProvider: turn.triggerProvider,
                triggerIntegrationId: turn.triggerIntegrationId,
                triggerMessageId: turn.triggerMessageId,
                content: normalizedAssistantContent,
              },
              status: 'queued',
            },
          });
        });

        await this.appendEvent(turnId, 'turn.completed', this.normalizePayload(payload));
        return;
      }
      case 'turn.cancelled': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        await this.flushPendingCoalescedEventsForTurn(turnId);
        const assistantContent = ensureBalancedThinkTags(
          resolveAssistantContent(
            await this.collectAssistantDeltaContent(turnId),
            typeof payload.content === 'string' ? payload.content : '',
          ),
        );

        await this.prisma.$transaction(async (tx) => {
          const assistantMessage =
            assistantContent.length > 0
              ? await tx.message.create({
                  data: {
                    sessionId: turn.sessionId,
                    role: 'assistant',
                    content: assistantContent,
                  },
                })
              : null;

          await tx.turn.update({
            where: { id: turnId },
            data: {
              assistantMessageId: assistantMessage?.id,
              status: 'cancelled',
              endedAt: new Date(),
              startedAt: turn.status === 'queued' ? new Date() : undefined,
            },
          });

          if (assistantContent.length > 0) {
            await tx.botMessage.create({
              data: {
                projectId: turn.session.projectId,
                sessionId: turn.sessionId,
                kind: 'turn_message',
                payloadRaw: {
                  turnId: turn.id,
                  triggerIdentifier: turn.triggerIdentifier,
                  triggerProvider: turn.triggerProvider,
                  triggerIntegrationId: turn.triggerIntegrationId,
                  triggerMessageId: turn.triggerMessageId,
                  content: assistantContent,
                },
                status: 'queued',
              },
            });
          }
        });
        await this.appendEvent(turnId, 'turn.cancelled', this.normalizePayload(payload));
        return;
      }
      case 'turn.failed': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const code =
          typeof payload.code === 'string' && payload.code.trim().length > 0 ? payload.code.trim() : 'RUNNER_FAILED';
        const message =
          typeof payload.message === 'string' && payload.message.trim().length > 0
            ? payload.message.trim()
            : 'Runner reported a failure';
        await this.failTurn(
          turnId,
          turn.status,
          code,
          message,
          this.normalizePayload(payload),
          typeof payload.content === 'string' ? payload.content : '',
        );
        return;
      }
      default:
        return;
    }
  }

  private coalesceEvent(turnId: string, type: RunnerEventType, payload: Prisma.InputJsonValue): boolean {
    if (LAST_WRITE_WINS_EVENT_TYPES.has(type)) {
      this.upsertCoalescedEvent(`${turnId}:${type}`, turnId, type, payload);
      return true;
    }

    if (!TEXT_COALESCED_EVENT_TYPES.has(type)) {
      return false;
    }

    const textField = getCoalescedTextField(type, payload);
    if (!textField) {
      return false;
    }

    const key = buildTextCoalescingKey(turnId, type, payload, textField);
    const existing = this.pendingCoalescedEvents.get(key);
    if (existing) {
      existing.payload = mergeCoalescedTextPayload(existing.payload, payload, textField);
      return true;
    }

    this.upsertCoalescedEvent(key, turnId, type, payload);
    return true;
  }

  private upsertCoalescedEvent(
    key: string,
    turnId: string,
    type: RunnerEventType,
    payload: Prisma.InputJsonValue,
  ): void {
    const existing = this.pendingCoalescedEvents.get(key);
    if (existing) {
      existing.payload = payload;
      return;
    }

    const timer = setTimeout(() => {
      void this.flushPendingCoalescedEvent(key).catch((error: unknown) => {
        this.logger.error(
          `Failed to flush coalesced ${type} event for turn ${turnId}: ${formatErrorMessage(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      });
    }, COALESCED_EVENT_FLUSH_MS);
    timer.unref?.();
    this.pendingCoalescedEvents.set(key, {
      turnId,
      type,
      payload,
      timer,
    });
  }

  private async flushPendingCoalescedEvent(key: string): Promise<void> {
    const pending = this.pendingCoalescedEvents.get(key);
    if (!pending) {
      return;
    }

    this.pendingCoalescedEvents.delete(key);
    clearTimeout(pending.timer);

    const flush = this.appendEvent(pending.turnId, pending.type, pending.payload);
    this.trackCoalescedFlush(pending.turnId, flush);
    await flush;
  }

  private trackCoalescedFlush(turnId: string, flush: Promise<void>): void {
    let active = this.activeCoalescedFlushesByTurn.get(turnId);
    if (!active) {
      active = new Set();
      this.activeCoalescedFlushesByTurn.set(turnId, active);
    }
    active.add(flush);
    void flush
      .finally(() => {
        const current = this.activeCoalescedFlushesByTurn.get(turnId);
        current?.delete(flush);
        if (current?.size === 0) {
          this.activeCoalescedFlushesByTurn.delete(turnId);
        }
      })
      .catch(() => {
        // The original flush promise is awaited by the caller; this branch only
        // prevents the cleanup promise from surfacing as an unhandled rejection.
      });
  }

  private async flushPendingCoalescedEventsForTurn(turnId: string): Promise<void> {
    while (true) {
      const keys = Array.from(this.pendingCoalescedEvents.entries())
        .filter(([, pending]) => pending.turnId === turnId)
        .map(([key]) => key);

      if (keys.length > 0) {
        for (const key of keys) {
          await this.flushPendingCoalescedEvent(key);
        }
        continue;
      }

      const active = Array.from(this.activeCoalescedFlushesByTurn.get(turnId) ?? []);
      if (active.length === 0) {
        return;
      }
      await Promise.all(active);
    }
  }

  private async flushAllPendingCoalescedEvents(): Promise<void> {
    while (this.pendingCoalescedEvents.size > 0) {
      const keys = Array.from(this.pendingCoalescedEvents.keys());
      for (const key of keys) {
        await this.flushPendingCoalescedEvent(key);
      }
    }

    const active = Array.from(this.activeCoalescedFlushesByTurn.values()).flatMap((flushes) => Array.from(flushes));
    if (active.length > 0) {
      await Promise.all(active);
    }
  }

  private async appendEvent(turnId: string, type: RunnerEventType, payload: Prisma.InputJsonValue): Promise<void> {
    const previous = this.eventWriteQueues.get(turnId) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // Preserve queue progress after a failed write; the failing caller still
        // observes its original rejection.
      })
      .then(() => this.appendEventNow(turnId, type, payload));
    this.eventWriteQueues.set(turnId, next);
    try {
      await next;
    } finally {
      if (this.eventWriteQueues.get(turnId) === next) {
        this.eventWriteQueues.delete(turnId);
      }
    }
  }

  private async appendEventNow(turnId: string, type: RunnerEventType, payload: Prisma.InputJsonValue): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const latest = await tx.event.findFirst({
        where: { turnId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });

      const event = await tx.event.create({
        data: {
          turnId,
          seq: (latest?.seq ?? 0) + 1,
          type,
          payload,
        },
      });

      const turn = await tx.turn.findUnique({
        where: { id: turnId },
        select: {
          sessionId: true,
          session: {
            select: {
              projectId: true,
            },
          },
        },
      });
      if (!turn) {
        return;
      }

      await tx.botMessage.create({
        data: {
          projectId: turn.session.projectId,
          sessionId: turn.sessionId,
          kind: 'event',
          eventId: event.id,
          payloadRaw: {},
          status: 'queued',
        },
      });
    });
    await this.queueSignalService.publishOutboundWake();
  }

  private normalizePayload(payload: Record<string, unknown>): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
  }

  private async openReasoningBlockIfNeeded(turnId: string): Promise<void> {
    if (this.reasoningOpenTurns.has(turnId)) {
      return;
    }
    await this.flushPendingCoalescedEventsForTurn(turnId);
    this.reasoningOpenTurns.add(turnId);
    await this.appendEvent(turnId, 'assistant.delta', this.normalizePayload({ text: '<think>', isReasoning: true }));
  }

  private async closeReasoningBlockIfOpen(turnId: string): Promise<void> {
    if (!this.reasoningOpenTurns.has(turnId)) {
      return;
    }
    await this.flushPendingCoalescedEventsForTurn(turnId);
    this.reasoningOpenTurns.delete(turnId);
    await this.appendEvent(turnId, 'assistant.delta', this.normalizePayload({ text: '</think>', isReasoning: true }));
  }

  private async collectAssistantDeltaContent(turnId: string): Promise<{ full: string; nonReasoning: string }> {
    const deltaEvents = await this.prisma.event.findMany({
      where: {
        turnId,
        type: 'assistant.delta',
      },
      orderBy: { seq: 'asc' },
      select: {
        payload: true,
      },
    });
    if (deltaEvents.length === 0) {
      return { full: '', nonReasoning: '' };
    }
    const fullChunks: string[] = [];
    const nonReasoningChunks: string[] = [];
    for (const event of deltaEvents) {
      const { text, isReasoning } = extractAssistantDelta(event.payload);
      if (text.length > 0) {
        fullChunks.push(text);
        if (!isReasoning) {
          nonReasoningChunks.push(text);
        }
      }
    }
    return {
      full: fullChunks.join(''),
      nonReasoning: nonReasoningChunks.join(''),
    };
  }

  private async reconcileInFlightTurnsOnStartup(): Promise<void> {
    await this.reconcileInFlightTurns();
  }

  private async reconcileInFlightTurns(): Promise<void> {
    if (this.runnerReconcileInProgress) {
      return;
    }
    this.runnerReconcileInProgress = true;
    try {
      const inFlightTurns = await this.prisma.turn.findMany({
        where: { status: { in: ACTIVE_TURN_STATUSES } },
        select: { id: true, status: true },
      });

      if (inFlightTurns.length === 0) {
        return;
      }

      for (const turn of inFlightTurns) {
        this.ensureRunnerEventConsumer(turn.id);
      }
    } finally {
      this.runnerReconcileInProgress = false;
    }
  }

  private ensureRunnerEventConsumer(turnId: string): void {
    if (this.runnerConsumers.has(turnId)) {
      return;
    }

    let retryConsumer = false;
    const task = this.consumeRunnerEvents(turnId)
      .catch((error: unknown) => {
        if (isTransientDatabaseError(error)) {
          retryConsumer = true;
          this.logger.warn(
            `Transient database failure while consuming runner events for turn ${turnId}; retrying: ${formatErrorMessage(error)}`,
          );
          return;
        }
        if (error instanceof Error) {
          this.logger.error(`Runner stream failed for turn ${turnId}: ${error.message}`, error.stack);
          return;
        }
        this.logger.error(`Runner stream failed for turn ${turnId}`);
      })
      .finally(() => {
        this.runnerConsumers.delete(turnId);
        if (retryConsumer) {
          this.scheduleRunnerConsumerRetry(turnId);
        }
      });

    this.runnerConsumers.set(turnId, task);
  }

  private scheduleRunnerConsumerRetry(turnId: string): void {
    if (this.runnerConsumerRetryTimers.has(turnId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.runnerConsumerRetryTimers.delete(turnId);
      this.ensureRunnerEventConsumer(turnId);
    }, RUNNER_CONSUMER_RETRY_MS);
    timer.unref?.();
    this.runnerConsumerRetryTimers.set(turnId, timer);
  }

  private async consumeRunnerEvents(turnId: string): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: { id: true, status: true },
    });
    if (!turn || TERMINAL_STATUSES.includes(turn.status)) {
      return;
    }

    const latestEvent = await this.prisma.event.findFirst({
      where: { turnId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const sinceSeq = this.runnerEventCursors.get(turnId) ?? latestEvent?.seq ?? 0;

    try {
      await this.runnerAdapter.consumeTurnEvents(
        { turnId, sinceSeq },
        async (event: RunnerStreamEvent) => {
          await this.ingestRunnerEvent(event.turnId, event.type, event.payload ?? {});
          if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') {
            this.runnerEventCursors.delete(turnId);
          } else {
            this.runnerEventCursors.set(turnId, event.seq);
          }
        },
      );
    } catch (error: unknown) {
      if (isTransientDatabaseError(error)) {
        throw error;
      }
      const currentTurn = await this.prisma.turn.findUnique({
        where: { id: turnId },
        select: { status: true },
      });
      if (!currentTurn || TERMINAL_STATUSES.includes(currentTurn.status)) {
        return;
      }

      const message = error instanceof Error ? error.message : 'Runner stream failed';
      const runnerTurnMissing = isRunnerTurnMissingError(error);
      await this.failTurn(
        turnId,
        currentTurn.status,
        runnerTurnMissing ? 'ORPHANED_TURN' : 'RUNNER_STREAM_FAILED',
        runnerTurnMissing ? 'The database said this turn was active, but the runner no longer had it.' : message,
        this.normalizePayload({
          code: runnerTurnMissing ? 'ORPHANED_TURN' : 'RUNNER_STREAM_FAILED',
          message: runnerTurnMissing
            ? 'The database said this turn was active, but the runner no longer had it.'
            : message,
        }),
      );
      this.runnerEventCursors.delete(turnId);
    }
  }

  private async failTurn(
    turnId: string,
    previousStatus: string,
    failureCode: string,
    failureMessage: string,
    eventPayload: Prisma.InputJsonValue,
    fallbackAssistantContent = '',
  ): Promise<void> {
    await this.flushPendingCoalescedEventsForTurn(turnId);
    const assistantContent = ensureBalancedThinkTags(
      resolveAssistantContent(await this.collectAssistantDeltaContent(turnId), fallbackAssistantContent),
    );
    const turn = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: {
        id: true,
        sessionId: true,
        triggerIdentifier: true,
        triggerProvider: true,
        triggerIntegrationId: true,
        triggerMessageId: true,
        session: {
          select: { projectId: true },
        },
      },
    });
    if (!turn) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const assistantMessage =
        assistantContent.length > 0
          ? await tx.message.create({
              data: {
                sessionId: turn.sessionId,
                role: 'assistant',
                content: assistantContent,
              },
            })
          : null;

      await tx.turn.update({
        where: { id: turnId },
        data: {
          assistantMessageId: assistantMessage?.id,
          status: 'failed',
          failureCode,
          failureMessage,
          endedAt: new Date(),
          startedAt: previousStatus === 'queued' ? new Date() : undefined,
        },
      });

      if (assistantMessage) {
        await tx.botMessage.create({
          data: {
            projectId: turn.session.projectId,
            sessionId: turn.sessionId,
            kind: 'turn_message',
            payloadRaw: {
              turnId: turn.id,
              triggerIdentifier: turn.triggerIdentifier,
              triggerProvider: turn.triggerProvider,
              triggerIntegrationId: turn.triggerIntegrationId,
              triggerMessageId: turn.triggerMessageId,
              content: assistantContent,
            },
            status: 'queued',
          },
        });
      }
    });
    await this.appendEvent(turnId, 'turn.failed', eventPayload);
  }

  private async getPendingApproval(turnId: string): Promise<PendingApprovalSummary | null> {
    const approval = await this.prisma.turnApproval.findFirst({
      where: {
        turnId,
        status: 'pending',
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!approval) {
      return null;
    }

    const payload = {
      ...((approval.payload as Record<string, unknown>) ?? {}),
      autoApproveAt: approval.autoApproveAt ? approval.autoApproveAt.toISOString() : null,
      pausedAt: approval.pausedAt ? approval.pausedAt.toISOString() : null,
      pausedRemainingMs: approval.pausedRemainingMs,
    };
    return {
      id: approval.requestId,
      kind: approval.kind,
      status: approval.status,
      decision: approval.decision,
      createdAt: approval.createdAt,
      resolvedAt: approval.resolvedAt,
      payload,
    };
  }
}

function isApprovalAccepted(decision: string): boolean {
  return (
    decision === 'approve' ||
    decision === 'accept' ||
    decision === 'acceptForSession' ||
    decision.startsWith('acceptWithExecpolicyAmendment') ||
    decision.startsWith('applyNetworkPolicyAmendment')
  );
}

function normalizeApprovalDecisionInput(decision: ResolveTurnApprovalBody['decision']) {
  if (decision === 'approve') {
    return 'accept' as const;
  }
  if (decision === 'reject') {
    return 'decline' as const;
  }
  return decision;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveAssistantContent(
  eventContent: { full: string; nonReasoning: string },
  fallbackContent: string,
): string {
  if (eventContent.full.length === 0) {
    return fallbackContent;
  }
  if (eventContent.nonReasoning.length > 0 || fallbackContent.length === 0) {
    return eventContent.full;
  }
  return `${eventContent.full}${fallbackContent}`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function isTransientDatabaseError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  if (['P1008', 'P2024', 'P2028'].includes(code)) {
    return true;
  }

  const message = formatErrorMessage(error).toLowerCase();
  return [
    'socket timeout',
    'database is locked',
    'database table is locked',
    'sqlite_busy',
    'timed out fetching a new connection',
    'transaction already closed',
  ].some((fragment) => message.includes(fragment));
}

function isRunnerTurnMissingError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes('active turn not found') ||
    message.includes('turn not found') ||
    message.includes('runner stream failed: 404')
  );
}

function getCoalescedTextField(
  type: RunnerEventType,
  payload: Prisma.InputJsonValue,
): 'text' | 'delta' | 'output' | null {
  if (!isJsonObject(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (type === 'assistant.delta') {
    return typeof record.text === 'string' ? 'text' : null;
  }
  if (type === 'reasoning.delta') {
    return typeof record.delta === 'string' ? 'delta' : null;
  }
  if (type === 'tool.output') {
    if (typeof record.text === 'string') {
      return 'text';
    }
    if (typeof record.output === 'string') {
      return 'output';
    }
  }
  return null;
}

function buildTextCoalescingKey(
  turnId: string,
  type: RunnerEventType,
  payload: Prisma.InputJsonValue,
  textField: 'text' | 'delta' | 'output',
): string {
  const metadata = isJsonObject(payload) ? { ...(payload as Record<string, unknown>) } : {};
  delete metadata[textField];
  return `${turnId}:${type}:${textField}:${stableStringify(metadata)}`;
}

function mergeCoalescedTextPayload(
  existingPayload: Prisma.InputJsonValue,
  nextPayload: Prisma.InputJsonValue,
  textField: 'text' | 'delta' | 'output',
): Prisma.InputJsonValue {
  if (!isJsonObject(existingPayload) || !isJsonObject(nextPayload)) {
    return nextPayload;
  }
  const existingRecord = existingPayload as Record<string, unknown>;
  const nextRecord = nextPayload as Record<string, unknown>;
  const existingText = typeof existingRecord[textField] === 'string' ? existingRecord[textField] : '';
  const nextText = typeof nextRecord[textField] === 'string' ? nextRecord[textField] : '';
  return {
    ...existingRecord,
    [textField]: `${existingText}${nextText}`,
  } as Prisma.InputJsonValue;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function extractAssistantDelta(payload: Prisma.JsonValue): {
  text: string;
  isReasoning: boolean;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { text: '', isReasoning: false };
  }
  const record = payload as Record<string, unknown>;
  const text = record.text;
  return {
    text: typeof text === 'string' ? text : '',
    isReasoning: record.isReasoning === true,
  };
}

function ensureBalancedThinkTags(content: string): string {
  if (!content.includes('<think>')) {
    return content;
  }
  const openCount = (content.match(/<think>/gi) ?? []).length;
  const closeCount = (content.match(/<\/think>/gi) ?? []).length;
  if (openCount <= closeCount) {
    return content;
  }
  return `${content}${'</think>'.repeat(openCount - closeCount)}`;
}

function normalizeJsonRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readSessionRuntimeFromMeta(meta: Prisma.JsonValue | null): {
  backend: string | null;
  cwd: string | null;
  backendConfig: Record<string, unknown> | null;
  autoApprove: boolean;
  autoApproveTimeoutSeconds: number;
} {
  const root = normalizeJsonRecord(meta);
  const runtime = normalizeJsonRecord((root?.runtime as Prisma.JsonValue | undefined) ?? null);
  if (!runtime) {
    throw new ConflictException({
      message: 'Session runtime metadata is missing',
    });
  }
  const backend =
    typeof runtime.backend === 'string' && runtime.backend.trim().length > 0 ? runtime.backend.trim() : null;
  if (!backend) {
    throw new ConflictException({
      message: 'Session runtime backend is missing',
    });
  }
  const cwd = typeof runtime.cwd === 'string' && runtime.cwd.trim().length > 0 ? runtime.cwd.trim() : null;
  const backendConfig = normalizeJsonRecord((runtime.backendConfig as Prisma.JsonValue | undefined) ?? null) ?? null;
  const autoApprove = typeof runtime.autoApprove === 'boolean' ? runtime.autoApprove : false;
  const autoApproveTimeoutSeconds =
    typeof runtime.autoApproveTimeoutSeconds === 'number' &&
    Number.isFinite(runtime.autoApproveTimeoutSeconds) &&
    runtime.autoApproveTimeoutSeconds >= 0
      ? Math.floor(runtime.autoApproveTimeoutSeconds)
      : 10;
  return {
    backend,
    cwd,
    backendConfig,
    autoApprove,
    autoApproveTimeoutSeconds,
  };
}

function buildRequestedBackendConfig(
  backendConfig: Record<string, unknown> | null,
  cwd: string | null,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  const payload: Record<string, unknown> = {};
  if (backendConfig) {
    Object.assign(payload, backendConfig);
  }
  if (typeof cwd === 'string' && cwd.trim().length > 0) {
    payload.cwd = cwd.trim();
  }
  if (Object.keys(payload).length === 0) {
    return Prisma.JsonNull;
  }
  return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
}

function buildEffectiveBackendConfig(
  payload: Record<string, unknown>,
  turn: {
    backend: string | null;
    requestedBackendConfig: Prisma.JsonValue | null;
  },
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  const effective: Record<string, unknown> = {};
  const requested = normalizeJsonRecord(turn.requestedBackendConfig);
  if (typeof payload.cwd === 'string' && payload.cwd.trim().length > 0) {
    effective.cwd = payload.cwd.trim();
  } else if (typeof requested?.cwd === 'string' && requested.cwd.trim().length > 0) {
    effective.cwd = requested.cwd.trim();
  }
  if (typeof payload.model === 'string' && payload.model.trim().length > 0) {
    effective.model = payload.model.trim();
  } else if (typeof requested?.model === 'string' && requested.model.trim().length > 0) {
    effective.model = requested.model.trim();
  }

  const explicitExecutionMode =
    typeof payload.executionMode === 'string' && payload.executionMode.trim().length > 0
      ? normalizeExecutionMode(payload.executionMode)
      : null;
  const requestedExecutionMode =
    typeof requested?.executionMode === 'string' && requested.executionMode.trim().length > 0
      ? normalizeExecutionMode(requested.executionMode)
      : null;
  const derivedExecutionMode = turn.backend?.trim() === 'codex' ? deriveExecutionModeFromRuntime(payload) : null;
  const executionMode = explicitExecutionMode ?? requestedExecutionMode ?? derivedExecutionMode;
  if (executionMode) {
    effective.executionMode = executionMode;
  }
  if (Object.keys(effective).length === 0) {
    return Prisma.JsonNull;
  }
  return JSON.parse(JSON.stringify(effective)) as Prisma.InputJsonValue;
}

function buildEffectiveRuntimeConfig(
  payload: Record<string, unknown>,
  existing: Prisma.JsonValue | null | undefined,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  // Preserve auto-approve fields snapshotted at turn-start; the runner
  // doesn't know about them and `turn.started` would otherwise overwrite.
  const carried: Record<string, unknown> = {};
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const e = existing as Record<string, unknown>;
    if (typeof e.autoApprove === 'boolean') carried.autoApprove = e.autoApprove;
    if (typeof e.autoApproveTimeoutSeconds === 'number') {
      carried.autoApproveTimeoutSeconds = e.autoApproveTimeoutSeconds;
    }
  }
  const runtime: Record<string, unknown> = { ...carried };
  if (typeof payload.cwd === 'string' && payload.cwd.trim().length > 0) {
    runtime.cwd = payload.cwd.trim();
  }
  if (typeof payload.model === 'string' && payload.model.trim().length > 0) {
    runtime.model = payload.model.trim();
  }
  if (typeof payload.sandbox === 'string' && payload.sandbox.trim().length > 0) {
    runtime.sandbox = payload.sandbox.trim();
  } else if (payload.sandbox && typeof payload.sandbox === 'object' && !Array.isArray(payload.sandbox)) {
    runtime.sandbox = JSON.parse(JSON.stringify(payload.sandbox)) as Record<string, unknown>;
  }
  if (typeof payload.approvalPolicy === 'string' && payload.approvalPolicy.trim().length > 0) {
    runtime.approvalPolicy = payload.approvalPolicy.trim();
  }
  if (typeof payload.permissionMode === 'string' && payload.permissionMode.trim().length > 0) {
    runtime.permissionMode = payload.permissionMode.trim();
  }
  if (payload.allowDangerouslySkipPermissions === true) {
    runtime.allowDangerouslySkipPermissions = true;
  }
  if (Object.keys(runtime).length === 0) {
    return Prisma.JsonNull;
  }
  return JSON.parse(JSON.stringify(runtime)) as Prisma.InputJsonValue;
}

type ExecutionModeValue = 'read-only' | 'safe-write' | 'auto-review' | 'yolo';

function normalizeExecutionMode(value: string): ExecutionModeValue | null {
  const normalized = value.trim();
  if (
    normalized === 'read-only' ||
    normalized === 'safe-write' ||
    normalized === 'auto-review' ||
    normalized === 'yolo'
  ) {
    return normalized;
  }
  return null;
}

function deriveExecutionModeFromRuntime(payload: Record<string, unknown>): ExecutionModeValue | null {
  const sandbox = typeof payload.sandbox === 'string' ? payload.sandbox.trim() : '';
  const approvalPolicy = typeof payload.approvalPolicy === 'string' ? payload.approvalPolicy.trim() : '';
  const approvalsReviewer = typeof payload.approvalsReviewer === 'string' ? payload.approvalsReviewer.trim() : '';
  if (!sandbox && !approvalPolicy && !approvalsReviewer) {
    return null;
  }
  if (sandbox === 'read-only') {
    return 'read-only';
  }
  if (sandbox === 'danger-full-access' || approvalPolicy === 'never') {
    return 'yolo';
  }
  if (approvalsReviewer === 'auto_review') {
    return 'auto-review';
  }
  return 'safe-write';
}

function normalizeTriggerIdentifier(input: string | undefined): string {
  const normalized = input?.trim();
  return normalized && normalized.length > 0 ? normalized : 'web';
}

function normalizeTriggerMessageId(input: string | null | undefined): string | null {
  const normalized = input?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeTriggerProvider(input: string | undefined): string {
  const normalized = input?.trim();
  return normalized && normalized.length > 0 ? normalized : 'web';
}

function normalizeTriggerIntegrationId(input: string | undefined): string | null {
  const normalized = input?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}
