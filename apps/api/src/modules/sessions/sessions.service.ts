import { Prisma } from '@prisma/client';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';
import { CreateSessionBody, ForkSessionBody, UpdateSessionBody } from './sessions.schemas';
import { terminalLifecycle } from '../terminals/terminal-lifecycle';

const ACTIVE_TURN_STATUSES = new Set(['queued', 'running', 'waiting_approval']);
const EXECUTION_MODES = new Set(['read-only', 'safe-write', 'auto-review', 'yolo']);
const HISTORY_TURN_SELECT = {
  id: true,
  status: true,
  backend: true,
  effectiveBackendConfig: true,
  effectiveRuntimeConfig: true,
  contextRemainingRatio: true,
} satisfies Prisma.TurnSelect;

function serializeHistoryTurn(turn: Prisma.TurnGetPayload<{ select: typeof HISTORY_TURN_SELECT }>) {
  return {
    id: turn.id,
    status: turn.status,
    backend: turn.backend,
    effectiveBackendConfig: normalizeJsonRecord(turn.effectiveBackendConfig),
    effectiveRuntimeConfig: normalizeJsonRecord(turn.effectiveRuntimeConfig),
    contextRemainingRatio:
      turn.contextRemainingRatio === null ? null : Number(turn.contextRemainingRatio),
  };
}

type SessionRuntimeConfig = {
  backend: string;
  cwd: string | null;
  backendConfig: Record<string, unknown>;
  autoApprove: boolean;
  autoApproveTimeoutSeconds: number;
};

const DEFAULT_AUTO_APPROVE = false;
const DEFAULT_AUTO_APPROVE_TIMEOUT_SECONDS = 10;

type SessionRuntimeMeta = {
  runtime: SessionRuntimeConfig;
  override: {
    backend?: string;
    cwd?: string;
    backendConfig?: Record<string, unknown>;
  };
};

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
        backend: true,
        repoPath: true,
        backendConfig: true,
      },
    });

    if (!project) {
      throw new NotFoundException({ message: 'Project not found' });
    }

    const normalizedRepoPath = input.repoPath?.trim()
      ? (await this.runnerAdapter.ensureDirectory({ path: input.repoPath.trim() })).path
      : null;

    const meta = buildSessionRuntimeMeta(project, input, normalizedRepoPath);

    return this.prisma.session.create({
      data: {
        projectId,
        title: input.title,
        status: 'active',
        meta: toPrismaJson(meta),
      },
    });
  }

  async getHistoryForSession(
    userId: string,
    sessionId: string,
    query: { before?: number; limit?: number; turnId?: string } = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      const messageTurn = query.turnId
        ? await tx.turn.findFirst({
            where: { id: query.turnId, sessionId, session: { project: { ownerUserId: userId } } },
            select: {
              ...HISTORY_TURN_SELECT,
              userMessageId: true,
              assistantMessageId: true,
              historyVersion: true,
              events: { orderBy: { seq: 'desc' }, take: 1, select: { seq: true } },
            },
          })
        : null;
      if (query.turnId && !messageTurn) {
        throw new NotFoundException({ message: 'Turn not found' });
      }
      const session = await tx.session.findFirst({
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
          meta: true,
          _count: { select: { turns: true } },
          messages: {
            where: {
              ...(query.before ? { historySeq: { lt: query.before } } : {}),
              ...(messageTurn
                ? {
                    OR: [
                      { turnId: messageTurn.id },
                      {
                        id: {
                          in: [messageTurn.userMessageId, messageTurn.assistantMessageId].filter(
                            (id): id is string => Boolean(id),
                          ),
                        },
                      },
                    ],
                  }
                : {}),
            },
            orderBy: [{ historySeq: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            ...(query.limit ? { take: query.limit + 1 } : {}),
            select: {
              id: true,
              role: true,
              content: true,
              createdAt: true,
              turnId: true,
              backendItemId: true,
              historySeq: true,
              state: true,
              phase: true,
              startEventSeq: true,
              endEventSeq: true,
              timelineStartSeq: true,
            },
          },
          turns: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: HISTORY_TURN_SELECT,
          },
        },
      });

      if (!session) {
        throw new NotFoundException({ message: 'Session not found' });
      }

      const hasMore = Boolean(query.limit && session.messages.length > query.limit);
      const messages = (
        query.limit ? session.messages.slice(0, query.limit) : session.messages
      ).reverse();
      const unlinkedIds = messages
        .filter((message) => !message.turnId)
        .map((message) => message.id);
      const activeTurn = await tx.turn.findFirst({
        where: { sessionId, status: { in: [...ACTIVE_TURN_STATUSES] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          ...HISTORY_TURN_SELECT,
          historyVersion: true,
          events: { orderBy: { seq: 'desc' }, take: 1, select: { seq: true } },
        },
      });
      const pendingInputs = await tx.turnInput.findMany({
        where: { turn: { sessionId }, status: { not: 'accepted' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      // Legacy writers did not always store turnId. Resolve only the messages
      // returned on this page; forked messages without an association stay unlinked.
      const linkedTurns = unlinkedIds.length
        ? await tx.turn.findMany({
            where: {
              sessionId,
              OR: [
                { userMessageId: { in: unlinkedIds } },
                { assistantMessageId: { in: unlinkedIds } },
              ],
            },
            select: { id: true, userMessageId: true, assistantMessageId: true },
          })
        : [];
      const turnIdByMessageId = new Map<string, string>();
      for (const turn of linkedTurns) {
        if (turn.userMessageId) turnIdByMessageId.set(turn.userMessageId, turn.id);
        if (turn.assistantMessageId) turnIdByMessageId.set(turn.assistantMessageId, turn.id);
      }
      const latestTurn = session.turns[0];
      return {
        hasMore,
        nextBefore: hasMore ? (messages[0]?.historySeq ?? null) : null,
        pendingInputs,
        turnCount: session._count.turns,
        session: {
          id: session.id,
          projectId: session.projectId,
          title: session.title,
          status: session.status,
          updatedAt: session.updatedAt,
          meta: normalizeJsonRecord(session.meta),
        },
        messages: messages.map((message) => ({
          ...message,
          turnId: message.turnId ?? turnIdByMessageId.get(message.id) ?? null,
        })),
        latestTurn: latestTurn ? serializeHistoryTurn(latestTurn) : null,
        messageTurn: messageTurn
          ? {
              ...serializeHistoryTurn(messageTurn),
              historyVersion: messageTurn.historyVersion,
              eventCursor: messageTurn.events[0]?.seq ?? 0,
            }
          : null,
        activeTurn: activeTurn
          ? {
              ...serializeHistoryTurn(activeTurn),
              historyVersion: activeTurn.historyVersion,
              eventCursor: activeTurn.events[0]?.seq ?? 0,
            }
          : null,
        activeTurnId: activeTurn?.id ?? null,
        activeTurnStatus: activeTurn?.status ?? null,
      };
    });
  }

  async updateByIdForUser(userId: string, sessionId: string, input: UpdateSessionBody) {
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
      },
    });

    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }

    const runtime = readSessionRuntimeForExecution(session.meta);
    const rootMeta = normalizeJsonRecord(session.meta) ?? {};
    const currentOverride = normalizeJsonRecord(rootMeta.override) ?? {};

    if (input.backendConfig) {
      const currentModel = readOptionalString(runtime.backendConfig.model);
      const requestedModel = readOptionalString(input.backendConfig.model);
      if (currentModel && requestedModel && requestedModel !== currentModel) {
        const models = await this.runnerAdapter.listModels({ backend: runtime.backend });
        if (!models.some((model) => model.model === currentModel)) {
          throw new ConflictException({ message: 'Cannot change a session model that is no longer available' });
        }
      }
    }

    const runtimeBackendConfig = resolveRuntimeBackendConfig({
      backend: runtime.backend,
      inherited: runtime.backendConfig,
      override: input.backendConfig,
    });

    const nextAutoApprove =
      typeof input.autoApprove === 'boolean' ? input.autoApprove : runtime.autoApprove;
    const nextAutoApproveTimeoutSeconds =
      typeof input.autoApproveTimeoutSeconds === 'number'
        ? input.autoApproveTimeoutSeconds
        : runtime.autoApproveTimeoutSeconds;

    const nextMeta = {
      ...rootMeta,
      runtime: {
        backend: runtime.backend,
        cwd: runtime.cwd,
        backendConfig: runtimeBackendConfig,
        autoApprove: nextAutoApprove,
        autoApproveTimeoutSeconds: nextAutoApproveTimeoutSeconds,
      },
      override: {
        ...currentOverride,
        ...(input.backendConfig ? { backendConfig: runtimeBackendConfig } : {}),
      },
    };

    return this.prisma.session.update({
      where: { id: sessionId },
      data: {
        title: input.title,
        meta: toPrismaJson(nextMeta),
      },
    });
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
        meta: true,
        backendThreadId: true,
        messages: {
          orderBy: [{ historySeq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
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
    if (!sourceSession.backendThreadId) {
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

    const runtime = readSessionRuntimeForExecution(sourceSession.meta);

    const forked = await this.runnerAdapter.forkThread({
      threadId: sourceSession.backendThreadId,
      backend: runtime.backend,
      backendConfig: runtime.backendConfig,
      cwd: runtime.cwd,
    });

    const title = input.title?.trim() || `${sourceSession.title} (Fork)`;

    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.create({
        data: {
          projectId: sourceSession.projectId,
          title,
          status: 'active',
          meta: toPrismaJson({
            runtime,
            override: {},
          }),
          backendThreadId: forked.threadId,
        },
      });

      if (sourceSession.messages.length > 0) {
        await tx.message.createMany({
          data: sourceSession.messages.map((message, index) => ({
            historySeq: index + 1,
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
    const owned = await this.prisma.session.findFirst({ where: { id: sessionId, project: { ownerUserId: userId } }, select: { projectId: true } });
    if (!owned) throw new NotFoundException({ message: 'Session not found' });
    return terminalLifecycle.withProject(owned.projectId, async () => {
      terminalLifecycle.assertDeletable(owned.projectId, sessionId);
      await this.deleteUnlocked(userId, sessionId);
      terminalLifecycle.discard(owned.projectId, sessionId);
    });
  }

  private async deleteUnlocked(userId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        project: {
          ownerUserId: userId,
        },
      },
      select: {
        id: true,
        backendThreadId: true,
        meta: true,
      },
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

    const threadId = session.backendThreadId?.trim();
    if (threadId) {
      const runtime = readSessionRuntimeForExecution(session.meta);
      try {
        await this.runnerAdapter.closeThread({
          threadId,
          backend: runtime.backend,
          cwd: runtime.cwd,
        });
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
        backendThreadId: true,
        meta: true,
      },
    });

    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }

    const threadId = session.backendThreadId?.trim();
    if (!threadId) {
      throw new ConflictException({ message: 'Session cannot be compacted before the first turn starts' });
    }

    const runtime = readSessionRuntimeForExecution(session.meta);

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
        backend: runtime.backend,
        backendConfig: runtime.backendConfig,
        cwd: runtime.cwd,
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

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBackend(inputBackend: string | undefined | null): string {
  const backend = (inputBackend ?? 'codex').trim().toLowerCase();
  return backend.length > 0 ? backend : 'codex';
}

function buildSessionRuntimeMeta(
  project: { backend: string; repoPath: string | null; backendConfig: Prisma.JsonValue | null },
  input: CreateSessionBody,
  normalizedRepoPath: string | null,
): SessionRuntimeMeta {
  const projectBackend = normalizeBackend(project.backend);
  const projectCwd = project.repoPath?.trim() || null;
  const projectBackendConfig = normalizeJsonRecord(project.backendConfig) ?? {};

  const backendOverride = typeof input.backend === 'string' ? normalizeBackend(input.backend) : undefined;
  const cwdOverride = normalizedRepoPath ?? undefined;
  const backendConfigOverride =
    input.backendConfig && typeof input.backendConfig === 'object' && !Array.isArray(input.backendConfig)
      ? input.backendConfig
      : undefined;

  const runtimeBackend = backendOverride ?? projectBackend;
  const runtimeCwd = cwdOverride ?? projectCwd;
  const runtimeBackendConfig = resolveRuntimeBackendConfig({
    backend: runtimeBackend,
    inherited: projectBackendConfig,
    override: backendConfigOverride,
  });

  const override: SessionRuntimeMeta['override'] = {};
  if (backendOverride) {
    override.backend = backendOverride;
  }
  if (typeof cwdOverride === 'string' && cwdOverride.trim().length > 0) {
    override.cwd = cwdOverride;
  }
  if (backendConfigOverride) {
    override.backendConfig = backendConfigOverride;
  }

  const autoApprove = typeof input.autoApprove === 'boolean' ? input.autoApprove : DEFAULT_AUTO_APPROVE;
  const autoApproveTimeoutSeconds =
    typeof input.autoApproveTimeoutSeconds === 'number'
      ? input.autoApproveTimeoutSeconds
      : DEFAULT_AUTO_APPROVE_TIMEOUT_SECONDS;

  return {
    runtime: {
      backend: runtimeBackend,
      cwd: runtimeCwd,
      backendConfig: runtimeBackendConfig,
      autoApprove,
      autoApproveTimeoutSeconds,
    },
    override,
  };
}

function resolveRuntimeBackendConfig(input: {
  backend: string;
  inherited: Record<string, unknown>;
  override: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const merged = {
    ...input.inherited,
    ...(input.override ?? {}),
  };

  if (input.backend === 'codex' || input.backend === 'claude') {
    const model = typeof merged.model === 'string' ? merged.model.trim() : '';
    const executionMode = typeof merged.executionMode === 'string' ? merged.executionMode.trim() : '';
    const effort = typeof merged.effort === 'string' ? merged.effort.trim() : '';
    if (!model || !EXECUTION_MODES.has(executionMode)) {
      throw new ConflictException({
        message: `Session runtime for backend ${input.backend} requires backendConfig.model and backendConfig.executionMode`,
      });
    }
    if (typeof merged.effort !== 'undefined' && !effort) {
      throw new ConflictException({
        message: `Session runtime for backend ${input.backend} requires backendConfig.effort to be a non-empty string`,
      });
    }
    return {
      ...merged,
      model,
      executionMode,
      ...(effort ? { effort } : {}),
    };
  }

  return merged;
}

function readSessionRuntimeForExecution(meta: unknown): SessionRuntimeConfig {
  const root = normalizeJsonRecord(meta);
  const runtimeRecord = normalizeJsonRecord(root?.runtime);
  if (!runtimeRecord) {
    throw new ConflictException({
      message: 'Session runtime metadata is missing. Please recreate the session.',
    });
  }

  const backend = typeof runtimeRecord.backend === 'string' ? runtimeRecord.backend.trim().toLowerCase() : '';
  if (!backend) {
    throw new ConflictException({
      message: 'Session runtime backend is missing. Please recreate the session.',
    });
  }

  const cwd = typeof runtimeRecord.cwd === 'string' && runtimeRecord.cwd.trim().length > 0 ? runtimeRecord.cwd.trim() : null;
  const backendConfig = normalizeJsonRecord(runtimeRecord.backendConfig) ?? {};

  const normalizedBackendConfig = resolveRuntimeBackendConfig({
    backend,
    inherited: {},
    override: backendConfig,
  });

  return {
    backend,
    cwd,
    backendConfig: normalizedBackendConfig,
    autoApprove: typeof runtimeRecord.autoApprove === 'boolean' ? runtimeRecord.autoApprove : DEFAULT_AUTO_APPROVE,
    autoApproveTimeoutSeconds:
      typeof runtimeRecord.autoApproveTimeoutSeconds === 'number' &&
      Number.isFinite(runtimeRecord.autoApproveTimeoutSeconds) &&
      runtimeRecord.autoApproveTimeoutSeconds >= 0
        ? Math.floor(runtimeRecord.autoApproveTimeoutSeconds)
        : DEFAULT_AUTO_APPROVE_TIMEOUT_SECONDS,
  };
}

export {
  readSessionRuntimeForExecution,
  DEFAULT_AUTO_APPROVE,
  DEFAULT_AUTO_APPROVE_TIMEOUT_SECONDS,
};
export type { SessionRuntimeConfig };

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
