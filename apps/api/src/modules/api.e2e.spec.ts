import 'reflect-metadata';
import { mkdtemp, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
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
  const prevDefaultWorkspaceRoot = process.env.DEFAULT_WORKSPACE_ROOT;

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
    process.env.DEFAULT_WORKSPACE_ROOT = prevDefaultWorkspaceRoot;
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
        backend: 'codex',
        backendConfig: {
          model: 'gpt-5-codex',
          executionMode: 'safe-write',
        },
      },
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();
    expect(project.name).toBe('E2E Project');
    expect(project.backend).toBe('codex');
    expect(project.backendConfig).toMatchObject({
      model: 'gpt-5-codex',
          executionMode: 'safe-write',
    });
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
      },
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

  it('creates missing workspace directories for project paths', async () => {
    const email = randomEmail('workspace-create');
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'aw-workspace-'));
    const projectPath = path.join(tempRoot, 'project-root');

    const createProjectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: {
        name: 'Workspace Project',
        repoPath: projectPath,
      },
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();
    expect(project.repoPath).toBe(projectPath);
    expect((await stat(projectPath)).isDirectory()).toBe(true);

    const createSessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: {
        title: 'Workspace Session',
      },
    });
    expect(createSessionResponse.statusCode).toBe(201);
  });

  it('uses latest project execution settings when creating a turn', async () => {
    const email = randomEmail('session-persisted-settings');

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: {
        name: 'Persisted Session Config',
        repoPath: TEST_REPO_PATH,
        backend: 'codex',
        backendConfig: {
          model: 'gpt-5-codex',
          executionMode: 'safe-write',
        },
      },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json() as { id: string };

    const sessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: { title: 'Session Snapshot' },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json() as { id: string };

    await prisma.project.update({
      where: { id: project.id },
      data: {
        backendConfig: {
          model: 'gpt-5-mini',
          executionMode: 'safe-write',
        },
      },
    });

    const createTurnResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/turns`,
      headers: { 'x-user-email': email },
      payload: { content: 'check persisted model' },
    });
    expect(createTurnResponse.statusCode).toBe(201);
    const { turnId } = createTurnResponse.json() as { turnId: string };

    await sleep(1200);

    const turnStatusResponse = await app.inject({
      method: 'GET',
      url: `/api/turns/${turnId}`,
      headers: { 'x-user-email': email },
    });
    expect(turnStatusResponse.statusCode).toBe(200);
    expect(turnStatusResponse.json()).toMatchObject({
      effectiveBackendConfig: {
        model: 'gpt-5-mini',
      },
    });
  });

  it('updates project config and applies it to existing sessions for new turns', async () => {
    const email = randomEmail('project-config-update');

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: {
        name: 'Project Config Source',
        repoPath: TEST_REPO_PATH,
        backend: 'codex',
        backendConfig: {
          model: 'gpt-5-codex',
          executionMode: 'safe-write',
        },
      },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json() as { id: string };

    const sessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: { title: 'Existing Session' },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json() as { id: string };

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      headers: { 'x-user-email': email },
      payload: {
        name: 'Project Config Updated',
        backendConfig: {
          model: 'gpt-5-mini',
          executionMode: 'safe-write',
        },
      },
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json()).toMatchObject({
      id: project.id,
      name: 'Project Config Updated',
      backendConfig: {
        model: 'gpt-5-mini',
          executionMode: 'safe-write',
      },
    });

    const historyResponse = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/history`,
      headers: { 'x-user-email': email },
    });
    expect(historyResponse.statusCode).toBe(200);
    expect(historyResponse.json()).toMatchObject({
      session: {
        id: session.id,
      },
    });
  });

  it('blocks backend switch when the project already has sessions', async () => {
    const email = randomEmail('project-backend-switch-blocked');

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: {
        name: 'Backend Switch Guard Project',
        repoPath: TEST_REPO_PATH,
        backend: 'codex',
        backendConfig: {
          model: 'gpt-5-codex',
          executionMode: 'safe-write',
        },
      },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json() as { id: string };

    const sessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: { title: 'Session Exists' },
    });
    expect(sessionResponse.statusCode).toBe(201);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      headers: { 'x-user-email': email },
      payload: {
        backend: 'claude',
        backendConfig: {
          model: 'claude-sonnet-4',
          executionMode: 'safe-write',
        },
      },
    });
    expect(patchResponse.statusCode).toBe(409);
    expect(patchResponse.json()).toMatchObject({
      message: 'Cannot change backend for a project that already has sessions',
    });
  });

  it('creates project workspace automatically when repoPath is omitted', async () => {
    const email = randomEmail('workspace-default-root');
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'aw-default-workspace-'));
    process.env.DEFAULT_WORKSPACE_ROOT = tempRoot;

    const createProjectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: {
        name: 'Auto Workspace Project',
      },
    });

    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json() as { repoPath: string };
    expect(project.repoPath.startsWith(`${tempRoot}${path.sep}`)).toBe(true);
    expect((await stat(project.repoPath)).isDirectory()).toBe(true);
  });

  it('creates unique workspace folder names when target folder already exists', async () => {
    const email = randomEmail('workspace-unique');
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'aw-unique-workspace-'));
    process.env.DEFAULT_WORKSPACE_ROOT = tempRoot;

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: {
        name: 'Duplicate Name Project',
      },
    });
    expect(firstResponse.statusCode).toBe(201);
    const firstProject = firstResponse.json() as { repoPath: string };

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: {
        name: 'Duplicate Name Project',
      },
    });
    expect(secondResponse.statusCode).toBe(201);
    const secondProject = secondResponse.json() as { repoPath: string };

    expect(secondProject.repoPath).not.toBe(firstProject.repoPath);
    expect((await stat(firstProject.repoPath)).isDirectory()).toBe(true);
    expect((await stat(secondProject.repoPath)).isDirectory()).toBe(true);
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

  it('validates claude backendConfig and allows creating claude project/session', async () => {
    const email = randomEmail('claude-project');

    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: {
        name: 'Claude Invalid Project',
        backend: 'claude',
        backendConfig: {
          executionMode: 'safe-write',
        },
      },
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json()).toMatchObject({
      error: {
        code: 'BAD_REQUEST',
        message: 'Validation failed',
      },
    });

    const createProjectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: {
        name: 'Claude Valid Project',
        backend: 'claude',
        repoPath: TEST_REPO_PATH,
        backendConfig: {
          model: 'claude-sonnet-4',
          executionMode: 'safe-write',
        },
      },
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json() as { id: string; backend: string; backendConfig: Record<string, unknown> };
    expect(project.backend).toBe('claude');
    expect(project.backendConfig).toMatchObject({
      model: 'claude-sonnet-4',
      executionMode: 'safe-write',
    });

    const createSessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: {
        title: 'Claude Session',
      },
    });
    expect(createSessionResponse.statusCode).toBe(201);
  });

  it('lists available models', async () => {
    const email = randomEmail('models');

    const response = await app.inject({
      method: 'GET',
      url: '/api/models?backend=codex',
      headers: { 'x-user-email': email },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          backend: 'codex',
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

  it('deletes a session for the owner', async () => {
    const email = randomEmail('session-delete');

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: { name: 'Session Delete Project', repoPath: TEST_REPO_PATH },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json();

    const sessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: { title: 'Session To Delete' },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json();

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}`,
      headers: { 'x-user-email': email },
    });
    expect(deleteResponse.statusCode).toBe(204);

    const listSessionsResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
    });
    expect(listSessionsResponse.statusCode).toBe(200);
    expect(listSessionsResponse.json()).toEqual([]);
  });

  it('deletes a project and cascades all sessions', async () => {
    const email = randomEmail('project-delete');

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: { name: 'Project To Delete', repoPath: TEST_REPO_PATH },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json();

    const firstSessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: { title: 'First Session' },
    });
    expect(firstSessionResponse.statusCode).toBe(201);

    const secondSessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: { title: 'Second Session' },
    });
    expect(secondSessionResponse.statusCode).toBe(201);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      headers: { 'x-user-email': email },
    });
    expect(deleteResponse.statusCode).toBe(204);

    const listProjectsResponse = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { 'x-user-email': email },
    });
    expect(listProjectsResponse.statusCode).toBe(200);
    expect(listProjectsResponse.json().some((item: { id: string }) => item.id === project.id)).toBe(false);
  });

  it('returns 409 when deleting a session with an active turn', async () => {
    const email = randomEmail('session-delete-active');

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-user-email': email },
      payload: { name: 'Active Turn Project', repoPath: TEST_REPO_PATH },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json();

    const sessionResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sessions`,
      headers: { 'x-user-email': email },
      payload: { title: 'Active Turn Session' },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json();

    const turnResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/turns`,
      headers: { 'x-user-email': email },
      payload: { content: 'start and keep active briefly' },
    });
    expect(turnResponse.statusCode).toBe(201);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}`,
      headers: { 'x-user-email': email },
    });
    expect(deleteResponse.statusCode).toBe(409);
    expect(deleteResponse.json()).toMatchObject({
      error: {
        code: 'CONFLICT',
      },
    });
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
      requestedBackendConfig: {
        cwd: TEST_REPO_PATH,
      },
      effectiveBackendConfig: {
        cwd: TEST_REPO_PATH,
      },
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
      turns: Array<{
        id: string;
        requestedBackendConfig: Record<string, unknown> | null;
        effectiveBackendConfig: Record<string, unknown> | null;
      }>;
      activeTurnId: string | null;
    };
    expect(history.messages.length).toBeGreaterThanOrEqual(2);
    expect(history.messages[0]).toMatchObject({ role: 'user', content: 'hello from e2e' });
    expect(history.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(history.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: turnId,
          requestedBackendConfig: expect.objectContaining({ cwd: TEST_REPO_PATH }),
          effectiveBackendConfig: expect.objectContaining({ cwd: TEST_REPO_PATH }),
        }),
      ]),
    );
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
    await sleep(220);

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

    const historyResponse = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/history`,
      headers: { 'x-user-email': email },
    });
    expect(historyResponse.statusCode).toBe(200);
    const history = historyResponse.json() as { messages: Array<{ role: string; content: string }> };
    expect(history.messages.some((message) => message.role === 'assistant' && message.content.length > 0)).toBe(true);
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
        payload: {
          command: 'git status',
          cwd: TEST_REPO_PATH,
        },
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
