import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CodexRateLimits,
  AvailableSkill,
  AvailableModel,
  CancelTurnInput,
  CloseThreadInput,
  CompactThreadInput,
  EnsureDirectoryInput,
  EnsureDirectoryResult,
  ForkThreadInput,
  ForkThreadResult,
  ModelListInput,
  ResolveTurnApprovalInput,
  SkillListInput,
  RunnerStreamEvent,
  RunnerAdapter,
  SteerTurnInput,
  StartTurnInput,
  WorkspaceFileContentInput,
  WorkspaceFileContentResult,
  WorkspaceFileInput,
  WorkspaceFileResult,
  WorkspaceUploadInput,
  WorkspaceUploadResult,
  WorkspaceTreeEntry,
  WorkspaceTreeInput,
  WorkspaceSuggestionInput,
} from './runner.types';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const WORKSPACE_FILE_MAX_SIZE_BYTES = 10 * 1024 * 1024;

@Injectable()
export class MockRunnerAdapter implements RunnerAdapter {
  private readonly logger = new Logger(MockRunnerAdapter.name);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>[]>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async startTurn(input: StartTurnInput): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: input.turnId },
      select: { status: true },
    });
    if (!turn || TERMINAL_STATUSES.has(turn.status)) {
      return;
    }

    const backendConfig =
      input.backendConfig && typeof input.backendConfig === 'object' && !Array.isArray(input.backendConfig)
        ? input.backendConfig
        : null;
    const model = readOptionalString(backendConfig?.model);
    const executionMode = readOptionalString(backendConfig?.executionMode) ?? 'safe-write';
    const runtimeConfig = mapExecutionModeToRuntime(executionMode);

    await this.prisma.turn.update({
      where: { id: input.turnId },
      data: {
        status: 'running',
        startedAt: new Date(),
        effectiveBackendConfig: buildEffectiveBackendConfig({
          cwd: input.cwd,
          model,
          executionMode,
        }),
        effectiveRuntimeConfig: buildEffectiveRuntimeConfig({
          cwd: input.cwd,
          model,
          sandbox: runtimeConfig.sandbox,
          approvalPolicy: runtimeConfig.approvalPolicy,
        }),
      },
    });
    const threadId = `mock-thread-${input.sessionId}`;
    await this.appendEvent(input.turnId, 'turn.started', {
      threadId,
      ...(model ? { model } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(runtimeConfig.sandbox ? { sandbox: runtimeConfig.sandbox } : {}),
      ...(runtimeConfig.approvalPolicy ? { approvalPolicy: runtimeConfig.approvalPolicy } : {}),
    });

    const assistantText = `Echo: ${input.content}`;
    const chunks = chunkText(assistantText, 12);
    const scheduled: ReturnType<typeof setTimeout>[] = [];

    chunks.forEach((chunk, index) => {
      const timer = setTimeout(() => {
        void this.handleDelta(input.turnId, chunk).catch((error: unknown) => {
          this.logError('Failed to emit assistant delta event', error);
        });
      }, 120 + index * 120);
      scheduled.push(timer);
    });

    const finalizeDelay = 200 + chunks.length * 120;
    const finalizeTimer = setTimeout(() => {
      void this.finalizeTurn(input.turnId, assistantText).catch((error: unknown) => {
        this.logError('Failed to finalize turn', error);
      });
    }, finalizeDelay);
    scheduled.push(finalizeTimer);

    // Keep track so cancel can interrupt in-flight mock execution.
    this.timers.set(input.turnId, scheduled);
  }

  async consumeTurnEvents(
    _input: { turnId: string; sinceSeq?: number },
    _onEvent: (event: RunnerStreamEvent) => Promise<void>,
  ): Promise<void> {
    return;
  }

  async cancelTurn(input: CancelTurnInput): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: input.turnId },
      select: { status: true, sessionId: true },
    });
    if (!turn || TERMINAL_STATUSES.has(turn.status)) {
      return;
    }

    this.clearTurnTimers(input.turnId);
    await this.prisma.$transaction(async (tx) => {
      const assistantContent = await collectAssistantDeltaContent(tx, input.turnId);
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
        where: { id: input.turnId },
        data: {
          assistantMessageId: assistantMessage?.id,
          status: 'cancelled',
          endedAt: new Date(),
        },
      });
    });
    await this.appendEvent(input.turnId, 'turn.cancelled', {});
  }

  async steerTurn(input: SteerTurnInput): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: input.turnId },
      select: { status: true },
    });
    if (!turn || TERMINAL_STATUSES.has(turn.status)) {
      return;
    }

    await this.appendEvent(input.turnId, 'assistant.delta', { text: `\n[steer] ${input.content}` });
  }

  async resolveTurnApproval(input: ResolveTurnApprovalInput): Promise<void> {
    throw new Error(`Mock runner does not support approvals for turn ${input.turnId}`);
  }

  async readCodexRateLimits(): Promise<CodexRateLimits> {
    return {
      rateLimits: null,
      rateLimitsByLimitId: null,
    };
  }

  async listModels(input: ModelListInput): Promise<AvailableModel[]> {
    const requestedBackend = typeof input.backend === 'string' ? input.backend.trim().toLowerCase() : '';
    if (requestedBackend && requestedBackend !== 'mock' && requestedBackend !== 'codex') {
      return [];
    }
    const configuredModel = process.env.RUNNER_CODEX_MODEL?.trim() || 'gpt-5-codex';
    return [
      {
        id: configuredModel,
        backend: requestedBackend || 'mock',
        model: configuredModel,
        displayName: configuredModel,
        description: 'Configured mock/default model',
        hidden: false,
        isDefault: true,
      },
    ];
  }

  async listSkills(_input: SkillListInput): Promise<AvailableSkill[]> {
    return [];
  }

  async forkThread(input: ForkThreadInput): Promise<ForkThreadResult> {
    if (!input.threadId.trim()) {
      throw new Error('Source thread is required');
    }
    return { threadId: `mock-fork-${randomUUID()}` };
  }

  async closeThread(_input: CloseThreadInput): Promise<void> {
    return;
  }

  async compactThread(_input: CompactThreadInput): Promise<void> {
    return;
  }

  async ensureDirectory(input: EnsureDirectoryInput): Promise<EnsureDirectoryResult> {
    const absolutePath = path.resolve(expandHomeToken(input.path));
    try {
      const info = await stat(absolutePath);
      if (!info.isDirectory()) {
        throw new Error(`Project workspace is not a directory: ${absolutePath}`);
      }
      return {
        path: absolutePath,
        created: false,
      };
    } catch (error: unknown) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }

    await mkdir(absolutePath, { recursive: true });
    return {
      path: absolutePath,
      created: true,
    };
  }

  async suggestWorkspaceDirectories(input: WorkspaceSuggestionInput): Promise<string[]> {
    const sanitizedLimit = Number.isFinite(input.limit) ? Math.min(Math.max(Math.trunc(input.limit ?? 12), 1), 50) : 12;
    const prefix = input.prefix.trim();
    const resolvedPrefix = path.resolve(expandHomeToken(prefix.length > 0 ? prefix : '.'));
    const hasTrailingSeparator = /[\\/]+$/.test(prefix);
    const scanDirectory = hasTrailingSeparator ? resolvedPrefix : path.dirname(resolvedPrefix);
    const segmentPrefix = hasTrailingSeparator ? '' : path.basename(resolvedPrefix);

    let entries;
    try {
      entries = await readdir(scanDirectory, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(segmentPrefix))
      .map((entry) => path.join(scanDirectory, entry.name))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, sanitizedLimit);
  }

  async listWorkspaceTree(input: WorkspaceTreeInput): Promise<WorkspaceTreeEntry[]> {
    const absolutePath = path.resolve(expandHomeToken(input.path.trim()));
    const limit = Number.isFinite(input.limit) ? Math.min(Math.max(Math.trunc(input.limit ?? 200), 1), 500) : 200;
    const entries = await readdir(absolutePath, { withFileTypes: true, encoding: 'utf8' });
    const resolvedEntries = await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map(async (entry) => {
          const entryPath = path.join(absolutePath, entry.name);
          let isDirectory = entry.isDirectory();
          if (!isDirectory && entry.isSymbolicLink()) {
            try {
              isDirectory = (await stat(entryPath)).isDirectory();
            } catch {
              isDirectory = false;
            }
          }
          return {
            name: entry.name,
            path: entryPath,
            isDirectory,
          };
        }),
    );

    return resolvedEntries
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit);
  }

  async readWorkspaceFile(input: WorkspaceFileInput): Promise<WorkspaceFileResult> {
    const absolutePath = path.resolve(expandHomeToken(input.path.trim()));
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      throw new Error(`Path is not a file: ${absolutePath}`);
    }
    if (info.size > WORKSPACE_FILE_MAX_SIZE_BYTES) {
      throw new Error(`File is too large to preview (>10MB): ${absolutePath}`);
    }
    const maxBytes = Number.isFinite(input.maxBytes)
      ? Math.min(Math.max(Math.trunc(input.maxBytes ?? 256 * 1024), 1024), 1024 * 1024)
      : 256 * 1024;
    const contentBuffer = await readFile(absolutePath);
    if (contentBuffer.includes(0)) {
      throw new Error(`File appears to be binary and cannot be previewed: ${absolutePath}`);
    }
    const truncated = contentBuffer.length > maxBytes;
    const text = (truncated ? contentBuffer.subarray(0, maxBytes) : contentBuffer).toString('utf8');
    return {
      path: absolutePath,
      content: text,
      truncated,
    };
  }

  async readWorkspaceFileContent(input: WorkspaceFileContentInput): Promise<WorkspaceFileContentResult> {
    const absolutePath = path.resolve(expandHomeToken(input.path.trim()));
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      throw new Error(`Path is not a file: ${absolutePath}`);
    }
    if (info.size > WORKSPACE_FILE_MAX_SIZE_BYTES) {
      throw new Error(`File is too large to preview (>10MB): ${absolutePath}`);
    }
    return {
      path: absolutePath,
      content: await readFile(absolutePath),
      mimeType: resolveMimeTypeFromPath(absolutePath),
    };
  }

  async uploadWorkspaceFile(_input: WorkspaceUploadInput): Promise<WorkspaceUploadResult> {
    throw new Error('Workspace file upload is unavailable in mock runner mode');
  }

  private async handleDelta(turnId: string, chunk: string): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: { status: true },
    });
    if (!turn || TERMINAL_STATUSES.has(turn.status)) {
      return;
    }

    await this.appendEvent(turnId, 'assistant.delta', { text: chunk });
  }

  private async finalizeTurn(turnId: string, content: string): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: { status: true, sessionId: true },
    });
    if (!turn || TERMINAL_STATUSES.has(turn.status)) {
      this.clearTurnTimers(turnId);
      return;
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
        },
      });
    });

    await this.appendEvent(turnId, 'turn.completed', {});
    this.clearTurnTimers(turnId);
  }

  private async appendEvent(turnId: string, type: string, payload: Prisma.InputJsonValue): Promise<void> {
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

  private clearTurnTimers(turnId: string): void {
    const pending = this.timers.get(turnId);
    if (!pending) {
      return;
    }
    pending.forEach((timer) => clearTimeout(timer));
    this.timers.delete(turnId);
  }

  private logError(message: string, error: unknown): void {
    if (error instanceof Error) {
      this.logger.error(message, error.stack);
      return;
    }
    this.logger.error(message);
  }
}

function mapExecutionModeToRuntime(executionMode: string): { sandbox: string; approvalPolicy: string } {
  if (executionMode === 'read-only') {
    return { sandbox: 'read-only', approvalPolicy: 'on-request' };
  }
  if (executionMode === 'yolo') {
    return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
  }
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
}

function buildEffectiveRuntimeConfig(input: {
  cwd?: string | null;
  model?: string | null;
  sandbox?: string | null;
  approvalPolicy?: string | null;
}): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  const payload: Record<string, unknown> = {};
  if (typeof input.cwd === 'string' && input.cwd.trim().length > 0) {
    payload.cwd = input.cwd.trim();
  }
  if (typeof input.model === 'string' && input.model.trim().length > 0) {
    payload.model = input.model.trim();
  }
  if (typeof input.sandbox === 'string' && input.sandbox.trim().length > 0) {
    payload.sandbox = input.sandbox.trim();
  }
  if (typeof input.approvalPolicy === 'string' && input.approvalPolicy.trim().length > 0) {
    payload.approvalPolicy = input.approvalPolicy.trim();
  }
  if (Object.keys(payload).length === 0) {
    return Prisma.JsonNull;
  }
  return payload as Prisma.InputJsonValue;
}

function buildEffectiveBackendConfig(input: {
  cwd?: string | null;
  model?: string | null;
  executionMode?: string | null;
}): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  const payload: Record<string, unknown> = {};
  if (typeof input.cwd === 'string' && input.cwd.trim().length > 0) {
    payload.cwd = input.cwd.trim();
  }
  if (typeof input.model === 'string' && input.model.trim().length > 0) {
    payload.model = input.model.trim();
  }
  if (typeof input.executionMode === 'string' && input.executionMode.trim().length > 0) {
    payload.executionMode = input.executionMode.trim();
  }
  if (Object.keys(payload).length === 0) {
    return Prisma.JsonNull;
  }
  return payload as Prisma.InputJsonValue;
}

function expandHomeToken(inputPath: string): string {
  const homePath = process.env.HOME?.trim() || homedir().trim();
  if (!homePath) {
    return inputPath;
  }

  if (inputPath === '~' || inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(homePath, inputPath.slice(1));
  }
  if (
    inputPath === '$HOME' ||
    inputPath.startsWith(`$HOME${path.sep}`) ||
    inputPath.startsWith('$HOME/') ||
    inputPath.startsWith('$HOME\\')
  ) {
    return path.join(homePath, inputPath.slice('$HOME'.length));
  }

  return inputPath;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code === 'ENOENT'
  );
}

function chunkText(text: string, size: number): string[] {
  if (!text) {
    return [''];
  }

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

async function collectAssistantDeltaContent(tx: Prisma.TransactionClient, turnId: string): Promise<string> {
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
  return deltaEvents
    .map((event) => extractAssistantDeltaText(event.payload))
    .filter((text) => text.length > 0)
    .join('');
}

function extractAssistantDeltaText(payload: Prisma.JsonValue): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  const text = (payload as Record<string, unknown>).text;
  return typeof text === 'string' ? text : '';
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}
