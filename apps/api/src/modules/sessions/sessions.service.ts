import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { CreateSessionBody } from './sessions.schemas';

const ACTIVE_TURN_STATUSES = new Set(['queued', 'running']);

@Injectable()
export class SessionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProjectsService) private readonly projectsService: ProjectsService,
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
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundException({ message: 'Project not found' });
    }

    return this.prisma.session.create({
      data: {
        projectId,
        title: input.title,
        status: 'active',
        cwdOverride: input.cwdOverride,
        modelOverride: input.modelOverride,
        sandboxOverride: input.sandboxOverride,
        approvalPolicyOverride: input.approvalPolicyOverride,
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
}
