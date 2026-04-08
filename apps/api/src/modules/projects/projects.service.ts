import * as path from 'node:path';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';
import { buildCodexBackendConfig, readCodexBackendConfigWithFallback } from './project-backend-config';
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
    const backend = normalizeBackend(input.backend);
    const backendConfig = normalizeBackendConfigForWrite(resolveBackendConfigForCreate(backend, input.backendConfig));

    return this.prisma.project.create({
      data: {
        ownerUserId: userId,
        name: input.name,
        repoPath,
        backend,
        backendConfig,
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
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ownerUserId: userId,
      },
    });
    if (!project) {
      throw new NotFoundException({ message: 'Project not found' });
    }

    const data: {
      name?: string;
      repoPath?: string | null;
      backend?: string;
      backendConfig?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
    } = {};

    if (typeof input.name === 'string') {
      data.name = input.name.trim();
    }
    if (Object.prototype.hasOwnProperty.call(input, 'repoPath')) {
      data.repoPath = input.repoPath?.trim()
        ? (await this.runnerAdapter.ensureDirectory({ path: input.repoPath.trim() })).path
        : null;
    }
    const resolvedBackend = typeof input.backend === 'string' ? normalizeBackend(input.backend) : project.backend;
    const backendSwitchRequested = typeof input.backend === 'string' && resolvedBackend !== project.backend;
    if (backendSwitchRequested) {
      const sessionCount = await this.prisma.session.count({
        where: {
          projectId: project.id,
        },
      });
      if (sessionCount > 0) {
        throw new ConflictException({
          message: 'Cannot change backend for a project that already has sessions',
        });
      }
    }
    if (typeof input.backend === 'string') {
      data.backend = resolvedBackend;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'backendConfig')) {
      const resolvedConfig = resolveBackendConfigForCreate(
        resolvedBackend,
        (input.backendConfig as Record<string, unknown> | undefined) ?? {},
      );
      data.backendConfig = normalizeBackendConfigForWrite(resolvedConfig);
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
      select: {
        id: true,
      },
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
        id: true,
        backendThreadId: true,
        meta: true,
      },
    });

    const closable = sessions
      .map((session) => {
        const threadId = session.backendThreadId?.trim() || null;
        if (!threadId) {
          return null;
        }
        const runtime = readRuntimeFromSessionMeta(session.meta);
        return {
          sessionId: session.id,
          threadId,
          backend: runtime.backend,
          cwd: runtime.cwd,
        };
      })
      .filter((entry): entry is { sessionId: string; threadId: string; backend: string | null; cwd: string | null } => !!entry);

    await Promise.all(
      closable.map(async (entry) => {
        try {
          await this.runnerAdapter.closeThread({
            threadId: entry.threadId,
            backend: entry.backend,
            cwd: entry.cwd,
          });
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.logger.warn(`Failed to close thread ${entry.threadId} during project delete ${projectId}: ${error.message}`);
          } else {
            this.logger.warn(`Failed to close thread ${entry.threadId} during project delete ${projectId}`);
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

function normalizeBackend(inputBackend: string | undefined): string {
  const backend = (inputBackend ?? 'codex').trim().toLowerCase();
  if (!backend) {
    return 'codex';
  }
  return backend;
}

function normalizeBackendConfigForWrite(
  backendConfig: Record<string, unknown>,
): Prisma.InputJsonValue {
  return backendConfig as Prisma.InputJsonValue;
}

function resolveBackendConfigForCreate(
  backend: string,
  inputConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (backend !== 'codex') {
    return inputConfig ?? {};
  }
  const codexConfig = readCodexBackendConfigWithFallback(inputConfig);
  return buildCodexBackendConfig(codexConfig);
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

function readRuntimeFromSessionMeta(meta: Prisma.JsonValue | null): { backend: string | null; cwd: string | null } {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { backend: null, cwd: null };
  }
  const root = meta as Record<string, unknown>;
  const runtimeValue = root.runtime;
  if (!runtimeValue || typeof runtimeValue !== 'object' || Array.isArray(runtimeValue)) {
    return { backend: null, cwd: null };
  }
  const runtime = runtimeValue as Record<string, unknown>;
  const backend =
    typeof runtime.backend === 'string' && runtime.backend.trim().length > 0 ? runtime.backend.trim() : null;
  const cwd = typeof runtime.cwd === 'string' && runtime.cwd.trim().length > 0 ? runtime.cwd.trim() : null;
  return { backend, cwd };
}
