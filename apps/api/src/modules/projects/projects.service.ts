import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';
import { CreateProjectBody } from './projects.schemas';

const ACTIVE_TURN_STATUSES = ['queued', 'running', 'waiting_approval'] as const;

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter,
  ) {}

  async listForUser(userId: string) {
    return this.prisma.project.findMany({
      where: { ownerUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createForUser(userId: string, input: CreateProjectBody) {
    const repoPath = input.repoPath?.trim()
      ? (await this.runnerAdapter.ensureDirectory({ path: input.repoPath.trim() })).path
      : undefined;

    return this.prisma.project.create({
      data: {
        ownerUserId: userId,
        name: input.name,
        repoPath,
        defaultModel: input.defaultModel,
        defaultSandbox: input.defaultSandbox,
        defaultApprovalPolicy: input.defaultApprovalPolicy,
      },
    });
  }

  async getByIdForUser(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ownerUserId: userId,
      },
    });

    if (!project) {
      throw new NotFoundException({ message: 'Project not found' });
    }

    return project;
  }

  async deleteByIdForUser(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ownerUserId: userId,
      },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundException({ message: 'Project not found' });
    }

    const activeTurn = await this.prisma.turn.findFirst({
      where: {
        session: {
          projectId,
        },
        status: {
          in: [...ACTIVE_TURN_STATUSES],
        },
      },
      select: {
        id: true,
      },
    });

    if (activeTurn) {
      throw new ConflictException({
        message: 'Cannot delete project while a turn is active in one of its sessions',
      });
    }

    const sessions = await this.prisma.session.findMany({
      where: {
        projectId,
      },
      select: {
        codexThreadId: true,
      },
    });

    const threadIds = [...new Set(sessions.map((item) => item.codexThreadId?.trim()).filter((item): item is string => !!item))];
    await Promise.all(
      threadIds.map(async (threadId) => {
        try {
          await this.runnerAdapter.closeThread({ threadId });
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.logger.warn(`Failed to close thread ${threadId} during project delete ${projectId}: ${error.message}`);
          } else {
            this.logger.warn(`Failed to close thread ${threadId} during project delete ${projectId}`);
          }
        }
      }),
    );

    await this.prisma.project.delete({
      where: {
        id: projectId,
      },
    });
  }
}
