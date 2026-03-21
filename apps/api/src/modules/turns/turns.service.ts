import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_ADAPTER, RunnerAdapter, RunnerStreamEvent } from '../runner/runner.types';
import { SettingsService } from '../settings/settings.service';
import { CreateTurnBody, ResolveTurnApprovalBody, SteerTurnBody } from './turns.schemas';

const ACTIVE_TURN_STATUSES = ['queued', 'running', 'waiting_approval'];
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const STEERABLE_TURN_STATUSES = ['queued', 'running'];

export type RunnerEventType =
  | 'turn.started'
  | 'assistant.delta'
  | 'turn.approval.requested'
  | 'turn.approval.resolved'
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

@Injectable()
export class TurnsService implements OnModuleInit {
  private readonly logger = new Logger(TurnsService.name);
  private readonly runnerConsumers = new Map<string, Promise<void>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter,
    @Inject(SettingsService) private readonly settingsService: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reconcileInFlightTurnsOnStartup();
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
        codexThreadId: true,
        project: {
          select: {
            repoPath: true,
            backend: true,
            backendConfig: true,
          },
        },
      },
    });
    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }

    const cwd = session.project.repoPath?.trim() || null;
    const backend = session.project.backend?.trim() || null;
    const backendConfig =
      session.project.backendConfig && typeof session.project.backendConfig === 'object' && !Array.isArray(session.project.backendConfig)
        ? (session.project.backendConfig as Record<string, unknown>)
        : null;

    const activeTurn = await this.prisma.turn.findFirst({
      where: {
        sessionId,
        status: { in: ACTIVE_TURN_STATUSES },
      },
      select: { id: true },
    });
    if (activeTurn) {
      throw new ConflictException({ message: 'An active turn already exists for this session' });
    }

    const turn = await this.prisma.$transaction(async (tx) => {
      const userMessage = await tx.message.create({
        data: {
          sessionId,
          role: 'user',
          content: input.content,
        },
      });

      return tx.turn.create({
        data: {
          sessionId,
          userMessageId: userMessage.id,
          status: 'queued',
          backend,
          requestedBackendConfig: buildRequestedBackendConfig(backendConfig, cwd),
        },
      });
    });

    void this.runnerAdapter
      .startTurn({
        turnId: turn.id,
        sessionId,
        content: input.content,
        backend,
        backendConfig,
        threadId: session.codexThreadId,
        cwd,
      })
      .then(() => {
        this.ensureRunnerEventConsumer(turn.id);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Runner start failed';
        void this.failTurn(
          turn.id,
          turn.status,
          'RUNNER_DISPATCH_FAILED',
          message,
          this.normalizePayload({ code: 'RUNNER_DISPATCH_FAILED', message }),
        );
        if (error instanceof Error) {
          this.logger.error(`Failed to dispatch turn ${turn.id} to runner: ${error.message}`, error.stack);
          return;
        }
        this.logger.error(`Failed to dispatch turn ${turn.id} to runner`);
      });

    return {
      turnId: turn.id,
      status: turn.status,
    };
  }

  async cancelTurnForUser(userId: string, turnId: string) {
    await this.getTurnForUser(userId, turnId);
    await this.runnerAdapter.cancelTurn({ turnId });

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
      throw new ConflictException({ message: 'Only running or queued turns can be steered' });
    }

    await this.prisma.message.create({
      data: {
        sessionId: turn.sessionId,
        role: 'user',
        content: input.content,
      },
    });

    await this.runnerAdapter.steerTurn({
      turnId,
      content: input.content,
    });

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
      select: { id: true, sessionId: true, status: true, backend: true, requestedBackendConfig: true },
    });
    if (!turn) {
      throw new NotFoundException({ message: 'Turn not found' });
    }

    switch (type) {
      case 'turn.started': {
        const threadId = payload.threadId;
        if (typeof threadId === 'string' && threadId.length > 0) {
          await this.prisma.session.update({
            where: { id: turn.sessionId },
            data: { codexThreadId: threadId },
          });
        }
        if (turn.status === 'queued') {
          await this.prisma.turn.update({
            where: { id: turnId },
            data: {
              status: 'running',
              startedAt: new Date(),
              effectiveBackendConfig: buildEffectiveBackendConfig(payload, turn),
              effectiveRuntimeConfig: buildEffectiveRuntimeConfig(payload),
            },
          });
        } else {
          await this.prisma.turn.update({
            where: { id: turnId },
            data: {
              effectiveBackendConfig: buildEffectiveBackendConfig(payload, turn),
              effectiveRuntimeConfig: buildEffectiveRuntimeConfig(payload),
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
          throw new ConflictException({ message: 'assistant.delta requires payload.text' });
        }
        await this.appendEvent(turnId, 'assistant.delta', this.normalizePayload({ text }));
        return;
      }
      case 'turn.approval.requested': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
        const kind = typeof payload.kind === 'string' ? payload.kind.trim() : '';
        if (!requestId || !kind) {
          throw new ConflictException({ message: 'turn.approval.requested requires payload.requestId and payload.kind' });
        }

        const normalizedPayload = this.normalizePayload(payload);
        await this.prisma.$transaction(async (tx) => {
          await tx.turn.update({
            where: { id: turnId },
            data: {
              status: 'waiting_approval',
              startedAt: turn.status === 'queued' ? new Date() : undefined,
            },
          });

          await tx.turnApproval.upsert({
            where: {
              turnId_requestId: {
                turnId,
                requestId,
              },
            },
            update: {
              kind,
              status: 'pending',
              decision: null,
              resolvedAt: null,
              payload: normalizedPayload,
            },
            create: {
              turnId,
              requestId,
              kind,
              status: 'pending',
              payload: normalizedPayload,
            },
          });
        });

        await this.appendEvent(turnId, 'turn.approval.requested', normalizedPayload);
        return;
      }
      case 'turn.approval.resolved': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
        const decision = typeof payload.decision === 'string' ? payload.decision.trim() : '';
        if (!requestId || !decision) {
          throw new ConflictException({ message: 'turn.approval.resolved requires payload.requestId and payload.decision' });
        }

        const normalizedPayload = this.normalizePayload(payload);
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

        await this.appendEvent(turnId, 'turn.approval.resolved', normalizedPayload);
        return;
      }
      case 'plan.updated':
      case 'reasoning.delta':
      case 'diff.updated':
      case 'tool.started':
      case 'tool.output':
      case 'tool.completed': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        await this.appendEvent(turnId, type, this.normalizePayload(payload));
        return;
      }
      case 'thread.token_usage.updated': {
        const ratio = readFiniteNumber(payload.remainingRatio);
        const remainingTokens = readFiniteNumber(payload.remainingTokens);
        const windowTokens = readFiniteNumber(payload.modelContextWindow);
        await this.prisma.turn.update({
          where: { id: turnId },
          data: {
            contextRemainingRatio: ratio,
            contextRemainingTokens: remainingTokens === null ? null : Math.max(0, Math.round(remainingTokens)),
            contextWindowTokens: windowTokens === null ? null : Math.max(0, Math.round(windowTokens)),
            contextUpdatedAt: new Date(),
          },
        });
        await this.appendEvent(turnId, type, this.normalizePayload(payload));
        return;
      }
      case 'turn.completed': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const content = payload.content;
        if (typeof content !== 'string') {
          throw new ConflictException({ message: 'turn.completed requires payload.content' });
        }

        await this.prisma.$transaction(async (tx) => {
          const assistantMessage = await tx.message.create({
            data: {
              sessionId: turn.sessionId,
              role: 'assistant',
              content,
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
        });

        await this.appendEvent(turnId, 'turn.completed', this.normalizePayload({}));
        return;
      }
      case 'turn.cancelled': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        await this.prisma.$transaction(async (tx) => {
          const assistantContent = await this.collectAssistantDeltaContent(tx, turnId);
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
        });
        await this.appendEvent(turnId, 'turn.cancelled', this.normalizePayload(payload));
        return;
      }
      case 'turn.failed': {
        if (TERMINAL_STATUSES.includes(turn.status)) {
          return;
        }
        const code = typeof payload.code === 'string' && payload.code.trim().length > 0 ? payload.code.trim() : 'RUNNER_FAILED';
        const message =
          typeof payload.message === 'string' && payload.message.trim().length > 0
            ? payload.message.trim()
            : 'Runner reported a failure';
        await this.failTurn(turnId, turn.status, code, message, this.normalizePayload(payload));
        return;
      }
      default:
        return;
    }
  }

  private async appendEvent(turnId: string, type: RunnerEventType, payload: Prisma.InputJsonValue): Promise<void> {
    const latest = await this.prisma.event.findFirst({
      where: { turnId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });

    await this.prisma.event.create({
      data: {
        turnId,
        seq: (latest?.seq ?? 0) + 1,
        type,
        payload,
      },
    });
  }

  private normalizePayload(payload: Record<string, unknown>): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
  }

  private async collectAssistantDeltaContent(tx: Prisma.TransactionClient, turnId: string): Promise<string> {
    const deltaEvents = await tx.event.findMany({
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
      return '';
    }
    const chunks: string[] = [];
    for (const event of deltaEvents) {
      const text = extractAssistantDeltaText(event.payload);
      if (text.length > 0) {
        chunks.push(text);
      }
    }
    return chunks.join('');
  }

  private async reconcileInFlightTurnsOnStartup(): Promise<void> {
    const inFlightTurns = await this.prisma.turn.findMany({
      where: { status: { in: ACTIVE_TURN_STATUSES } },
      select: { id: true, status: true },
    });

    if (inFlightTurns.length === 0) {
      return;
    }

    this.logger.warn(`Reconciling ${inFlightTurns.length} in-flight turn(s) after API startup`);
    for (const turn of inFlightTurns) {
      this.ensureRunnerEventConsumer(turn.id);
    }
  }

  private ensureRunnerEventConsumer(turnId: string): void {
    if (this.runnerConsumers.has(turnId)) {
      return;
    }

    const task = this.consumeRunnerEvents(turnId)
      .catch((error: unknown) => {
        if (error instanceof Error) {
          this.logger.error(`Runner stream failed for turn ${turnId}: ${error.message}`, error.stack);
          return;
        }
        this.logger.error(`Runner stream failed for turn ${turnId}`);
      })
      .finally(() => {
        this.runnerConsumers.delete(turnId);
      });

    this.runnerConsumers.set(turnId, task);
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

    try {
      await this.runnerAdapter.consumeTurnEvents(
        { turnId, sinceSeq: latestEvent?.seq ?? 0 },
        async (event: RunnerStreamEvent) => {
          await this.ingestRunnerEvent(event.turnId, event.type, event.payload ?? {});
        },
      );
    } catch (error: unknown) {
      const currentTurn = await this.prisma.turn.findUnique({
        where: { id: turnId },
        select: { status: true },
      });
      if (!currentTurn || TERMINAL_STATUSES.includes(currentTurn.status)) {
        return;
      }

      const message = error instanceof Error ? error.message : 'Runner stream failed';
      await this.failTurn(
        turnId,
        currentTurn.status,
        'RUNNER_STREAM_FAILED',
        message,
        this.normalizePayload({
          code: 'RUNNER_STREAM_FAILED',
          message,
        }),
      );
    }
  }

  private async failTurn(
    turnId: string,
    previousStatus: string,
    failureCode: string,
    failureMessage: string,
    eventPayload: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.turn.update({
      where: { id: turnId },
      data: {
        status: 'failed',
        failureCode,
        failureMessage,
        endedAt: new Date(),
        startedAt: previousStatus === 'queued' ? new Date() : undefined,
      },
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

    return {
      id: approval.requestId,
      kind: approval.kind,
      status: approval.status,
      decision: approval.decision,
      createdAt: approval.createdAt,
      resolvedAt: approval.resolvedAt,
      payload: (approval.payload as Record<string, unknown>) ?? {},
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

function extractAssistantDeltaText(payload: Prisma.JsonValue): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  const text = (payload as Record<string, unknown>).text;
  return typeof text === 'string' ? text : '';
}

function normalizeJsonRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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
  turn: { backend: string | null; requestedBackendConfig: Prisma.JsonValue | null },
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
  const derivedExecutionMode =
    turn.backend?.trim() === 'codex' ? deriveExecutionModeFromRuntime(payload) : null;
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
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  const runtime: Record<string, unknown> = {};
  if (typeof payload.cwd === 'string' && payload.cwd.trim().length > 0) {
    runtime.cwd = payload.cwd.trim();
  }
  if (typeof payload.model === 'string' && payload.model.trim().length > 0) {
    runtime.model = payload.model.trim();
  }
  if (typeof payload.sandbox === 'string' && payload.sandbox.trim().length > 0) {
    runtime.sandbox = payload.sandbox.trim();
  }
  if (typeof payload.approvalPolicy === 'string' && payload.approvalPolicy.trim().length > 0) {
    runtime.approvalPolicy = payload.approvalPolicy.trim();
  }
  if (Object.keys(runtime).length === 0) {
    return Prisma.JsonNull;
  }
  return JSON.parse(JSON.stringify(runtime)) as Prisma.InputJsonValue;
}

function normalizeExecutionMode(value: string): 'read-only' | 'safe-write' | 'yolo' | null {
  const normalized = value.trim();
  if (normalized === 'read-only' || normalized === 'safe-write' || normalized === 'yolo') {
    return normalized;
  }
  return null;
}

function deriveExecutionModeFromRuntime(payload: Record<string, unknown>): 'read-only' | 'safe-write' | 'yolo' | null {
  const sandbox = typeof payload.sandbox === 'string' ? payload.sandbox.trim() : '';
  const approvalPolicy = typeof payload.approvalPolicy === 'string' ? payload.approvalPolicy.trim() : '';
  if (!sandbox && !approvalPolicy) {
    return null;
  }
  if (sandbox === 'read-only') {
    return 'read-only';
  }
  if (sandbox === 'danger-full-access' || approvalPolicy === 'never') {
    return 'yolo';
  }
  return 'safe-write';
}
