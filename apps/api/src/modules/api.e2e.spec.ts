import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from './prisma/prisma.service';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/agentwaypoint';
}

const TEST_REPO_PATH = process.cwd();

function randomEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('API e2e', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const prevRunnerMode = process.env.RUNNER_MODE;
  const prevRunnerBaseUrl = process.env.RUNNER_BASE_URL;

  beforeAll(async () => {
    process.env.RUNNER_MODE = 'mock';
    delete process.env.RUNNER_BASE_URL;

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    process.env.RUNNER_MODE = prevRunnerMode;
    process.env.RUNNER_BASE_URL = prevRunnerBaseUrl;
  });

  it('returns 401 when x-user-email header is missing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: 'UNAUTHORIZED',
      },
    });
  });

  it('creates and lists projects and sessions for a user', async () => {
    const email = randomEmail('flow');

    const createProjectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: {
        name: 'E2E Project',
        repoPath: '/workspace/e2e',
        defaultModel: 'gpt-5-codex',
        defaultSandbox: 'workspace-write',
        defaultApprovalPolicy: 'on-request',
      },
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();
    expect(project.name).toBe('E2E Project');
    expect(project.defaultModel).toBe('gpt-5-codex');
    expect(project.defaultSandbox).toBe('workspace-write');
    expect(project.defaultApprovalPolicy).toBe('on-request');
    expect(project.ownerUserId).toBeTypeOf('string');
    expect(project.id).toBeTypeOf('string');

    const listProjectsResponse = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { 'x-user-email': email },
    });
    expect(listProjectsResponse.statusCode).toBe(200);
    const projects = listProjectsResponse.json();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.some((item: { id: string }) => item.id === project.id)).toBe(true);

    const createSessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: {
        title: 'E2E Session',
        cwdOverride: '/workspace/e2e/session',
        modelOverride: 'gpt-5-mini',
        sandboxOverride: 'read-only',
        approvalPolicyOverride: 'never',
      },
    });
    expect(createSessionResponse.statusCode).toBe(201);
    const session = createSessionResponse.json();
    expect(session.projectId).toBe(project.id);
    expect(session.title).toBe('E2E Session');
    expect(session.status).toBe('active');
    expect(session.cwdOverride).toBe('/workspace/e2e/session');
    expect(session.modelOverride).toBe('gpt-5-mini');
    expect(session.sandboxOverride).toBe('read-only');
    expect(session.approvalPolicyOverride).toBe('never');

    const listSessionsResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
    });
    expect(listSessionsResponse.statusCode).toBe(200);
    const sessions = listSessionsResponse.json();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.some((item: { id: string }) => item.id === session.id)).toBe(true);
  });

  it('returns validation errors for invalid payloads', async () => {
    const email = randomEmail('validation');
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: { name: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'BAD_REQUEST',
        message: 'Validation failed',
      },
    });
  });

  it('lists available models', async () => {
    const email = randomEmail('models');

    const response = await app.inject({
      method: 'GET',
      url: '/api/models',
      headers: { 'x-user-email': email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          model: expect.any(String),
          displayName: expect.any(String),
        }),
      ]),
    });
  });

  it('hides resources from other users', async () => {
    const ownerEmail = randomEmail('owner');
    const otherEmail = randomEmail('other');

    const createProjectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': ownerEmail },
      payload: { name: 'Private Project', repoPath: TEST_REPO_PATH },
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();

    const getAsOtherUserResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}`,
      headers: { 'x-user-email': otherEmail },
    });
    expect(getAsOtherUserResponse.statusCode).toBe(404);
    expect(getAsOtherUserResponse.json()).toMatchObject({
      error: {
        code: 'NOT_FOUND',
      },
    });

    const listSessionsAsOtherUserResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': otherEmail },
    });
    expect(listSessionsAsOtherUserResponse.statusCode).toBe(404);
  });

  it('creates turn and streams completed events', async () => {
    const email = randomEmail('turn-complete');

    const createProjectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: { name: 'Turn Project', repoPath: TEST_REPO_PATH },
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();

    const createSessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: { title: 'Turn Session' },
    });
    expect(createSessionResponse.statusCode).toBe(201);
    const session = createSessionResponse.json();

    const createTurnResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/turns`,
      headers: { 'x-user-email': email },
      payload: { content: 'hello from e2e' },
    });
    expect(createTurnResponse.statusCode).toBe(201);
    expect(createTurnResponse.json()).toMatchObject({
      turnId: expect.any(String),
      status: 'queued',
    });

    const { turnId } = createTurnResponse.json() as { turnId: string };
    await sleep(1200);

    const streamResponse = await app.inject({
      method: 'GET',
      url: `/api/turns/${turnId}/stream`,
      headers: { 'x-user-email': email },
    });
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.headers['content-type']).toContain('text/event-stream');
    expect(streamResponse.payload).toContain('event: turn.started');
    expect(streamResponse.payload).toContain('event: assistant.delta');
    expect(streamResponse.payload).toContain('event: turn.completed');

    const turnStatusResponse = await app.inject({
      method: 'GET',
      url: `/api/turns/${turnId}`,
      headers: { 'x-user-email': email },
    });
    expect(turnStatusResponse.statusCode).toBe(200);
    expect(turnStatusResponse.json()).toMatchObject({
      id: turnId,
      status: 'completed',
      failureCode: null,
      failureMessage: null,
    });

    const historyResponse = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/history`,
      headers: { 'x-user-email': email },
    });
    expect(historyResponse.statusCode).toBe(200);
    const history = historyResponse.json() as {
      messages: Array<{ role: string; content: string }>;
      activeTurnId: string | null;
    };
    expect(history.messages.length).toBeGreaterThanOrEqual(2);
    expect(history.messages[0]).toMatchObject({ role: 'user', content: 'hello from e2e' });
    expect(history.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(history.activeTurnId).toBeNull();
  });

  it('cancels active turn', async () => {
    const email = randomEmail('turn-cancel');

    const createProjectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: { name: 'Cancel Project', repoPath: TEST_REPO_PATH },
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();

    const createSessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: { title: 'Cancel Session' },
    });
    expect(createSessionResponse.statusCode).toBe(201);
    const session = createSessionResponse.json();

    const createTurnResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/turns`,
      headers: { 'x-user-email': email },
      payload: { content: 'please cancel this turn' },
    });
    expect(createTurnResponse.statusCode).toBe(201);
    const { turnId } = createTurnResponse.json() as { turnId: string };

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/api/turns/${turnId}/cancel`,
      headers: { 'x-user-email': email },
    });
    expect(cancelResponse.statusCode).toBe(201);
    expect(cancelResponse.json()).toMatchObject({
      id: turnId,
      status: 'cancelled',
    });

    const turnStatusResponse = await app.inject({
      method: 'GET',
      url: `/api/turns/${turnId}`,
      headers: { 'x-user-email': email },
    });
    expect(turnStatusResponse.statusCode).toBe(200);
    expect(['queued', 'running', 'cancelled']).toContain(
      (turnStatusResponse.json() as { status: string }).status,
    );

    await sleep(300);
    const streamResponse = await app.inject({
      method: 'GET',
      url: `/api/turns/${turnId}/stream`,
      headers: { 'x-user-email': email },
    });
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.payload).toContain('event: turn.cancelled');
  });

  it('persists approval events and exposes pending approval in turn status', async () => {
    const email = randomEmail('turn-approval');

    const createProjectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: { name: 'Approval Project', repoPath: TEST_REPO_PATH },
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();

    const createSessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: { title: 'Approval Session' },
    });
    expect(createSessionResponse.statusCode).toBe(201);
    const session = createSessionResponse.json();

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    expect(user?.id).toBeTruthy();

    const userMessage = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'user',
        content: 'approval state should be persisted',
      },
    });
    const turn = await prisma.turn.create({
      data: {
        sessionId: session.id,
        userMessageId: userMessage.id,
        status: 'queued',
      },
      select: { id: true },
    });
    const turnId = turn.id;

    const approvalRequestedResponse = await app.inject({
      method: 'POST',
      url: `/internal/runner/turns/${turnId}/events`,
      payload: {
        type: 'turn.approval.requested',
        payload: {
          requestId: 'approval-e2e-1',
          kind: 'command_execution',
          reason: 'Need approval to run a command',
          command: 'git status',
          cwd: TEST_REPO_PATH,
        },
      },
    });
    expect(approvalRequestedResponse.statusCode).toBe(201);

    const pendingStatusResponse = await app.inject({
      method: 'GET',
      url: `/api/turns/${turnId}`,
      headers: { 'x-user-email': email },
    });
    expect(pendingStatusResponse.statusCode).toBe(200);
    expect(pendingStatusResponse.json()).toMatchObject({
      id: turnId,
      status: 'waiting_approval',
      pendingApproval: {
        id: 'approval-e2e-1',
        kind: 'command_execution',
        status: 'pending',
        decision: null,
      },
    });

    const approvalResolvedResponse = await app.inject({
      method: 'POST',
      url: `/internal/runner/turns/${turnId}/events`,
      payload: {
        type: 'turn.approval.resolved',
        payload: {
          requestId: 'approval-e2e-1',
          decision: 'approve',
        },
      },
    });
    expect(approvalResolvedResponse.statusCode).toBe(201);

    const resolvedStatusResponse = await app.inject({
      method: 'GET',
      url: `/api/turns/${turnId}`,
      headers: { 'x-user-email': email },
    });
    expect(resolvedStatusResponse.statusCode).toBe(200);
    expect(resolvedStatusResponse.json()).toMatchObject({
      id: turnId,
      status: 'running',
      pendingApproval: null,
    });

    const completionResponse = await app.inject({
      method: 'POST',
      url: `/internal/runner/turns/${turnId}/events`,
      payload: {
        type: 'turn.completed',
        payload: {
          content: 'Approval path finished',
        },
      },
    });
    expect(completionResponse.statusCode).toBe(201);

    const streamResponse = await app.inject({
      method: 'GET',
      url: `/api/turns/${turnId}/stream`,
      headers: { 'x-user-email': email },
    });
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.payload).toContain('event: turn.approval.requested');
    expect(streamResponse.payload).toContain('event: turn.approval.resolved');
    expect(streamResponse.payload).toContain('event: turn.completed');
  });
});
