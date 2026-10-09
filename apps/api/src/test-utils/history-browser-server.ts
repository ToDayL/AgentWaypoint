// Real HTTP/history/SSE with a controlled runner; never uses live data or AI.
import "reflect-metadata";
import { fork } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "../app.module";
import { HttpExceptionFilter } from "../common/filters/http-exception.filter";
import { PrismaService } from "../modules/prisma/prisma.service";
import { AuthService } from "../modules/auth/auth.service";
import {
  RUNNER_ADAPTER,
  type RunnerAdapter,
} from "../modules/runner/runner.types";
import { TurnsService } from "../modules/turns/turns.service";
import { setupSqliteTestDatabase } from "./sqlite-test-database";

const database = await setupSqliteTestDatabase("aw-history-browser-");
process.env.RUNNER_MODE = "mock";
await writeFile(path.join(database.home, "config.json"), "{}", { mode: 0o600 });
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter(),
  { logger: false },
);
app.useGlobalFilters(new HttpExceptionFilter());
const runner = app.get<RunnerAdapter>(RUNNER_ADAPTER);
runner.supportsMessageHistory = () => true;
runner.startTurn = async (input) => {
  await app
    .get(TurnsService)
    .ingestRunnerEvent(input.turnId, "turn.started", {
      historyVersion: 2,
      backendTurnId: "controlled-turn",
    });
};
runner.steerTurn = async () => undefined;
await app.listen(0, "127.0.0.1");
const address = app.getHttpServer().address();
if (!address || typeof address === "string")
  throw new Error("Expected API TCP listener");
const apiUrl = `http://127.0.0.1:${address.port}`;
const prisma = app.get(PrismaService);
const email = "history-browser@example.test";
const password = "History-test-password-123";
const user = await prisma.user.create({
  data: {
    email,
    role: "admin",
    turnSteerEnabled: true,
    passwordHash: await app.get(AuthService).hashPassword(password),
  },
});
const backendConfig = {
  model: "gpt-5-codex",
  effort: "low",
  executionMode: "yolo",
};
const project = await prisma.project.create({
  data: {
    name: "History test",
    ownerUserId: user.id,
    repoPath: database.defaultWorkspaceRoot,
    backendConfig,
  },
});
const longSession = await prisma.session.create({
  data: {
    projectId: project.id,
    title: 'Long message history',
    status: 'active',
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
const historyStart = Date.now() - 700_000;
const oldTurnIds = Array.from({ length: 100 }, () => crypto.randomUUID());
await prisma.turn.createMany({
  data: oldTurnIds.map((id, index) => ({
    id,
    sessionId: longSession.id,
    status: 'completed',
    historyVersion: 2,
    createdAt: new Date(historyStart + index * 6000),
  })),
});
await prisma.message.createMany({
  data: Array.from({ length: 600 }, (_, index) => ({
    sessionId: longSession.id,
    turnId: oldTurnIds[Math.floor(index / 6)]!,
    backendItemId: `history-${index}`,
    historySeq: index + 1,
    role: index % 6 === 0 ? 'user' : 'assistant',
    state: 'completed',
    content:
      `History message ${index}\n\n` +
      (index % 7 === 0
        ? 'A paragraph with **bold text**, a link [reference](https://example.test), and several words.\n\n'.repeat(
            14,
          )
        : 'A short message.'),
    createdAt: new Date(historyStart + index * 1000),
  })),
});
const longTurn = await app
  .get(TurnsService)
  .createTurnForSession(user.id, longSession.id, { content: 'Continue long history' });
const timelineSession = await prisma.session.create({
  data: {
    projectId: project.id,
    title: 'Long event timeline',
    status: 'active',
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
const timelineTurn = await app
  .get(TurnsService)
  .createTurnForSession(user.id, timelineSession.id, { content: 'Inspect a long timeline' });
await prisma.event.createMany({
  data: Array.from({ length: 800 }, (_, index) => ({
    turnId: timelineTurn.turnId,
    seq: index + 2,
    type: 'tool.completed',
    payload: {
      itemId: `timeline-${index}`,
      kind: 'customTool',
      title: `Timeline tool ${index}`,
      summary:
        index % 5 === 0
          ? Array.from(
              { length: 32 },
              (_, line) => `Output ${index}, line ${line}: details for dynamic height measurement.`,
            ).join('\n')
          : `Short output ${index}.`,
    },
  })),
});

const legacySession = await prisma.session.create({
  data: { projectId: project.id, title: 'Legacy protocol history', status: 'active' },
});
const legacyMessage = await prisma.message.create({
  data: { sessionId: legacySession.id, role: 'user', content: 'Legacy input', historySeq: 1 },
});
const legacyTurn = await prisma.turn.create({
  data: { sessionId: legacySession.id, userMessageId: legacyMessage.id, status: 'running', historyVersion: 1 },
});
const session = await prisma.session.create({
  data: {
    projectId: project.id,
    title: "Message history",
    status: "active",
    meta: {
      runtime: {
        backend: "codex",
        cwd: database.defaultWorkspaceRoot,
        backendConfig,
        autoApprove: false,
      },
    },
  },
});
const turn = await app
  .get(TurnsService)
  .createTurnForSession(user.id, session.id, { content: "Initial request" });
const web = fork(
  fileURLToPath(new URL("../../../web/server.mjs", import.meta.url)),
  [],
  {
    execArgv: [],
    env: {
      ...process.env,
      PORT: "0",
      LISTEN_IP: "127.0.0.1",
      API_BASE_URL: apiUrl,
      NODE_ENV: "production",
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  },
);
web.once("message", (message: { port: number }) =>
  process.send?.({
    url: `http://127.0.0.1:${message.port}`,
    apiUrl,
    sessionId: session.id,
    turnId: turn.turnId,
    longSessionId: longSession.id,
    longTurnId: longTurn.turnId,
    timelineSessionId: timelineSession.id,
    timelineTurnId: timelineTurn.turnId,
    legacySessionId: legacySession.id,
    legacyTurnId: legacyTurn.id,
    email,
    password,
  }),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (web.exitCode === null && web.signalCode === null) {
    const exited = new Promise<void>((resolve) =>
      web.once("exit", () => resolve()),
    );
    web.kill("SIGTERM");
    await exited;
  }
  await app.close();
  await database.cleanup();
  process.exit(0);
}
process.on("message", (message) => {
  if (message === "stop") void stop();
});
process.on("SIGTERM", () => void stop());
process.on("disconnect", () => void stop());
