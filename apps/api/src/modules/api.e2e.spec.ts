import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';

function randomEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
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
      payload: { name: 'Private Project' },
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
});
