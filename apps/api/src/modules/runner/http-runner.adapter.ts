import { Injectable, Logger } from '@nestjs/common';
import {
  AvailableModel,
  CancelTurnInput,
  EnsureDirectoryInput,
  EnsureDirectoryResult,
  ForkThreadInput,
  ForkThreadResult,
  ResolveTurnApprovalInput,
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
        threadId: input.threadId ?? null,
        cwd: input.cwd ?? null,
        model: input.model ?? null,
        sandbox: input.sandbox ?? null,
        approvalPolicy: input.approvalPolicy ?? null,
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

  async listModels(): Promise<AvailableModel[]> {
    const response = await this.request({
      method: 'GET',
      path: '/runner/models',
    });
    if (!response || typeof response !== 'object' || !Array.isArray((response as { data?: unknown }).data)) {
      throw new Error('Runner model list response is invalid');
    }

    return ((response as { data: unknown[] }).data ?? [])
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : '',
        model: typeof item.model === 'string' ? item.model : '',
        displayName: typeof item.displayName === 'string' ? item.displayName : (typeof item.model === 'string' ? item.model : ''),
        description: typeof item.description === 'string' ? item.description : '',
        hidden: item.hidden === true,
        isDefault: item.isDefault === true,
      }))
      .filter((item) => item.id.length > 0 && item.model.length > 0);
  }

  async forkThread(input: ForkThreadInput): Promise<ForkThreadResult> {
    const response = await this.request({
      method: 'POST',
      path: '/runner/threads/fork',
      body: {
        threadId: input.threadId,
        cwd: input.cwd ?? null,
        model: input.model ?? null,
        sandbox: input.sandbox ?? null,
        approvalPolicy: input.approvalPolicy ?? null,
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
        this.logger.error(
          `Runner request failed: ${options.path} -> ${response.status} ${response.statusText} ${responseText}`,
        );
        throw new Error(`Runner request failed: ${response.status}`);
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
