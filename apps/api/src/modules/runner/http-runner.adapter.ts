import { Injectable, Logger } from '@nestjs/common';
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
  ResolveTurnApprovalInput,
  ModelListInput,
  SkillListInput,
  WorkspaceFileInput,
  WorkspaceFileContentInput,
  WorkspaceFileContentResult,
  WorkspaceFileResult,
  WorkspaceUploadInput,
  WorkspaceUploadResult,
  WorkspaceTreeEntry,
  WorkspaceTreeInput,
  WorkspaceSuggestionInput,
  RunnerStreamEvent,
  RunnerAdapter,
  SteerTurnInput,
  StartTurnInput,
} from './runner.types';

type RunnerHttpRequestOptions = {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
};

@Injectable()
export class HttpRunnerAdapter implements RunnerAdapter {
  private readonly logger = new Logger(HttpRunnerAdapter.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly authToken: string | null;

  constructor() {
    this.baseUrl = (process.env.RUNNER_BASE_URL ?? 'http://127.0.0.1:4700').replace(/\/+$/, '');
    this.timeoutMs = Number(process.env.RUNNER_HTTP_TIMEOUT_MS ?? 5000);
    this.authToken = process.env.RUNNER_AUTH_TOKEN?.trim() || null;
  }

  async startTurn(input: StartTurnInput): Promise<void> {
    await this.request({
      method: 'POST',
      path: '/runner/turns/start',
      body: {
        turnId: input.turnId,
        sessionId: input.sessionId,
        content: input.content,
        backend: input.backend ?? null,
        backendConfig: input.backendConfig ?? null,
        threadId: input.threadId ?? null,
        cwd: input.cwd ?? null,
      },
    });
  }

  async consumeTurnEvents(
    input: { turnId: string; sinceSeq?: number },
    onEvent: (event: RunnerStreamEvent) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const streamPath = `/runner/turns/${encodeURIComponent(input.turnId)}/stream?since=${Math.max(
      input.sinceSeq ?? 0,
      0,
    )}`;

    try {
      const response = await fetch(`${this.baseUrl}${streamPath}`, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
        },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const responseText = await response.text();
        this.logger.error(
          `Runner stream failed: ${streamPath} -> ${response.status} ${response.statusText} ${responseText}`,
        );
        throw new Error(`Runner stream failed: ${response.status}`);
      }

      clearTimeout(timeout);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = 'message';
      let dataLines: string[] = [];

      const flushEvent = async (): Promise<void> => {
        if (dataLines.length === 0) {
          currentEvent = 'message';
          return;
        }
        const payload = dataLines.join('\n').trim();
        dataLines = [];
        if (!payload || currentEvent === 'keepalive') {
          currentEvent = 'message';
          return;
        }
        const parsed = JSON.parse(payload) as RunnerStreamEvent;
        await onEvent(parsed);
        currentEvent = 'message';
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const rawLine = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

          if (line.length === 0) {
            await flushEvent();
          } else if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim() || 'message';
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }

          newlineIndex = buffer.indexOf('\n');
        }
      }

      if (dataLines.length > 0) {
        await flushEvent();
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Runner stream error for ${streamPath}: ${error.message}`, error.stack);
      } else {
        this.logger.error(`Runner stream error for ${streamPath}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async steerTurn(input: SteerTurnInput): Promise<void> {
    await this.request({
      method: 'POST',
      path: '/runner/turns/steer',
      body: {
        turnId: input.turnId,
        content: input.content,
      },
    });
  }

  async cancelTurn(input: CancelTurnInput): Promise<void> {
    await this.request({
      method: 'POST',
      path: '/runner/turns/cancel',
      body: {
        turnId: input.turnId,
      },
    });
  }

  async resolveTurnApproval(input: ResolveTurnApprovalInput): Promise<void> {
    await this.request({
      method: 'POST',
      path: '/runner/turns/approval',
      body: {
        turnId: input.turnId,
        requestId: input.requestId,
        decision: input.decision,
      },
    });
  }

  async readCodexRateLimits(): Promise<CodexRateLimits> {
    const response = await this.request({
      method: 'GET',
      path: '/runner/codex/rate-limits',
    });
    if (!response || typeof response !== 'object') {
      throw new Error('Runner codex rate limits response is invalid');
    }
    const record = response as Record<string, unknown>;
    return {
      rateLimits: parseRateLimitSnapshot(record.rateLimits),
      rateLimitsByLimitId: parseRateLimitsByLimitId(record.rateLimitsByLimitId),
    };
  }

  async listModels(input: ModelListInput): Promise<AvailableModel[]> {
    const query = new URLSearchParams();
    if (typeof input.backend === 'string' && input.backend.trim()) {
      query.set('backend', input.backend.trim());
    }
    const response = await this.request({
      method: 'GET',
      path: query.size > 0 ? `/runner/models?${query.toString()}` : '/runner/models',
    });
    if (!response || typeof response !== 'object' || !Array.isArray((response as { data?: unknown }).data)) {
      throw new Error('Runner model list response is invalid');
    }

    return ((response as { data: unknown[] }).data ?? [])
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : '',
        backend:
          typeof item.backend === 'string' && item.backend.trim().length > 0
            ? item.backend.trim()
            : typeof input.backend === 'string' && input.backend.trim().length > 0
              ? input.backend.trim()
              : '',
        model: typeof item.model === 'string' ? item.model : '',
        displayName: typeof item.displayName === 'string' ? item.displayName : (typeof item.model === 'string' ? item.model : ''),
        description: typeof item.description === 'string' ? item.description : '',
        hidden: item.hidden === true,
        isDefault: item.isDefault === true,
      }))
      .filter((item) => item.id.length > 0 && item.model.length > 0 && item.backend.length > 0);
  }

  async listSkills(input: SkillListInput): Promise<AvailableSkill[]> {
    const query = new URLSearchParams();
    if (typeof input.cwd === 'string' && input.cwd.trim()) {
      query.set('cwd', input.cwd.trim());
    }
    const response = await this.request({
      method: 'GET',
      path: query.size > 0 ? `/runner/skills?${query.toString()}` : '/runner/skills',
    });
    if (!response || typeof response !== 'object' || !Array.isArray((response as { data?: unknown }).data)) {
      throw new Error('Runner skill list response is invalid');
    }

    return ((response as { data: unknown[] }).data ?? [])
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        name: typeof item.name === 'string' ? item.name : '',
        description: typeof item.description === 'string' ? item.description : '',
        path: typeof item.path === 'string' ? item.path : '',
        enabled: item.enabled !== false,
      }))
      .filter((item) => item.name.length > 0);
  }

  async forkThread(input: ForkThreadInput): Promise<ForkThreadResult> {
    const response = await this.request({
      method: 'POST',
      path: '/runner/threads/fork',
      body: {
        threadId: input.threadId,
        backend: input.backend ?? null,
        backendConfig: input.backendConfig ?? null,
        cwd: input.cwd ?? null,
      },
    });
    if (!response || typeof response !== 'object') {
      throw new Error('Runner fork thread response is invalid');
    }
    const threadId = typeof (response as { threadId?: unknown }).threadId === 'string'
      ? (response as { threadId: string }).threadId
      : '';
    if (!threadId) {
      throw new Error('Runner fork thread response did not include threadId');
    }
    return { threadId };
  }

  async closeThread(input: CloseThreadInput): Promise<void> {
    await this.request({
      method: 'POST',
      path: '/runner/threads/close',
      body: {
        threadId: input.threadId,
      },
    });
  }

  async compactThread(input: CompactThreadInput): Promise<void> {
    await this.request({
      method: 'POST',
      path: '/runner/threads/compact',
      body: {
        threadId: input.threadId,
        backend: input.backend ?? null,
        backendConfig: input.backendConfig ?? null,
        cwd: input.cwd ?? null,
      },
    });
  }

  async ensureDirectory(input: EnsureDirectoryInput): Promise<EnsureDirectoryResult> {
    const response = await this.request({
      method: 'POST',
      path: '/runner/fs/ensure-directory',
      body: {
        path: input.path,
      },
    });
    if (!response || typeof response !== 'object') {
      throw new Error('Runner ensure-directory response is invalid');
    }
    const ensuredPath =
      typeof (response as { path?: unknown }).path === 'string' ? (response as { path: string }).path : '';
    if (!ensuredPath) {
      throw new Error('Runner ensure-directory response did not include path');
    }
    return {
      path: ensuredPath,
      created: (response as { created?: unknown }).created === true,
    };
  }

  async suggestWorkspaceDirectories(input: WorkspaceSuggestionInput): Promise<string[]> {
    const query = new URLSearchParams({
      prefix: input.prefix,
      limit: String(input.limit ?? 12),
    });
    const response = await this.request({
      method: 'GET',
      path: `/runner/fs/suggestions?${query.toString()}`,
    });
    if (!response || typeof response !== 'object' || !Array.isArray((response as { data?: unknown }).data)) {
      throw new Error('Runner workspace suggestions response is invalid');
    }

    return ((response as { data: unknown[] }).data ?? [])
      .filter((item): item is string => typeof item === 'string')
      .filter((item) => item.trim().length > 0);
  }

  async listWorkspaceTree(input: WorkspaceTreeInput): Promise<WorkspaceTreeEntry[]> {
    const query = new URLSearchParams({
      path: input.path,
      limit: String(input.limit ?? 200),
    });
    const response = await this.request({
      method: 'GET',
      path: `/runner/fs/tree?${query.toString()}`,
    });
    if (!response || typeof response !== 'object' || !Array.isArray((response as { data?: unknown }).data)) {
      throw new Error('Runner workspace tree response is invalid');
    }

    return ((response as { data: unknown[] }).data ?? [])
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        name: typeof item.name === 'string' ? item.name : '',
        path: typeof item.path === 'string' ? item.path : '',
        isDirectory: item.isDirectory === true,
      }))
      .filter((item) => item.name.length > 0 && item.path.length > 0);
  }

  async readWorkspaceFile(input: WorkspaceFileInput): Promise<WorkspaceFileResult> {
    const query = new URLSearchParams({
      path: input.path,
      maxBytes: String(input.maxBytes ?? 256 * 1024),
    });
    const response = await this.request({
      method: 'GET',
      path: `/runner/fs/file?${query.toString()}`,
    });
    if (!response || typeof response !== 'object') {
      throw new Error('Runner workspace file response is invalid');
    }
    const record = response as Record<string, unknown>;
    const pathValue = typeof record.path === 'string' ? record.path : '';
    const contentValue = typeof record.content === 'string' ? record.content : '';
    if (!pathValue) {
      throw new Error('Runner workspace file response did not include path');
    }
    return {
      path: pathValue,
      content: contentValue,
      truncated: record.truncated === true,
    };
  }

  async readWorkspaceFileContent(input: WorkspaceFileContentInput): Promise<WorkspaceFileContentResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const query = new URLSearchParams({ path: input.path });
    const requestPath = `/runner/fs/file-content?${query.toString()}`;

    try {
      const response = await fetch(`${this.baseUrl}${requestPath}`, {
        method: 'GET',
        headers: {
          accept: '*/*',
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const responseText = await response.text();
        const runnerErrorMessage = extractRunnerErrorMessage(responseText, response.status);
        this.logger.error(
          `Runner request failed: ${requestPath} -> ${response.status} ${response.statusText} ${responseText}`,
        );
        throw new Error(runnerErrorMessage);
      }

      const content = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type')?.trim() || 'application/octet-stream';
      const pathHeader = response.headers.get('x-agentwaypoint-file-path')?.trim() || '';
      const pathValue = pathHeader ? decodeURIComponent(pathHeader) : input.path;
      if (!pathValue) {
        throw new Error('Runner workspace file content response did not include path');
      }
      return {
        path: pathValue,
        content,
        mimeType,
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Runner request error for ${requestPath}: ${error.message}`, error.stack);
      } else {
        this.logger.error(`Runner request error for ${requestPath}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async uploadWorkspaceFile(input: WorkspaceUploadInput): Promise<WorkspaceUploadResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'content-type': input.contentType,
        ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
      };
      if (typeof input.contentLength === 'string' && input.contentLength.trim().length > 0) {
        headers['content-length'] = input.contentLength.trim();
      }

      const response = await fetch(`${this.baseUrl}/runner/fs/upload`, {
        method: 'POST',
        headers,
        body: input.body as unknown as BodyInit,
        signal: controller.signal,
        // Required by Node fetch when sending a streaming request body.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });

      const responseText = await response.text();
      if (!response.ok) {
        const runnerErrorMessage = extractRunnerErrorMessage(responseText, response.status);
        this.logger.error(
          `Runner upload failed: /runner/fs/upload -> ${response.status} ${response.statusText} ${responseText}`,
        );
        throw new Error(runnerErrorMessage);
      }

      const payload = JSON.parse(responseText) as Record<string, unknown>;
      const path = typeof payload.path === 'string' ? payload.path : '';
      const relativePath = typeof payload.relativePath === 'string' ? payload.relativePath : '';
      const size = typeof payload.size === 'number' && Number.isFinite(payload.size) ? payload.size : -1;
      const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : '';
      if (!path || !relativePath || size < 0) {
        throw new Error('Runner workspace upload response is invalid');
      }
      return {
        path,
        relativePath,
        size,
        mimeType,
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Runner upload error: ${error.message}`, error.stack);
      } else {
        this.logger.error('Runner upload error');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request(options: RunnerHttpRequestOptions): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${options.path}`, {
        method: options.method,
        headers: {
          'content-type': 'application/json',
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseText = await response.text();
        const runnerErrorMessage = extractRunnerErrorMessage(responseText, response.status);
        this.logger.error(
          `Runner request failed: ${options.path} -> ${response.status} ${response.statusText} ${responseText}`,
        );
        throw new Error(runnerErrorMessage);
      }

      if (response.status === 204) {
        return null;
      }

      const responseText = await response.text();
      if (!responseText.trim()) {
        return null;
      }

      try {
        return JSON.parse(responseText) as unknown;
      } catch {
        return responseText;
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Runner request error for ${options.path}: ${error.message}`, error.stack);
      } else {
        this.logger.error(`Runner request error for ${options.path}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractRunnerErrorMessage(responseText: string, status: number): string {
  const fallback = `Runner request failed: ${status}`;
  const trimmed = responseText.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (error && typeof error === 'object') {
        const errorMessage = (error as Record<string, unknown>).message;
        if (typeof errorMessage === 'string' && errorMessage.trim()) {
          return errorMessage.trim();
        }
      }
      const message = record.message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }
  } catch {
    // Ignore parse errors and fall back.
  }
  return fallback;
}

function parseRateLimitWindow(value: unknown): { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null } | null {
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

function parseRateLimitSnapshot(value: unknown): {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  credits: { balance: string | null; hasCredits: boolean; unlimited: boolean } | null;
  primary: { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null } | null;
  secondary: { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null } | null;
} | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const creditsRaw = record.credits;
  const credits =
    creditsRaw && typeof creditsRaw === 'object'
      ? {
          balance: typeof (creditsRaw as Record<string, unknown>).balance === 'string'
            ? (creditsRaw as Record<string, unknown>).balance as string
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

function parseRateLimitsByLimitId(value: unknown): Record<string, ReturnType<typeof parseRateLimitSnapshot> extends infer T ? Exclude<T, null> : never> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const output: Record<string, Exclude<ReturnType<typeof parseRateLimitSnapshot>, null>> = {};
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
