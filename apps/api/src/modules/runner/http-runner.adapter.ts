import { Injectable, Logger } from '@nestjs/common';
import {
  AvailableModel,
  CancelTurnInput,
  ForkThreadInput,
  ForkThreadResult,
  ResolveTurnApprovalInput,
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
