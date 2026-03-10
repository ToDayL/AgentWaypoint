import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';
import { CreateTurnBody } from './turns.schemas';

const ACTIVE_TURN_STATUSES = ['queued', 'running'];
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

export type RunnerEventType = 'turn.started' | 'assistant.delta' | 'turn.completed' | 'turn.failed' | 'turn.cancelled';

@Injectable()
export class TurnsService implements OnModuleInit {
  private readonly logger = new Logger(TurnsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter,
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
          select: { repoPath: true },
        },
      },
    });
    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }

    const cwd = await this.resolveProjectWorkspace(session.project.repoPath);

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
        },
      });
    });

    void this.runnerAdapter
      .startTurn({
        turnId: turn.id,
        sessionId,
        content: input.content,
        threadId: session.codexThreadId,
        cwd,
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
    return {
      id: turn.id,
      sessionId: turn.sessionId,
      status: turn.status,
      failureCode: turn.failureCode,
      failureMessage: turn.failureMessage,
      createdAt: turn.createdAt,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    };
  }

  async ingestRunnerEvent(turnId: string, type: RunnerEventType, payload: Record<string, unknown>) {
    const turn = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: { id: true, sessionId: true, status: true },
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
            data: { status: 'running', startedAt: new Date() },
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
        await this.prisma.turn.update({
          where: { id: turnId },
          data: {
            status: 'cancelled',
            endedAt: new Date(),
            startedAt: turn.status === 'queued' ? new Date() : undefined,
          },
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
      await this.failTurn(
        turn.id,
        turn.status,
        'RECOVERED_ON_STARTUP',
        'Turn marked failed during API startup reconciliation',
        this.normalizePayload({
          code: 'RECOVERED_ON_STARTUP',
          message: 'Turn marked failed during API startup reconciliation',
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

  private async resolveProjectWorkspace(repoPath: string | null): Promise<string> {
    const normalizedRepoPath = repoPath?.trim() ?? '';
    if (!normalizedRepoPath) {
      throw new ConflictException({ message: 'Project workspace is not configured (repoPath is required)' });
    }

    const absolutePath = path.resolve(normalizedRepoPath);
    this.assertWorkspaceAllowed(absolutePath);

    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      throw new ConflictException({ message: `Project workspace does not exist: ${absolutePath}` });
    }

    if (!info.isDirectory()) {
      throw new ConflictException({ message: `Project workspace is not a directory: ${absolutePath}` });
    }

    return absolutePath;
  }

  private assertWorkspaceAllowed(absolutePath: string): void {
    const rootsConfig = process.env.RUNNER_ALLOWED_REPO_ROOTS?.trim();
    if (!rootsConfig) {
      return;
    }

    const allowedRoots = rootsConfig
      .split(',')
      .map((entry) => path.resolve(entry.trim()))
      .filter((entry) => entry.length > 0);

    const isAllowed = allowedRoots.some((root) => absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`));
    if (!isAllowed) {
      throw new ConflictException({ message: `Project workspace is outside allowed roots: ${absolutePath}` });
    }
  }
}
