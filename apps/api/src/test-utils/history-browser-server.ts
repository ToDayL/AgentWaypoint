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
