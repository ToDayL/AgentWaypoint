import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/agentwaypoint';
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
  getClosedThreadIds: () => string[];
  getCompactedThreadIds: () => string[];
  close: () => Promise<void>;
};

type ActiveTurnState = {
  mode: 'complete' | 'approval';
  content: string;
  approvalRequestId?: string;
  completionTimer?: ReturnType<typeof setTimeout>;
};

type BufferedRunnerEvent = {
  turnId: string;
  seq: number;
  type: RunnerEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

type BufferedTurnState = {
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'cancelled';
  nextSeq: number;
  events: BufferedRunnerEvent[];
  listeners: Set<ServerResponse>;
};

function randomEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

async function createTestRunnerServer(): Promise<TestRunnerServer> {
  const activeTurns = new Map<string, ActiveTurnState>();
  const forkedThreadIds = new Map<string, string>();
  const closedThreadIds = new Set<string>();
  const compactedThreadIds = new Set<string>();
  const bufferedTurns = new Map<string, BufferedTurnState>();

  const ensureBufferedTurn = (turnId: string): BufferedTurnState => {
    const existing = bufferedTurns.get(turnId);
    if (existing) {
      return existing;
    }
    const created: BufferedTurnState = {
      status: 'queued',
      nextSeq: 1,
      events: [],
      listeners: new Set<ServerResponse>(),
    };
    bufferedTurns.set(turnId, created);
    return created;
  };

  const writeSseEvent = (response: ServerResponse, event: BufferedRunnerEvent): void => {
    response.write(`id: ${event.seq}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const emitEvent = async (turnId: string, type: RunnerEventType, payload: Record<string, unknown>) => {
    const turn = ensureBufferedTurn(turnId);
    if (type === 'turn.started') {
      turn.status = 'running';
    } else if (type === 'turn.approval.requested') {
      turn.status = 'waiting_approval';
    } else if (type === 'turn.approval.resolved') {
      turn.status = 'running';
    } else if (type === 'turn.completed') {
      turn.status = 'completed';
    } else if (type === 'turn.cancelled') {
      turn.status = 'cancelled';
    }

    const event: BufferedRunnerEvent = {
      turnId,
      seq: turn.nextSeq,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    turn.nextSeq += 1;
    turn.events.push(event);
    turn.listeners.forEach((listener) => {
      writeSseEvent(listener, event);
      if (turn.status === 'completed' || turn.status === 'cancelled') {
        listener.end();
      }
    });
    if (turn.status === 'completed' || turn.status === 'cancelled') {
      turn.listeners.clear();
    }
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/runner/health') {
        sendJson(response, 200, { status: 'ok', activeTurnCount: activeTurns.size });
        return;
      }

      if (request.method === 'GET' && request.url?.startsWith('/runner/models')) {
        const requestUrl = new URL(request.url ?? '/runner/models', 'http://127.0.0.1');
        const requestedBackend = (requestUrl.searchParams.get('backend') ?? '').trim().toLowerCase();
        const backend = requestedBackend || 'codex';
        sendJson(response, 200, {
          data: [
            {
              id: 'model-gpt-5-codex',
              backend,
              model: 'gpt-5-codex',
              displayName: 'GPT-5 Codex',
              description: 'Primary coding model',
              hidden: false,
              isDefault: true,
            },
            {
              id: 'model-gpt-5-mini',
              backend,
              model: 'gpt-5-mini',
              displayName: 'GPT-5 Mini',
              description: 'Smaller faster model',
              hidden: false,
              isDefault: false,
            },
          ],
        });
        return;
      }

      if (request.method === 'POST' && request.url === '/runner/fs/ensure-directory') {
        const payload = await readJsonBody(request);
        sendJson(response, 200, {
          path: path.resolve(readRequiredString(payload, 'path')),
          created: true,
        });
        return;
      }

      const streamMatch = request.method === 'GET' ? request.url?.match(/^\/runner\/turns\/([^/]+)\/stream(?:\?(.+))?$/) : null;
      if (streamMatch) {
        const turnId = decodeURIComponent(streamMatch[1] ?? '');
        const turn = bufferedTurns.get(turnId);
        if (!turn) {
          sendJson(response, 404, { error: 'turn not found' });
          return;
        }
        const params = new URLSearchParams(streamMatch[2] ?? '');
        const since = Math.max(Number.parseInt(params.get('since') ?? '0', 10) || 0, 0);
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        turn.events.filter((event) => event.seq > since).forEach((event) => writeSseEvent(response, event));
        if (turn.status === 'completed' || turn.status === 'cancelled') {
          response.end();
          return;
        }
        turn.listeners.add(response);
        request.on('close', () => {
          turn.listeners.delete(response);
        });
        return;
      }

      if (request.method !== 'POST') {
        sendJson(response, 404, { error: 'not found' });
        return;
      }

      if (request.url === '/runner/turns/start') {
        const payload = await readJsonBody(request);
        const turnId = readRequiredString(payload, 'turnId');
        const sessionId = readRequiredString(payload, 'sessionId');
        const content = readRequiredString(payload, 'content');
        const cwd = typeof payload.cwd === 'string' && payload.cwd.trim().length > 0 ? payload.cwd.trim() : null;
        const backendConfig =
          payload.backendConfig && typeof payload.backendConfig === 'object' && !Array.isArray(payload.backendConfig)
            ? (payload.backendConfig as Record<string, unknown>)
            : {};
        const model =
          typeof backendConfig.model === 'string' && backendConfig.model.trim().length > 0 ? backendConfig.model.trim() : null;
        const executionMode =
          typeof backendConfig.executionMode === 'string' && backendConfig.executionMode.trim().length > 0
            ? backendConfig.executionMode.trim()
            : 'safe-write';
        const runtimeConfig = mapExecutionModeToRuntime(executionMode);
        const threadId = `thread-${sessionId}`;
        ensureBufferedTurn(turnId);

        const existing = activeTurns.get(turnId);
        if (existing?.completionTimer) {
          clearTimeout(existing.completionTimer);
        }
        void emitEvent(turnId, 'turn.started', {
          threadId,
          ...(model ? { model } : {}),
          ...(cwd ? { cwd } : {}),
          ...(runtimeConfig.sandbox ? { sandbox: runtimeConfig.sandbox } : {}),
          ...(runtimeConfig.approvalPolicy ? { approvalPolicy: runtimeConfig.approvalPolicy } : {}),
        });

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

      if (request.url === '/runner/threads/fork') {
        const payload = await readJsonBody(request);
        const sourceThreadId = readRequiredString(payload, 'threadId');
        const forkedThreadId = `forked-${sourceThreadId}`;
        forkedThreadIds.set(sourceThreadId, forkedThreadId);
        sendJson(response, 200, { threadId: forkedThreadId });
        return;
      }

      if (request.url === '/runner/threads/close') {
        const payload = await readJsonBody(request);
        const threadId = readRequiredString(payload, 'threadId');
        closedThreadIds.add(threadId);
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.url === '/runner/threads/compact') {
        const payload = await readJsonBody(request);
        const threadId = readRequiredString(payload, 'threadId');
        compactedThreadIds.add(threadId);
        sendJson(response, 202, { accepted: true });
        return;
      }

      if (request.url === '/runner/turns/steer') {
        const payload = await readJsonBody(request);
        const turnId = readRequiredString(payload, 'turnId');
        const content = readRequiredString(payload, 'content');
        const activeTurn = activeTurns.get(turnId);
        if (!activeTurn) {
          sendJson(response, 404, { error: 'active turn not found' });
          return;
        }
        setTimeout(() => {
          if (!activeTurns.has(turnId)) return;
          void emitEvent(turnId, 'assistant.delta', { text: ` [steer:${content}]` });
        }, 80);
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
    getClosedThreadIds: () => [...closedThreadIds],
    getCompactedThreadIds: () => [...compactedThreadIds],
    close: () => {
      activeTurns.forEach((turn) => {
        if (turn.completionTimer) {
          clearTimeout(turn.completionTimer);
        }
      });
      activeTurns.clear();
      bufferedTurns.clear();
      closedThreadIds.clear();
      compactedThreadIds.clear();
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
    runner = await createTestRunnerServer();

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

  it('lists models through the http runner adapter', async () => {
    const email = randomEmail('http-model-list');

    const response = await fetch(`${apiBaseUrl}/api/models?backend=codex`, {
      headers: { 'x-user-email': email },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          backend: 'codex',
          model: 'gpt-5-codex',
          displayName: 'GPT-5 Codex',
        }),
        expect.objectContaining({
          backend: 'codex',
          model: 'gpt-5-mini',
          displayName: 'GPT-5 Mini',
        }),
      ]),
    });
  });

  it('uses project model default when dispatching a turn', async () => {
    const email = randomEmail('http-runner-model');

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({
        name: 'HTTP Model Project',
        repoPath: TEST_REPO_PATH,
        backend: 'codex',
        backendConfig: {
          model: 'gpt-5-codex',
          executionMode: 'safe-write',
        },
      }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'HTTP Model Session' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const turnResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'use selected model' }),
    });
    expect(turnResponse.status).toBe(201);
    const turn = (await turnResponse.json()) as { turnId: string };

    await sleep(1300);

    const turnStatusResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}`, {
      headers: { 'x-user-email': email },
    });
    expect(turnStatusResponse.status).toBe(200);
    expect(await turnStatusResponse.json()).toMatchObject({
      id: turn.turnId,
      effectiveBackendConfig: {
        model: 'gpt-5-codex',
      },
    });

    const streamResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}/stream?since=0`, {
      headers: { 'x-user-email': email },
    });
    expect(streamResponse.status).toBe(200);
    const streamText = await streamResponse.text();
    expect(streamText).toContain('"model":"gpt-5-codex"');
  });

  it('uses project repoPath when dispatching a turn', async () => {
    const email = randomEmail('http-runner-cwd');

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ name: 'HTTP Cwd Project', repoPath: TEST_REPO_PATH }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'HTTP Cwd Session' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const turnResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'use overridden cwd' }),
    });
    expect(turnResponse.status).toBe(201);
    const turn = (await turnResponse.json()) as { turnId: string };

    await sleep(1300);

    const turnStatusResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}`, {
      headers: { 'x-user-email': email },
    });
    expect(turnStatusResponse.status).toBe(200);
    expect(await turnStatusResponse.json()).toMatchObject({
      id: turn.turnId,
      requestedBackendConfig: {
        cwd: TEST_REPO_PATH,
      },
      effectiveBackendConfig: {
        cwd: TEST_REPO_PATH,
      },
    });

    const streamResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}/stream?since=0`, {
      headers: { 'x-user-email': email },
    });
    expect(streamResponse.status).toBe(200);
    const streamText = await streamResponse.text();
    expect(streamText).toContain(`"cwd":"${TEST_REPO_PATH}"`);
  });

  it('normalizes project workspace paths through the runner filesystem endpoint', async () => {
    const email = randomEmail('http-runner-workspace');

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ name: 'HTTP Workspace Project', repoPath: './tmp/http-project' }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string; repoPath: string };
    expect(project.repoPath).toBe(path.resolve('./tmp/http-project'));

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'HTTP Workspace Session' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { projectId: string };
    expect(session.projectId).toBe(project.id);
  });

  it('uses project execution mode defaults when dispatching a turn', async () => {
    const email = randomEmail('http-runner-exec-defaults');

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({
        name: 'HTTP Exec Project',
        repoPath: TEST_REPO_PATH,
        backend: 'codex',
        backendConfig: {
          model: 'gpt-5-codex',
          executionMode: 'safe-write',
        },
      }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'HTTP Exec Session' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const turnResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'use project execution defaults' }),
    });
    expect(turnResponse.status).toBe(201);
    const turn = (await turnResponse.json()) as { turnId: string };

    await sleep(1300);

    const turnStatusResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}`, {
      headers: { 'x-user-email': email },
    });
    expect(turnStatusResponse.status).toBe(200);
    expect(await turnStatusResponse.json()).toMatchObject({
      id: turn.turnId,
      effectiveBackendConfig: {
        executionMode: 'safe-write',
      },
      effectiveRuntimeConfig: {
        sandbox: 'workspace-write',
      },
    });

    const streamResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}/stream?since=0`, {
      headers: { 'x-user-email': email },
    });
    expect(streamResponse.status).toBe(200);
    const streamText = await streamResponse.text();
    expect(streamText).toContain('"sandbox":"workspace-write"');
    expect(streamText).toContain('"approvalPolicy":"on-request"');
  });

  it('forks a session into a new session with copied history and a new codex thread id', async () => {
    const email = randomEmail('http-fork');

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ name: 'HTTP Fork Project', repoPath: TEST_REPO_PATH }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'HTTP Fork Session' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const turnResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'create forkable history' }),
    });
    expect(turnResponse.status).toBe(201);

    let readyToFork = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(250);
      const historyResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/history`, {
        headers: { 'x-user-email': email },
      });
      expect(historyResponse.status).toBe(200);
      const history = (await historyResponse.json()) as { activeTurnId: string | null };
      if (!history.activeTurnId) {
        readyToFork = true;
        break;
      }
    }
    expect(readyToFork).toBe(true);

    const forkResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({}),
    });
    expect(forkResponse.status).toBe(201);
    const forkedSession = (await forkResponse.json()) as { id: string; title: string; codexThreadId: string };
    expect(forkedSession.id).not.toBe(session.id);
    expect(forkedSession.title).toBe('HTTP Fork Session (Fork)');
    expect(forkedSession.codexThreadId).toMatch(/^forked-/);

    const historyResponse = await fetch(`${apiBaseUrl}/api/sessions/${forkedSession.id}/history`, {
      headers: { 'x-user-email': email },
    });
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as {
      messages: Array<{ role: string; content: string }>;
      turns: Array<unknown>;
    };
    expect(history.messages).toMatchObject([
      { role: 'user', content: 'create forkable history' },
      { role: 'assistant', content: expect.stringContaining('Echo: create forkable history') },
    ]);
    expect(history.turns).toHaveLength(0);
  });

  it('closes codex thread when deleting a session', async () => {
    const email = randomEmail('http-delete-close-thread');

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ name: 'Delete Session Project', repoPath: TEST_REPO_PATH }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'Delete Session Thread' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const turnResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'populate session thread id before delete' }),
    });
    expect(turnResponse.status).toBe(201);

    await sleep(1300);

    const deleteSessionResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}`, {
      method: 'DELETE',
      headers: { 'x-user-email': email },
    });
    expect(deleteSessionResponse.status).toBe(204);
    expect(runner.getClosedThreadIds()).toContain(`thread-${session.id}`);
  });

  it('manually compacts an idle session thread', async () => {
    const email = randomEmail('http-compact-session');

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ name: 'Compact Session Project', repoPath: TEST_REPO_PATH }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'Compact Session' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const turnResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'prepare thread before manual compact' }),
    });
    expect(turnResponse.status).toBe(201);

    await sleep(1300);

    const compactResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/compact`, {
      method: 'POST',
      headers: { 'x-user-email': email },
    });
    expect(compactResponse.status).toBe(202);
    expect(runner.getCompactedThreadIds()).toContain(`thread-${session.id}`);
  });

  it('steers an active turn through the http runner adapter when enabled', async () => {
    const email = randomEmail('http-steer');

    const settingsResponse = await fetch(`${apiBaseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ turnSteerEnabled: true }),
    });
    expect(settingsResponse.status).toBe(201);

    const projectResponse = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ name: 'HTTP Steer Project', repoPath: TEST_REPO_PATH }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await fetch(`${apiBaseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ title: 'HTTP Steer Session' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as { id: string };

    const turnResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'long running steer target' }),
    });
    expect(turnResponse.status).toBe(201);
    const turn = (await turnResponse.json()) as { turnId: string };

    await sleep(200);

    const steerResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ content: 'focus on tests only' }),
    });
    expect(steerResponse.status).toBe(201);

    await sleep(1300);

    const streamResponse = await fetch(`${apiBaseUrl}/api/turns/${turn.turnId}/stream?since=0`, {
      headers: { 'x-user-email': email },
    });
    expect(streamResponse.status).toBe(200);
    const streamText = await streamResponse.text();
    expect(streamText).toContain('[steer:focus on tests only]');

    const historyResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/history`, {
      headers: { 'x-user-email': email },
    });
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(history.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'focus on tests only' })]),
    );
  });

  it('returns and updates per-user settings', async () => {
    const email = randomEmail('http-settings');
    const otherEmail = randomEmail('http-settings-other');

    const initialResponse = await fetch(`${apiBaseUrl}/api/settings`, {
      headers: { 'x-user-email': email },
    });
    expect(initialResponse.status).toBe(200);
    const initialSettings = (await initialResponse.json()) as { turnSteerEnabled: boolean };
    expect(initialSettings.turnSteerEnabled).toBe(false);

    const updateResponse = await fetch(`${apiBaseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': email },
      body: JSON.stringify({ turnSteerEnabled: true }),
    });
    expect(updateResponse.status).toBe(201);
    const updatedSettings = (await updateResponse.json()) as { turnSteerEnabled: boolean };
    expect(updatedSettings.turnSteerEnabled).toBe(true);

    const otherUserResponse = await fetch(`${apiBaseUrl}/api/settings`, {
      headers: { 'x-user-email': otherEmail },
    });
    expect(otherUserResponse.status).toBe(200);
    const otherUserSettings = (await otherUserResponse.json()) as { turnSteerEnabled: boolean };
    expect(otherUserSettings.turnSteerEnabled).toBe(false);
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
    await sleep(220);

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

    const historyResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.id}/history`, {
      headers: { 'x-user-email': email },
    });
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(history.messages.some((message) => message.role === 'assistant' && message.content.length > 0)).toBe(true);
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
