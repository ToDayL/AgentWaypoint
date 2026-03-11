import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/codexpanel';
}

const TEST_REPO_PATH = process.cwd();

type RunnerEventType =
  | 'turn.started'
  | 'assistant.delta'
  | 'turn.approval.requested'
  | 'turn.approval.resolved'
  | 'turn.completed'
  | 'turn.cancelled';

type TestRunnerServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type ActiveTurnState = {
  mode: 'complete' | 'approval';
  content: string;
  approvalRequestId?: string;
  completionTimer?: ReturnType<typeof setTimeout>;
};

function randomEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw new Error('Request body is required');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function createTestRunnerServer(apiBaseUrl: string): Promise<TestRunnerServer> {
  const activeTurns = new Map<string, ActiveTurnState>();

  const emitEvent = async (turnId: string, type: RunnerEventType, payload: Record<string, unknown>) => {
    try {
      const response = await fetch(`${apiBaseUrl}/internal/runner/turns/${turnId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, payload }),
      });
      if (!response.ok) {
        await response.text();
      }
    } catch {
      // Intentionally ignored in test runner stub.
    }
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/runner/health') {
        sendJson(response, 200, { status: 'ok', activeTurnCount: activeTurns.size });
        return;
      }

      if (request.method !== 'POST') {
        sendJson(response, 404, { error: 'not found' });
        return;
      }

      if (request.url === '/runner/turns/start') {
        const payload = await readJsonBody(request);
        const turnId = readRequiredString(payload, 'turnId');
        const content = readRequiredString(payload, 'content');

        const existing = activeTurns.get(turnId);
        if (existing?.completionTimer) {
          clearTimeout(existing.completionTimer);
        }
        void emitEvent(turnId, 'turn.started', {});

        if (content.includes('[approval]')) {
          activeTurns.set(turnId, {
            mode: 'approval',
            content,
            approvalRequestId: `approval-${turnId}`,
          });

          setTimeout(() => {
            const current = activeTurns.get(turnId);
            if (!current || current.mode !== 'approval' || !current.approvalRequestId) return;
            void emitEvent(turnId, 'turn.approval.requested', {
              requestId: current.approvalRequestId,
              kind: 'command_execution',
              reason: 'Need approval to run a command',
              command: 'git status',
              cwd: TEST_REPO_PATH,
            });
          }, 120);
        } else {
          const completionTimer = setTimeout(() => {
            if (!activeTurns.has(turnId)) return;
            activeTurns.delete(turnId);
            void emitEvent(turnId, 'turn.completed', { content: `Echo: ${content}` });
          }, 1000);

          activeTurns.set(turnId, {
            mode: 'complete',
            content,
            completionTimer,
          });

          setTimeout(() => {
            if (!activeTurns.has(turnId)) return;
            void emitEvent(turnId, 'assistant.delta', { text: `Echo: ${content.slice(0, 12)}` });
          }, 120);
        }

        sendJson(response, 202, { accepted: true });
        return;
      }

      if (request.url === '/runner/turns/approval') {
        const payload = await readJsonBody(request);
        const turnId = readRequiredString(payload, 'turnId');
        const requestId = readRequiredString(payload, 'requestId');
        const decision = readRequiredString(payload, 'decision');
        const activeTurn = activeTurns.get(turnId);
        if (!activeTurn || activeTurn.mode !== 'approval' || activeTurn.approvalRequestId !== requestId) {
          sendJson(response, 404, { error: 'pending approval not found' });
          return;
        }

        void emitEvent(turnId, 'turn.approval.resolved', { requestId, decision });

        if (decision === 'approve') {
          setTimeout(() => {
            if (!activeTurns.has(turnId)) return;
            void emitEvent(turnId, 'assistant.delta', { text: 'Approved command output' });
          }, 80);
          activeTurn.completionTimer = setTimeout(() => {
            if (!activeTurns.has(turnId)) return;
            activeTurns.delete(turnId);
            void emitEvent(turnId, 'turn.completed', { content: 'Approval granted and command executed' });
          }, 200);
        } else {
          activeTurns.delete(turnId);
          setTimeout(() => {
            void emitEvent(turnId, 'turn.completed', { content: 'Approval rejected by user' });
          }, 80);
        }

        sendJson(response, 202, { accepted: true });
        return;
      }

      if (request.url === '/runner/turns/cancel') {
        const payload = await readJsonBody(request);
        const turnId = readRequiredString(payload, 'turnId');
        const activeTurn = activeTurns.get(turnId);
        const cancelled = !!activeTurn;
        if (activeTurn) {
          if (activeTurn.completionTimer) {
            clearTimeout(activeTurn.completionTimer);
          }
          activeTurns.delete(turnId);
          void emitEvent(turnId, 'turn.cancelled', {});
        }
        sendJson(response, 202, { accepted: true, cancelled });
        return;
      }

      sendJson(response, 404, { error: 'not found' });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'bad request' });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => {
      activeTurns.forEach((turn) => {
        if (turn.completionTimer) {
          clearTimeout(turn.completionTimer);
        }
      });
      activeTurns.clear();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

describe.sequential('API e2e (http runner)', () => {
  let app: NestFastifyApplication;
  let runner: TestRunnerServer;
  let apiBaseUrl = '';

  const prevRunnerMode = process.env.RUNNER_MODE;
  const prevRunnerBaseUrl = process.env.RUNNER_BASE_URL;

  beforeAll(async () => {
    const apiPort = 4100 + Math.floor(Math.random() * 800);
    apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    runner = await createTestRunnerServer(apiBaseUrl);

    process.env.RUNNER_MODE = 'http';
    process.env.RUNNER_BASE_URL = runner.baseUrl;
    process.env.RUNNER_AUTH_TOKEN = '';

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(apiPort, '127.0.0.1');
  });

  afterAll(async () => {
    if (runner) {
      await runner.close();
    }
    if (app) {
      await app.close();
    }
    process.env.RUNNER_MODE = prevRunnerMode;
    process.env.RUNNER_BASE_URL = prevRunnerBaseUrl;
  });

  it('creates turn and streams runner callback events to completion', async () => {
    const email = randomEmail('http-runner');

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ name: 'HTTP Runner Project', repoPath: TEST_REPO_PATH }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'HTTP Runner Session' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const turnResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'hello via http runner' }),
    });
    expect(turnResponse.status).toBe(201);
    const turn = (await turnResponse.json()) as { turnId: string };

    await sleep(1300);

    const streamResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}/stream?since=0`, {
      headers: { 'x-user-email': email },
    });
    expect(streamResponse.status).toBe(200);
    const streamText = await streamResponse.text();
    expect(streamText).toContain('event: turn.started');
    expect(streamText).toContain('event: assistant.delta');
    expect(streamText).toContain('event: turn.completed');
  });

  it('cancels active turn through http runner adapter', async () => {
    const email = randomEmail('http-cancel');

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ name: 'HTTP Cancel Project', repoPath: TEST_REPO_PATH }),
    });
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'HTTP Cancel Session' }),
    });
    const session = (await sessionResponse.json()) as { id: string };

    const turnResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'cancel me' }),
    });
    expect(turnResponse.status).toBe(201);
    const turn = (await turnResponse.json()) as { turnId: string };

    const cancelResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}/cancel`, {
      method: 'POST',
      headers: { 'x-user-email': email },
    });
    expect(cancelResponse.status).toBe(201);
    const cancelledTurn = (await cancelResponse.json()) as { status: string };
    expect(['queued', 'running', 'cancelled']).toContain(cancelledTurn.status);

    let streamText = '';
    for (let i = 0; i < 10; i += 1) {
      const streamResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}/stream?since=0`, {
        headers: { 'x-user-email': email },
      });
      expect(streamResponse.status).toBe(200);
      streamText = await streamResponse.text();
      if (streamText.includes('event: turn.cancelled')) {
        break;
      }
      await sleep(120);
    }
    expect(streamText).toContain('event: turn.cancelled');
  });

  it('resolves approval requests through http runner adapter', async () => {
    const email = randomEmail('http-approval');

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ name: 'HTTP Approval Project', repoPath: TEST_REPO_PATH }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'HTTP Approval Session' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const turnResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'please run [approval] protected command' }),
    });
    expect(turnResponse.status).toBe(201);
    const turn = (await turnResponse.json()) as { turnId: string };

    let pendingApprovalId = '';
    for (let i = 0; i < 10; i += 1) {
      const statusResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}`, {
        headers: { 'x-user-email': email },
      });
      expect(statusResponse.status).toBe(200);
      const status = (await statusResponse.json()) as {
        status: string;
        pendingApproval: null | { id: string };
      };
      if (status.status === 'waiting_approval' && status.pendingApproval?.id) {
        pendingApprovalId = status.pendingApproval.id;
        break;
      }
      await sleep(120);
    }

    expect(pendingApprovalId).toBeTruthy();

    const approvalResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ approvalId: pendingApprovalId, decision: 'approve' }),
    });
    expect(approvalResponse.status).toBe(201);

    await sleep(600);

    const finalStatusResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}`, {
      headers: { 'x-user-email': email },
    });
    expect(finalStatusResponse.status).toBe(200);
    expect(await finalStatusResponse.json()).toMatchObject({
      id: turn.turnId,
      status: 'completed',
      pendingApproval: null,
    });

    const streamResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}/stream?since=0`, {
      headers: { 'x-user-email': email },
    });
    expect(streamResponse.status).toBe(200);
    const streamText = await streamResponse.text();
    expect(streamText).toContain('event: turn.approval.requested');
    expect(streamText).toContain('event: turn.approval.resolved');
    expect(streamText).toContain('event: turn.completed');
  });
});
