import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Busboy from 'busboy';
import { ClaudeBackend } from './claude-backend.js';
import { CodexBackend } from './codex-backend.js';
import { FilesystemBackend } from './filesystem-backend.js';
import type {
  ActiveMockTurn,
  ActiveTurn,
  BufferedRunnerEvent,
  RunnerBackend,
  RunnerEventType,
  RunnerStreamListener,
  RunnerTurnStreamState,
  StartTurnBody,
} from './types.js';
import type {
  AvailableModel,
  AvailableSkill,
  CancelTurnInput,
  CloseThreadInput,
  CodexRateLimits,
  CompactThreadInput,
  EnsureDirectoryInput,
  EnsureDirectoryResult,
  ForkThreadInput,
  ForkThreadResult,
  ModelListInput,
  RateLimitSnapshot,
  RateLimitWindow,
  ResolveTurnApprovalInput,
  RunnerHealth,
  RunnerStreamEvent,
  SkillListInput,
  StartTurnInput,
  SteerTurnInput,
  WorkspaceFileContentInput,
  WorkspaceFileContentResult,
  WorkspaceFileInput,
  WorkspaceFileResult,
  WorkspaceSuggestionInput,
  WorkspaceTreeEntry,
  WorkspaceTreeInput,
  WorkspaceUploadInput,
  WorkspaceUploadResult,
} from '../runner.types';

const ALL_RUNNER_BACKENDS: RunnerBackend[] = ['codex', 'claude', 'mock'];
const DEFAULT_RUNNER_BACKEND: RunnerBackend = 'codex';

@Injectable()
export class EmbeddedRunnerService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddedRunnerService.name);

  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly turnStreams = new Map<string, RunnerTurnStreamState>();

  private readonly supportedBackends: RunnerBackend[];
  private readonly codexDefaultCwd: string;
  private readonly codexDefaultModel: string | null;
  private readonly runnerEventRetentionMs: number;
  private readonly runnerEventBufferLimit: number;

  private readonly codexBackend: CodexBackend;
  private readonly claudeBackend: ClaudeBackend;
  private readonly filesystemBackend: FilesystemBackend;

  constructor() {
    this.supportedBackends = parseSupportedBackends(process.env.RUNNER_SUPPORTED_BACKENDS);
    const codexBin = process.env.RUNNER_CODEX_BIN?.trim() || 'codex';
    this.codexDefaultCwd = process.env.RUNNER_CODEX_CWD?.trim() || process.cwd();
    this.codexDefaultModel = process.env.RUNNER_CODEX_MODEL?.trim() || null;
    const codexApprovalPolicy = process.env.RUNNER_CODEX_APPROVAL_POLICY?.trim() || 'never';
    const codexSandboxMode = process.env.RUNNER_CODEX_SANDBOX?.trim() || null;
    this.runnerEventRetentionMs = Number(process.env.RUNNER_EVENT_RETENTION_MS ?? 5 * 60 * 1000);
    this.runnerEventBufferLimit = Number(process.env.RUNNER_EVENT_BUFFER_LIMIT ?? 1000);

    this.filesystemBackend = new FilesystemBackend({
      allowedRepoRoots: process.env.RUNNER_ALLOWED_REPO_ROOTS?.trim() || null,
    });

    const appendTurnEvent = (turnId: string, type: RunnerEventType, payload: Record<string, unknown>) =>
      this.appendTurnEvent(turnId, type, payload);
    const finalizeTurn = (turnId: string, type: RunnerEventType, payload: Record<string, unknown>) =>
      this.finalizeTurn(turnId, type, payload);
    const failTurn = (turnId: string, message: string) => this.failTurn(turnId, message);

    this.codexBackend = new CodexBackend(
      {
        codexBin,
        codexDefaultCwd: this.codexDefaultCwd,
        codexDefaultModel: this.codexDefaultModel,
        codexApprovalPolicy,
        codexSandboxMode,
      },
      {
        activeTurns: this.activeTurns,
        appendTurnEvent,
        finalizeTurn,
        failTurn,
      },
    );

    this.claudeBackend = new ClaudeBackend({
      activeTurns: this.activeTurns,
      appendTurnEvent,
      finalizeTurn,
      failTurn,
    });
  }

  onModuleInit(): void {
    this.logger.log(`Embedded runner ready (supportedBackends=${this.supportedBackends.join(',')})`);
  }

  // -- Adapter-aligned API ---------------------------------------------------

  async startTurn(input: StartTurnInput): Promise<void> {
    const payload: StartTurnBody = {
      turnId: input.turnId,
      sessionId: input.sessionId,
      content: input.content,
      backend: input.backend ?? null,
      backendConfig: input.backendConfig ?? null,
      threadId: input.threadId ?? null,
      cwd: input.cwd ?? null,
    };
    payload.cwd = await this.filesystemBackend.resolveWorkspaceCwd(payload.cwd);

    const requestedBackend = this.resolveRequestedBackend(payload.backend, 'backend');
    const existing = this.activeTurns.get(payload.turnId);
    if (existing) {
      await this.cancelActiveTurn(existing, { emitCancelEvent: false });
    }

    if (requestedBackend === 'mock') {
      const turn: ActiveMockTurn = {
        backend: 'mock',
        turnId: payload.turnId,
        sessionId: payload.sessionId,
        content: payload.content,
        startedAt: new Date().toISOString(),
        finalized: false,
        timers: [],
      };
      this.activeTurns.set(payload.turnId, turn);
      this.ensureTurnStreamState(payload.turnId, payload.sessionId, 'queued');
      void this.startMockExecution(turn);
      return;
    }

    if (requestedBackend === 'claude') {
      this.ensureTurnStreamState(payload.turnId, payload.sessionId, 'queued');
      void this.claudeBackend.startTurn(payload);
      return;
    }

    if (requestedBackend !== 'codex') {
      throw new Error(`Unsupported backend: ${requestedBackend}`);
    }
    this.ensureTurnStreamState(payload.turnId, payload.sessionId, 'queued');
    void this.codexBackend.startTurn(payload);
  }

  async consumeTurnEvents(
    input: { turnId: string; sinceSeq?: number },
    onEvent: (event: RunnerStreamEvent) => Promise<void>,
  ): Promise<void> {
    const streamState = this.turnStreams.get(input.turnId);
    if (!streamState) {
      throw new Error(`Turn not found: ${input.turnId}`);
    }
    const since = Math.max(input.sinceSeq ?? 0, 0);

    for (const event of streamState.events) {
      if (event.seq > since) {
        await onEvent(event);
      }
    }

    if (isTerminalStatus(streamState.status)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        const latest = this.turnStreams.get(input.turnId);
        if (latest && isTerminalStatus(latest.status)) {
          settled = true;
          streamState.listeners.delete(listener);
          resolve();
        }
      };

      // Returning a Promise from the listener makes `await listener(event)` in
      // appendTurnEvent block until persistence completes. This both preserves
      // arrival order (one event at a time per listener) and backpressures the
      // upstream backend if onEvent is slow — matching how the HTTP adapter's
      // SSE reader naturally serialized events.
      const listener: RunnerStreamListener = async (event) => {
        if (settled) return;
        try {
          await onEvent(event);
        } catch (error: unknown) {
          if (settled) return;
          settled = true;
          streamState.listeners.delete(listener);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        finish();
      };

      streamState.listeners.add(listener);

      // Edge-case: state may already have finalized between buffer replay and listener registration.
      finish();
    });
  }

  async steerTurn(input: SteerTurnInput): Promise<void> {
    const turn = this.activeTurns.get(input.turnId);
    if (!turn || turn.finalized) {
      throw new Error('Active turn not found');
    }
    if (turn.backend === 'claude') {
      await this.claudeBackend.steerTurn(turn, input.content);
      return;
    }
    if (turn.backend !== 'codex') {
      await this.appendTurnEvent(turn.turnId, 'assistant.delta', {
        text: `\n[steer] ${input.content}`,
      });
      return;
    }
    await this.codexBackend.steerTurn({
      turnId: input.turnId,
      content: input.content,
    });
  }

  async cancelTurn(input: CancelTurnInput): Promise<boolean> {
    const turn = this.activeTurns.get(input.turnId);
    if (!turn) {
      return false;
    }
    await this.cancelActiveTurn(turn, { emitCancelEvent: true });
    return true;
  }

  async resolveTurnApproval(input: ResolveTurnApprovalInput): Promise<void> {
    const turn = this.activeTurns.get(input.turnId);
    if (turn?.backend === 'claude') {
      await this.claudeBackend.resolvePendingApproval({
        turnId: input.turnId,
        requestId: input.requestId,
        decision: input.decision,
      });
      return;
    }
    await this.codexBackend.resolvePendingApproval({
      turnId: input.turnId,
      requestId: input.requestId,
      decision: input.decision,
    });
  }

  async forkThread(input: ForkThreadInput): Promise<ForkThreadResult> {
    const cwd = await this.filesystemBackend.resolveWorkspaceCwd(input.cwd);
    const requestedBackend = this.resolveRequestedBackend(input.backend, 'backend');

    if (requestedBackend === 'mock') {
      return { threadId: `mock-fork-${randomUUID()}` };
    }

    if (requestedBackend === 'claude') {
      const threadId = await this.claudeBackend.forkThread({
        threadId: input.threadId,
        backend: input.backend ?? null,
        backendConfig: input.backendConfig ?? null,
        cwd,
      });
      return { threadId };
    }

    if (requestedBackend !== 'codex') {
      throw new Error(`Unsupported backend: ${requestedBackend}`);
    }

    const threadId = await this.codexBackend.forkThread({
      threadId: input.threadId,
      backend: input.backend ?? null,
      backendConfig: input.backendConfig ?? null,
      cwd,
    });
    return { threadId };
  }

  async closeThread(input: CloseThreadInput): Promise<void> {
    const requestedBackend = this.resolveRequestedBackend(input.backend, 'backend');
    if (requestedBackend === 'mock') {
      return;
    }
    if (requestedBackend === 'claude') {
      await this.claudeBackend.closeThread({
        threadId: input.threadId,
        backend: input.backend ?? null,
        cwd: input.cwd ?? null,
      });
      return;
    }
    await this.codexBackend.closeThread({
      threadId: input.threadId,
      backend: input.backend ?? null,
      cwd: input.cwd ?? null,
    });
  }

  async compactThread(input: CompactThreadInput): Promise<void> {
    const cwd = await this.filesystemBackend.resolveWorkspaceCwd(input.cwd);
    const requestedBackend = this.resolveRequestedBackend(input.backend, 'backend');

    if (requestedBackend === 'mock') {
      return;
    }
    if (requestedBackend === 'claude') {
      await this.claudeBackend.compactThread({
        threadId: input.threadId,
        backend: input.backend ?? null,
        backendConfig: input.backendConfig ?? null,
        cwd,
      });
      return;
    }
    if (requestedBackend !== 'codex') {
      throw new Error(`Unsupported backend: ${requestedBackend}`);
    }
    await this.codexBackend.compactThread({
      threadId: input.threadId,
      backend: input.backend ?? null,
      backendConfig: input.backendConfig ?? null,
      cwd,
    });
  }

  async listModels(input: ModelListInput): Promise<AvailableModel[]> {
    const requestedBackend = parseOptionalBackend(input.backend ?? null);

    if (requestedBackend && !this.isBackendSupported(requestedBackend)) {
      return [];
    }

    if (requestedBackend === 'claude') {
      return this.claudeBackend.listModels();
    }
    if (requestedBackend === 'mock') {
      return [this.buildMockModel()];
    }
    if (requestedBackend === 'codex') {
      return this.codexBackend.listModels();
    }

    const models: AvailableModel[] = [];
    if (this.isBackendSupported('codex')) {
      models.push(...(await this.codexBackend.listModels()));
    }
    if (this.isBackendSupported('claude')) {
      models.push(...(await this.claudeBackend.listModels()));
    }
    if (this.isBackendSupported('mock')) {
      models.push(this.buildMockModel());
    }
    return models;
  }

  async listSkills(input: SkillListInput): Promise<AvailableSkill[]> {
    const requestedBackend = parseOptionalBackend(input.backend ?? null);
    const cwdHint = typeof input.cwd === 'string' && input.cwd.trim().length > 0 ? input.cwd.trim() : null;

    if (requestedBackend && !this.isBackendSupported(requestedBackend)) {
      return [];
    }

    if (requestedBackend === 'codex') {
      return this.isBackendSupported('codex') ? this.codexBackend.listSkills(cwdHint ?? this.codexDefaultCwd) : [];
    }

    if (requestedBackend === 'claude') {
      return this.isBackendSupported('claude') ? this.claudeBackend.listSkills(cwdHint ?? process.cwd()) : [];
    }

    if (requestedBackend === 'mock') {
      return [];
    }

    if (!this.isBackendSupported('codex')) {
      return [];
    }
    return this.codexBackend.listSkills(cwdHint ?? this.codexDefaultCwd);
  }

  async getHealth(): Promise<RunnerHealth> {
    return { supportedBackends: [...this.supportedBackends] };
  }

  async readCodexRateLimits(): Promise<CodexRateLimits> {
    if (!this.isBackendSupported('codex')) {
      return { rateLimits: null, rateLimitsByLimitId: null };
    }
    const result = await this.codexBackend.readCodexRateLimits();
    return {
      rateLimits: parseRateLimitSnapshot(result.rateLimits),
      rateLimitsByLimitId: parseRateLimitsByLimitId(result.rateLimitsByLimitId),
    };
  }

  // -- Filesystem ------------------------------------------------------------

  async ensureDirectory(input: EnsureDirectoryInput): Promise<EnsureDirectoryResult> {
    return this.filesystemBackend.ensureWorkspaceDirectory(input.path);
  }

  async suggestWorkspaceDirectories(input: WorkspaceSuggestionInput): Promise<string[]> {
    return this.filesystemBackend.suggestWorkspaceDirectories(input.prefix, input.limit ?? 12);
  }

  async listWorkspaceTree(input: WorkspaceTreeInput): Promise<WorkspaceTreeEntry[]> {
    return this.filesystemBackend.listWorkspaceTree(input.path, input.limit ?? 200, input.includeHidden === true);
  }

  async readWorkspaceFile(input: WorkspaceFileInput): Promise<WorkspaceFileResult> {
    return this.filesystemBackend.readWorkspaceFile(input.path, input.maxBytes ?? 256 * 1024);
  }

  async readWorkspaceFileContent(input: WorkspaceFileContentInput): Promise<WorkspaceFileContentResult> {
    const result = await this.filesystemBackend.readWorkspaceFileBinary(input.path);
    return {
      path: result.path,
      content: result.content,
      mimeType: result.mimeType,
    };
  }

  async uploadWorkspaceFile(input: WorkspaceUploadInput): Promise<WorkspaceUploadResult> {
    const upload = await parseWorkspaceUpload(input);
    return this.filesystemBackend.saveWorkspaceUpload({
      workspacePath: upload.workspacePath,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      content: upload.content,
    });
  }

  // -- Internal helpers ------------------------------------------------------

  private isBackendSupported(backend: RunnerBackend): boolean {
    return this.supportedBackends.includes(backend);
  }

  private resolveRequestedBackend(input: string | null | undefined, field: string): RunnerBackend {
    const parsed = parseRunnerBackend(input ?? DEFAULT_RUNNER_BACKEND, field);
    if (!this.isBackendSupported(parsed)) {
      throw new Error(`${field} backend "${parsed}" is not enabled`);
    }
    return parsed;
  }

  private buildMockModel(): AvailableModel {
    const model = this.codexDefaultModel || 'gpt-5-codex';
    return {
      id: model,
      backend: 'mock',
      model,
      displayName: model,
      description: 'Configured mock/default model',
      hidden: false,
      isDefault: true,
      supportedEfforts: [],
      defaultEffort: null,
    };
  }

  private async startMockExecution(turn: ActiveMockTurn): Promise<void> {
    await this.appendTurnEvent(turn.turnId, 'turn.started', {});

    const responseContent = `Echo: ${turn.content}`;
    const chunks = chunkText(responseContent, 12);
    chunks.forEach((chunk, index) => {
      const timer = setTimeout(
        () => {
          if (!this.activeTurns.has(turn.turnId)) {
            return;
          }
          void this.appendTurnEvent(turn.turnId, 'assistant.delta', {
            text: chunk,
          });
        },
        120 + index * 120,
      );
      turn.timers.push(timer);
    });

    const finalizeTimer = setTimeout(
      () => {
        if (!this.activeTurns.has(turn.turnId)) {
          return;
        }
        void this.finalizeTurn(turn.turnId, 'turn.completed', {
          content: responseContent,
        });
      },
      200 + chunks.length * 120,
    );
    turn.timers.push(finalizeTimer);
  }

  private ensureTurnStreamState(
    turnId: string,
    sessionId: string,
    status: RunnerTurnStreamState['status'],
  ): RunnerTurnStreamState {
    const existing = this.turnStreams.get(turnId);
    if (existing) {
      existing.sessionId = sessionId;
      existing.status = status;
      return existing;
    }

    const state: RunnerTurnStreamState = {
      turnId,
      sessionId,
      status,
      nextSeq: 1,
      events: [],
      listeners: new Set<RunnerStreamListener>(),
      cleanupTimer: null,
    };
    this.turnStreams.set(turnId, state);
    return state;
  }

  private async appendTurnEvent(
    turnId: string,
    type: RunnerEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const activeTurn = this.activeTurns.get(turnId);
    const sessionId = activeTurn?.sessionId ?? this.turnStreams.get(turnId)?.sessionId ?? '';
    const streamState = this.ensureTurnStreamState(turnId, sessionId, mapEventTypeToStatus(type));
    streamState.status = mapEventTypeToStatus(type, streamState.status);

    const event: BufferedRunnerEvent = {
      turnId,
      seq: streamState.nextSeq,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    streamState.nextSeq += 1;
    streamState.events.push(event);
    if (streamState.events.length > this.runnerEventBufferLimit) {
      streamState.events.splice(0, streamState.events.length - this.runnerEventBufferLimit);
    }

    const listeners = [...streamState.listeners];
    for (const listener of listeners) {
      try {
        await listener(event);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown listener error';
        this.logger.warn(`Embedded runner listener error for turn ${turnId}: ${message}`);
      }
    }

    if (isTerminalStatus(streamState.status)) {
      streamState.listeners.clear();
      this.scheduleTurnStreamCleanup(streamState);
    }
  }

  private scheduleTurnStreamCleanup(streamState: RunnerTurnStreamState): void {
    if (streamState.cleanupTimer) {
      clearTimeout(streamState.cleanupTimer);
    }
    streamState.cleanupTimer = setTimeout(() => {
      this.turnStreams.delete(streamState.turnId);
    }, this.runnerEventRetentionMs);
  }

  private async failTurn(turnId: string, message: string): Promise<void> {
    await this.finalizeTurn(turnId, 'turn.failed', { message });
  }

  private async finalizeTurn(turnId: string, type: RunnerEventType, payload: Record<string, unknown>): Promise<void> {
    const turn = this.activeTurns.get(turnId);
    if (!turn || turn.finalized) {
      return;
    }
    turn.finalized = true;
    if (turn.backend === 'codex') {
      await this.codexBackend.disposePendingApprovalsForTurn(turnId, 'decline');
    }
    this.activeTurns.delete(turnId);

    if (turn.backend === 'mock') {
      clearTurnTimers(turn.timers);
    } else if (turn.backend === 'claude') {
      this.claudeBackend.disposePendingApprovalsForTurn(turnId, 'decline');
      turn.query?.close();
      turn.completionResolve?.();
    } else {
      turn.completionResolve?.();
    }

    await this.appendTurnEvent(turnId, type, payload);
  }

  private async cancelActiveTurn(turn: ActiveTurn, options: { emitCancelEvent: boolean }): Promise<void> {
    if (!options.emitCancelEvent) {
      this.silentlyDisposeTurn(turn);
      return;
    }

    if (turn.backend === 'mock') {
      await this.finalizeTurn(turn.turnId, 'turn.cancelled', {});
      return;
    }
    if (turn.backend === 'claude') {
      await this.claudeBackend.cancelTurn(turn);
      return;
    }
    await this.codexBackend.cancelTurn(turn, options);
  }

  private silentlyDisposeTurn(turn: ActiveTurn): void {
    if (turn.finalized) {
      return;
    }
    turn.finalized = true;
    if (turn.backend === 'mock') {
      this.activeTurns.delete(turn.turnId);
      clearTurnTimers(turn.timers);
      return;
    }
    if (turn.backend === 'claude') {
      this.claudeBackend.disposePendingApprovalsForTurn(turn.turnId, 'decline');
      this.claudeBackend.silentlyDisposeTurn(turn.turnId);
      return;
    }
    this.codexBackend.silentlyDisposeTurn(turn.turnId);
  }
}

// ---- helpers ---------------------------------------------------------------

function isTerminalStatus(status: RunnerTurnStreamState['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function mapEventTypeToStatus(
  type: RunnerEventType,
  currentStatus: RunnerTurnStreamState['status'] = 'queued',
): RunnerTurnStreamState['status'] {
  if (type === 'turn.started') {
    return 'running';
  }
  if (type === 'turn.approval.requested') {
    return 'waiting_approval';
  }
  if (type === 'turn.approval.resolved') {
    return 'running';
  }
  if (type === 'turn.completed') {
    return 'completed';
  }
  if (type === 'turn.failed') {
    return 'failed';
  }
  if (type === 'turn.cancelled') {
    return 'cancelled';
  }
  return currentStatus;
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks.length > 0 ? chunks : [''];
}

function clearTurnTimers(timers: ReturnType<typeof setTimeout>[]): void {
  timers.forEach((timer) => clearTimeout(timer));
  timers.length = 0;
}

function parseRunnerBackend(value: string, field: string): RunnerBackend {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'mock' || normalized === 'claude') {
    return normalized;
  }
  throw new Error(`${field} must be one of: codex, claude, mock`);
}

function parseOptionalBackend(value: string | null | undefined): RunnerBackend | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return parseRunnerBackend(trimmed, 'backend');
}

function parseSupportedBackends(value: string | undefined): RunnerBackend[] {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return [...ALL_RUNNER_BACKENDS];
  }
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseRunnerBackend(entry, 'RUNNER_SUPPORTED_BACKENDS'));
  const unique = Array.from(new Set(parsed));
  return unique.length > 0 ? unique : [...ALL_RUNNER_BACKENDS];
}

async function parseWorkspaceUpload(input: WorkspaceUploadInput): Promise<{
  workspacePath: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
}> {
  const contentType = input.contentType;
  if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('multipart/form-data')) {
    throw new Error('content-type must be multipart/form-data');
  }

  const headers: Record<string, string> = { 'content-type': contentType };
  if (typeof input.contentLength === 'string' && input.contentLength.trim().length > 0) {
    headers['content-length'] = input.contentLength.trim();
  }

  return await new Promise((resolve, reject) => {
    const parser = Busboy({
      headers,
      limits: {
        files: 1,
        fields: 8,
        fileSize: 20 * 1024 * 1024,
      },
    });

    let workspacePath = '';
    let fileName = '';
    let mimeType = 'application/octet-stream';
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let hasFile = false;
    let fileTooLarge = false;

    parser.on('field', (name: string, value: string) => {
      if (name === 'workspacePath' && workspacePath.length === 0) {
        workspacePath = value.trim();
      }
    });

    parser.on(
      'file',
      (
        name: string,
        stream: NodeJS.ReadableStream & {
          resume: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => void;
        },
        info: { filename: string; mimeType: string },
      ) => {
        if (name !== 'file') {
          stream.resume();
          return;
        }
        hasFile = true;
        if (typeof info.filename === 'string' && info.filename.trim().length > 0) {
          fileName = info.filename.trim();
        }
        if (typeof info.mimeType === 'string' && info.mimeType.trim().length > 0) {
          mimeType = info.mimeType.trim();
        }

        stream.on('data', (chunk: Buffer | string) => {
          const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bufferChunk.length;
          chunks.push(bufferChunk);
        });
        stream.on('limit', () => {
          fileTooLarge = true;
        });
        stream.on('error', (error: unknown) => {
          reject(error instanceof Error ? error : new Error('Failed to read upload stream'));
        });
      },
    );

    parser.on('filesLimit', () => {
      reject(new Error('Only one file can be uploaded per request'));
    });
    parser.on('error', (error: unknown) => {
      reject(error instanceof Error ? error : new Error('Failed to parse multipart request'));
    });
    parser.on('finish', () => {
      if (!workspacePath) {
        reject(new Error('workspacePath is required'));
        return;
      }
      if (!hasFile) {
        reject(new Error('file is required'));
        return;
      }
      if (fileTooLarge) {
        reject(new Error('Uploaded file exceeds 20MB limit'));
        return;
      }
      if (totalBytes <= 0) {
        reject(new Error('Uploaded file is empty'));
        return;
      }
      resolve({
        workspacePath,
        fileName: fileName || 'upload.bin',
        mimeType,
        content: Buffer.concat(chunks, totalBytes),
      });
    });

    input.body.pipe(parser);
  });
}

function parseRateLimitWindow(value: unknown): RateLimitWindow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    usedPercent: toFiniteNumber(record.usedPercent),
    resetsAt: toFiniteNumber(record.resetsAt),
    windowDurationMins: toFiniteNumber(record.windowDurationMins),
  };
}

function parseRateLimitSnapshot(value: unknown): RateLimitSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const creditsRaw = record.credits;
  const credits =
    creditsRaw && typeof creditsRaw === 'object'
      ? {
          balance:
            typeof (creditsRaw as Record<string, unknown>).balance === 'string'
              ? ((creditsRaw as Record<string, unknown>).balance as string)
              : null,
          hasCredits: (creditsRaw as Record<string, unknown>).hasCredits === true,
          unlimited: (creditsRaw as Record<string, unknown>).unlimited === true,
        }
      : null;

  return {
    limitId: typeof record.limitId === 'string' ? record.limitId : null,
    limitName: typeof record.limitName === 'string' ? record.limitName : null,
    planType: typeof record.planType === 'string' ? record.planType : null,
    credits,
    primary: parseRateLimitWindow(record.primary),
    secondary: parseRateLimitWindow(record.secondary),
  };
}

function parseRateLimitsByLimitId(value: unknown): Record<string, RateLimitSnapshot> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const output: Record<string, RateLimitSnapshot> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const parsed = parseRateLimitSnapshot(entry);
    if (parsed) {
      output[key] = parsed;
    }
  }
  return output;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
