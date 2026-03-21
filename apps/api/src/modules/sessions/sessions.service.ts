import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';
import { CreateSessionBody, ForkSessionBody } from './sessions.schemas';

const ACTIVE_TURN_STATUSES = new Set(['queued', 'running', 'waiting_approval']);

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProjectsService) private readonly projectsService: ProjectsService,
    @Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter,
  ) {}

  async listForProject(userId: string, projectId: string) {
    await this.projectsService.getByIdForUser(userId, projectId);

    return this.prisma.session.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async createForProject(userId: string, projectId: string, input: CreateSessionBody) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ownerUserId: userId,
      },
      select: {
        id: true,
      },
    });

    if (!project) {
      throw new NotFoundException({ message: 'Project not found' });
    }

    return this.prisma.session.create({
      data: {
        projectId,
        title: input.title,
        status: 'active',
      },
    });
  }

  async getHistoryForSession(userId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        project: {
          ownerUserId: userId,
        },
      },
      select: {
        id: true,
        projectId: true,
        title: true,
        status: true,
        updatedAt: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            role: true,
            content: true,
            createdAt: true,
          },
        },
        turns: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            status: true,
            backend: true,
            requestedBackendConfig: true,
            effectiveBackendConfig: true,
            effectiveRuntimeConfig: true,
            failureCode: true,
            failureMessage: true,
            contextRemainingRatio: true,
            contextRemainingTokens: true,
            contextWindowTokens: true,
            contextUpdatedAt: true,
            userMessageId: true,
            assistantMessageId: true,
            createdAt: true,
            startedAt: true,
            endedAt: true,
          },
        },
      },
    });

    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }

    const activeTurn = [...session.turns].reverse().find((turn) => ACTIVE_TURN_STATUSES.has(turn.status));

    return {
      session: {
        id: session.id,
        projectId: session.projectId,
        title: session.title,
        status: session.status,
        updatedAt: session.updatedAt,
      },
      messages: session.messages,
      turns: session.turns.map((turn) => ({
        ...turn,
        requestedBackendConfig: normalizeJsonRecord(turn.requestedBackendConfig),
        effectiveBackendConfig: normalizeJsonRecord(turn.effectiveBackendConfig),
        effectiveRuntimeConfig: normalizeJsonRecord(turn.effectiveRuntimeConfig),
        contextRemainingRatio:
          turn.contextRemainingRatio === null ? null : Number(turn.contextRemainingRatio),
      })),
      activeTurnId: activeTurn?.id ?? null,
      activeTurnStatus: activeTurn?.status ?? null,
    };
  }

  async forkSessionForUser(userId: string, sessionId: string, input: ForkSessionBody) {
    const sourceSession = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        project: {
          ownerUserId: userId,
        },
      },
      select: {
        id: true,
        projectId: true,
        title: true,
        codexThreadId: true,
        project: {
          select: {
            repoPath: true,
            backend: true,
            backendConfig: true,
          },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            role: true,
            content: true,
            tokenCount: true,
            createdAt: true,
          },
        },
      },
    });

    if (!sourceSession) {
      throw new NotFoundException({ message: 'Session not found' });
    }
    if (!sourceSession.codexThreadId) {
      throw new ConflictException({ message: 'Session cannot be forked before the first turn starts' });
    }

    const activeTurn = await this.prisma.turn.findFirst({
      where: {
        sessionId,
        status: { in: [...ACTIVE_TURN_STATUSES] },
      },
      select: { id: true },
    });
    if (activeTurn) {
      throw new ConflictException({ message: 'Cannot fork a session while a turn is active' });
    }

    const cwd = sourceSession.project.repoPath?.trim() || null;
    const backend = sourceSession.project.backend?.trim() || null;
    const backendConfig =
      sourceSession.project.backendConfig &&
      typeof sourceSession.project.backendConfig === 'object' &&
      !Array.isArray(sourceSession.project.backendConfig)
        ? (sourceSession.project.backendConfig as Record<string, unknown>)
        : null;

    const forked = await this.runnerAdapter.forkThread({
      threadId: sourceSession.codexThreadId,
      backend,
      backendConfig,
      cwd,
    });

    const title = input.title?.trim() || `${sourceSession.title} (Fork)`;

    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.create({
        data: {
          projectId: sourceSession.projectId,
          title,
          status: 'active',
          codexThreadId: forked.threadId,
        },
      });

      if (sourceSession.messages.length > 0) {
        await tx.message.createMany({
          data: sourceSession.messages.map((message) => ({
            sessionId: session.id,
            role: message.role,
            content: message.content,
            tokenCount: message.tokenCount,
            createdAt: message.createdAt,
          })),
        });
      }

      return session;
    });
  }

  async deleteByIdForUser(userId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        project: {
          ownerUserId: userId,
        },
      },
      select: { id: true, codexThreadId: true },
    });

    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }

    const activeTurn = await this.prisma.turn.findFirst({
      where: {
        sessionId,
        status: {
          in: [...ACTIVE_TURN_STATUSES],
        },
      },
      select: { id: true },
    });

    if (activeTurn) {
      throw new ConflictException({ message: 'Cannot delete session while a turn is active' });
    }

    const threadId = session.codexThreadId?.trim();
    if (threadId) {
      try {
        await this.runnerAdapter.closeThread({ threadId });
      } catch (error: unknown) {
        if (error instanceof Error) {
          this.logger.warn(`Failed to close thread ${threadId} during session delete ${sessionId}: ${error.message}`);
        } else {
          this.logger.warn(`Failed to close thread ${threadId} during session delete ${sessionId}`);
        }
      }
    }

    await this.prisma.session.delete({
      where: {
        id: sessionId,
      },
    });
  }

  async compactSessionForUser(userId: string, sessionId: string): Promise<{ accepted: true }> {
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

    const threadId = session.codexThreadId?.trim();
    if (!threadId) {
      throw new ConflictException({ message: 'Session cannot be compacted before the first turn starts' });
    }
    const cwd = session.project.repoPath?.trim() || null;
    const backend = session.project.backend?.trim() || null;
    const backendConfig =
      session.project.backendConfig &&
      typeof session.project.backendConfig === 'object' &&
      !Array.isArray(session.project.backendConfig)
        ? (session.project.backendConfig as Record<string, unknown>)
        : null;

    const activeTurn = await this.prisma.turn.findFirst({
      where: {
        sessionId,
        status: {
          in: [...ACTIVE_TURN_STATUSES],
        },
      },
      select: { id: true },
    });

    if (activeTurn) {
      throw new ConflictException({ message: 'Cannot compact a session while a turn is active' });
    }

    try {
      await this.runnerAdapter.compactThread({
        threadId,
        backend,
        backendConfig,
        cwd,
      });

      const latestTurn = await this.prisma.turn.findFirst({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          contextWindowTokens: true,
          contextRemainingTokens: true,
        },
      });
      if (latestTurn) {
        await this.prisma.turn.update({
          where: { id: latestTurn.id },
          data: {
            contextRemainingRatio: 1,
            contextRemainingTokens: latestTurn.contextWindowTokens ?? latestTurn.contextRemainingTokens ?? null,
            contextUpdatedAt: new Date(),
          },
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to compact session context';
      if (message.toLowerCase().includes('thread not found')) {
        throw new ConflictException({
          message: 'Session context is no longer available in runner memory. Start a new turn to recreate it.',
        });
      }
      throw new ConflictException({ message });
    }
    return { accepted: true };
  }
}

function normalizeJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
