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
        repoPath: true,
        defaultModel: true,
        defaultSandbox: true,
        defaultApprovalPolicy: true,
      },
    });

    if (!project) {
      throw new NotFoundException({ message: 'Project not found' });
    }

    const cwdOverride = input.cwdOverride?.trim()
      ? (await this.runnerAdapter.ensureDirectory({ path: input.cwdOverride.trim() })).path
      : project.repoPath?.trim() || null;

    const modelOverride = input.modelOverride?.trim() || project.defaultModel?.trim() || null;
    const sandboxOverride = input.sandboxOverride?.trim() || project.defaultSandbox?.trim() || null;
    const approvalPolicyOverride =
      input.approvalPolicyOverride?.trim() || project.defaultApprovalPolicy?.trim() || null;

    return this.prisma.session.create({
      data: {
        projectId,
        title: input.title,
        status: 'active',
        cwdOverride,
        modelOverride,
        sandboxOverride,
        approvalPolicyOverride,
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
        cwdOverride: true,
        modelOverride: true,
        sandboxOverride: true,
        approvalPolicyOverride: true,
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
            requestedCwd: true,
            requestedModel: true,
            requestedSandbox: true,
            requestedApprovalPolicy: true,
            effectiveCwd: true,
            effectiveModel: true,
            effectiveSandbox: true,
            effectiveApprovalPolicy: true,
            failureCode: true,
            failureMessage: true,
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
        cwdOverride: session.cwdOverride,
        modelOverride: session.modelOverride,
        sandboxOverride: session.sandboxOverride,
        approvalPolicyOverride: session.approvalPolicyOverride,
        updatedAt: session.updatedAt,
      },
      messages: session.messages,
      turns: session.turns,
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
        cwdOverride: true,
        modelOverride: true,
        sandboxOverride: true,
        approvalPolicyOverride: true,
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

    const cwd = sourceSession.cwdOverride?.trim() || null;
    const model = sourceSession.modelOverride?.trim() || null;
    const sandbox = sourceSession.sandboxOverride?.trim() || null;
    const approvalPolicy = sourceSession.approvalPolicyOverride?.trim() || null;

    const forked = await this.runnerAdapter.forkThread({
      threadId: sourceSession.codexThreadId,
      cwd,
      model,
      sandbox,
      approvalPolicy,
    });

    const title = input.title?.trim() || `${sourceSession.title} (Fork)`;

    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.create({
        data: {
          projectId: sourceSession.projectId,
          title,
          status: 'active',
          cwdOverride: sourceSession.cwdOverride,
          modelOverride: sourceSession.modelOverride,
          sandboxOverride: sourceSession.sandboxOverride,
          approvalPolicyOverride: sourceSession.approvalPolicyOverride,
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
}
