import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/codexpanel';
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

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
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
      payload: { name: 'E2E Project', repoPath: '/workspace/e2e' },
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();
    expect(project.name).toBe('E2E Project');
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
      payload: { title: 'E2E Session' },
    });
    expect(createSessionResponse.statusCode).toBe(201);
    const session = createSessionResponse.json();
    expect(session.projectId).toBe(project.id);
    expect(session.title).toBe('E2E Session');
    expect(session.status).toBe('active');

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
});
