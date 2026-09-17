// Isolated browser fixture: mock AI runner, real PTY and authentication.
import 'reflect-metadata';
import { fork, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from '../modules/prisma/prisma.service';
import { AuthService } from '../modules/auth/auth.service';
import { TerminalsService } from '../modules/terminals/terminals.service';
import { TerminalsGateway } from '../modules/terminals/terminals.gateway';
import { setupSqliteTestDatabase } from './sqlite-test-database';

const database = await setupSqliteTestDatabase('aw-terminal-browser-');
process.env.RUNNER_MODE = 'mock';
delete process.env.TERMINAL_ORIGIN_POLICY;
delete process.env.TERMINAL_ALLOWED_ORIGINS;
delete process.env.PUBLIC_WEB_ORIGIN;
await writeFile(path.join(database.home, 'config.json'), '{}', { mode: 0o600 });
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  logger: false,
});
app.useGlobalFilters(new HttpExceptionFilter());
app.get(TerminalsGateway).install(app.getHttpServer());
const terminals = app.get(TerminalsService);
const capabilities = terminals.capabilities.bind(terminals);
terminals.capabilities = () => ({ ...capabilities(), enabled: true, reason: null });
await app.listen(0, '127.0.0.1');
const address = app.getHttpServer().address();
if (!address || typeof address === 'string') throw new Error('Expected an API TCP listener');
const apiPort = address.port;
const prisma = app.get(PrismaService);
const email = 'terminal-browser@example.test';
const password = 'Terminal-test-password-123';
const user = await prisma.user.create({
  data: { email, role: 'admin', passwordHash: await app.get(AuthService).hashPassword(password) },
});
const backendConfig = { model: 'gpt-5-codex', effort: 'low', executionMode: 'yolo' };
const project = await prisma.project.create({
  data: {
    name: 'Terminal browser test',
    ownerUserId: user.id,
    repoPath: database.defaultWorkspaceRoot,
    backendConfig,
  },
});
const session = await prisma.session.create({
  data: {
    projectId: project.id,
    title: 'Terminal session',
    status: 'idle',
    meta: {
      runtime: {
        backend: 'codex',
        cwd: database.defaultWorkspaceRoot,
        backendConfig,
        autoApprove: false,
      },
    },
  },
});
const web: ChildProcess = fork(
  fileURLToPath(new URL('../../../web/server.mjs', import.meta.url)),
  process.env.AW_TERMINAL_TEST_WEB_DEV ? ['--dev'] : [],
  {
    execArgv: [],
    env: {
      ...process.env,
      PORT: '0',
      LISTEN_IP: '127.0.0.1',
      API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      NODE_ENV: process.env.AW_TERMINAL_TEST_WEB_DEV ? 'development' : 'production',
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  },
);
web.once('message', (message: any) =>
  process.send?.({
    url: `http://127.0.0.1:${message.port}`,
    apiPort,
    sessionId: session.id,
    email,
    password,
  }),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (web.exitCode === null && web.signalCode === null) {
    const exited = new Promise<void>((resolve) => web.once('exit', () => resolve()));
    web.kill('SIGTERM');
    await exited;
  }
  app.get(TerminalsGateway).onModuleDestroy();
  await terminals.onModuleDestroy();
  await app.close();
  await database.cleanup();
  process.exit(0);
}
process.on('message', (message) => {
  if (message === 'stop') void stop();
});
process.on('SIGTERM', () => void stop());
process.on('disconnect', () => void stop());
