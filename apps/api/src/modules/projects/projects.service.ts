import * as path from 'node:path';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';
import { CreateProjectBody, UpdateProjectBody } from './projects.schemas';

const ACTIVE_TURN_STATUSES = ['queued', 'running', 'waiting_approval'] as const;
const DEFAULT_WORKSPACE_ROOT_LITERAL = '$HOME/AgentWaypoint/workspaces';
const MAX_AUTO_WORKSPACE_ATTEMPTS = 1024;

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
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { defaultWorkspaceRoot: true },
    });
    if (!user) {
      throw new NotFoundException({ message: 'User not found' });
    }

    const repoPath = input.repoPath?.trim()
      ? (await this.runnerAdapter.ensureDirectory({ path: input.repoPath.trim() })).path
      : await this.createDefaultWorkspaceForProject(input.name, user.defaultWorkspaceRoot);

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

  private async createDefaultWorkspaceForProject(projectName: string, userWorkspaceRoot: string | null): Promise<string> {
    const baseFolderName = toWorkspaceFolderName(projectName);
    const workspaceRoot = resolveWorkspaceRoot(userWorkspaceRoot);

    for (let attempt = 0; attempt < MAX_AUTO_WORKSPACE_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const candidatePath = path.join(workspaceRoot, `${baseFolderName}${suffix}`);
      const ensured = await this.runnerAdapter.ensureDirectory({ path: candidatePath });
      if (ensured.created) {
        return ensured.path;
      }
    }

    throw new ConflictException({
      message: `Unable to allocate a unique workspace under ${workspaceRoot}`,
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

  async updateByIdForUser(userId: string, projectId: string, input: UpdateProjectBody) {
    await this.getByIdForUser(userId, projectId);

    const data: {
      name?: string;
      repoPath?: string | null;
      defaultModel?: string | null;
      defaultSandbox?: string | null;
      defaultApprovalPolicy?: string | null;
    } = {};

    if (typeof input.name === 'string') {
      data.name = input.name.trim();
    }
    if (Object.prototype.hasOwnProperty.call(input, 'repoPath')) {
      data.repoPath = input.repoPath?.trim()
        ? (await this.runnerAdapter.ensureDirectory({ path: input.repoPath.trim() })).path
        : null;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'defaultModel')) {
      data.defaultModel = input.defaultModel?.trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'defaultSandbox')) {
      data.defaultSandbox = input.defaultSandbox?.trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'defaultApprovalPolicy')) {
      data.defaultApprovalPolicy = input.defaultApprovalPolicy?.trim() || null;
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data,
    });
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

function resolveWorkspaceRoot(userWorkspaceRoot: string | null): string {
  const configured = userWorkspaceRoot?.trim() || process.env.DEFAULT_WORKSPACE_ROOT?.trim();
  if (configured) {
    return configured;
  }
  return DEFAULT_WORKSPACE_ROOT_LITERAL;
}

function toWorkspaceFolderName(projectName: string): string {
  const collapsed = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (collapsed.length > 0) {
    return collapsed.slice(0, 80);
  }

  return 'project';
}
