import { Injectable, Logger } from '@nestjs/common';
import { CancelTurnInput, RunnerAdapter, StartTurnInput } from './runner.types';

type RunnerHttpRequestOptions = {
  method: 'POST';
  path: string;
  body: Record<string, unknown>;
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

  private async request(options: RunnerHttpRequestOptions): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${options.path}`, {
        method: options.method,
        headers: {
          'content-type': 'application/json',
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
        },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseText = await response.text();
        this.logger.error(
          `Runner request failed: ${options.path} -> ${response.status} ${response.statusText} ${responseText}`,
        );
        throw new Error(`Runner request failed: ${response.status}`);
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
