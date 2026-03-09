import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';

type StartTurnBody = {
  turnId: string;
  sessionId: string;
  content: string;
};

type CancelTurnBody = {
  turnId: string;
};

type RunnerEventType = 'turn.started' | 'assistant.delta' | 'turn.completed' | 'turn.failed' | 'turn.cancelled';
type RunnerBackend = 'codex' | 'mock';

const port = Number(process.env.RUNNER_PORT ?? 4700);
const host = process.env.RUNNER_HOST ?? '127.0.0.1';
const authToken = process.env.RUNNER_AUTH_TOKEN?.trim() || null;
const apiBaseUrl = (process.env.RUNNER_API_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const runnerBackend: RunnerBackend = (process.env.RUNNER_BACKEND ?? 'codex').trim().toLowerCase() === 'mock' ? 'mock' : 'codex';
const codexBin = process.env.RUNNER_CODEX_BIN?.trim() || 'codex';
const codexDefaultCwd = process.env.RUNNER_CODEX_CWD?.trim() || process.cwd();
const codexDefaultModel = process.env.RUNNER_CODEX_MODEL?.trim() || null;
const codexApprovalPolicy = process.env.RUNNER_CODEX_APPROVAL_POLICY?.trim() || 'never';
const codexSandboxMode = process.env.RUNNER_CODEX_SANDBOX?.trim() || null;

type ActiveTurnBase = {
  turnId: string;
  sessionId: string;
  content: string;
  startedAt: string;
  finalized: boolean;
  backend: RunnerBackend;
};

type ActiveMockTurn = ActiveTurnBase & {
  backend: 'mock';
  timers: ReturnType<typeof setTimeout>[];
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ActiveCodexTurn = ActiveTurnBase & {
  backend: 'codex';
  process: ChildProcessWithoutNullStreams;
  threadId: string | null;
  codexTurnId: string | null;
  nextRequestId: number;
  pendingRequests: Map<number, PendingRequest>;
  assistantText: string;
  notificationQueue: Promise<void>;
  completionResolve: (() => void) | null;
  completionReject: ((error: Error) => void) | null;
};

type ActiveTurn = ActiveMockTurn | ActiveCodexTurn;

const activeTurns = new Map<string, ActiveTurn>();

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/runner/health') {
      sendJson(response, 200, { status: 'ok', backend: runnerBackend, activeTurnCount: activeTurns.size });
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, 404, {
        error: { code: 'NOT_FOUND', message: 'Route not found' },
      });
      return;
    }

    if (authToken) {
      const authHeader = request.headers.authorization;
      if (authHeader !== `Bearer ${authToken}`) {
        sendJson(response, 401, {
          error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization token' },
        });
        return;
      }
    }

    if (request.url === '/runner/turns/start') {
      const payload = parseStartTurnBody(await readJsonBody(request));
      const existing = activeTurns.get(payload.turnId);
      if (existing) {
        await cancelActiveTurn(existing, { emitCancelEvent: false });
      }

      sendJson(response, 202, {
        accepted: true,
        runnerRequestId: randomUUID(),
      });

      if (runnerBackend === 'mock') {
        const turn: ActiveMockTurn = {
          backend: 'mock',
          turnId: payload.turnId,
          sessionId: payload.sessionId,
          content: payload.content,
          startedAt: new Date().toISOString(),
          finalized: false,
          timers: [],
        };
        activeTurns.set(payload.turnId, turn);
        void startMockExecution(turn);
        return;
      }

      void startCodexExecution({
        turnId: payload.turnId,
        sessionId: payload.sessionId,
        content: payload.content,
      });
      return;
    }

    if (request.url === '/runner/turns/cancel') {
      const payload = parseCancelTurnBody(await readJsonBody(request));
      const turn = activeTurns.get(payload.turnId);
      const cancelled = !!turn;
      if (turn) {
        await cancelActiveTurn(turn, { emitCancelEvent: true });
      }
      sendJson(response, 202, {
        accepted: true,
        cancelled,
        runnerRequestId: randomUUID(),
      });
      return;
    }

    sendJson(response, 404, {
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    sendJson(response, 400, {
      error: { code: 'BAD_REQUEST', message },
    });
  }
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`[codexpanel-runner] listening on http://${host}:${port} (backend=${runnerBackend})`);
});

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw new Error('Request body is required');
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function parseStartTurnBody(input: unknown): StartTurnBody {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid start payload');
  }
  const record = input as Record<string, unknown>;
  const turnId = readNonEmptyString(record.turnId, 'turnId');
  const sessionId = readNonEmptyString(record.sessionId, 'sessionId');
  const content = readNonEmptyString(record.content, 'content');
  return { turnId, sessionId, content };
}

function parseCancelTurnBody(input: unknown): CancelTurnBody {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid cancel payload');
  }
  const record = input as Record<string, unknown>;
  return {
    turnId: readNonEmptyString(record.turnId, 'turnId'),
  };
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

async function startMockExecution(turn: ActiveMockTurn): Promise<void> {
  await notifyApi(turn.turnId, 'turn.started', {});

  const responseContent = `Echo: ${turn.content}`;
  const chunks = chunkText(responseContent, 12);
  chunks.forEach((chunk, index) => {
    const timer = setTimeout(() => {
      if (!activeTurns.has(turn.turnId)) {
        return;
      }
      void notifyApi(turn.turnId, 'assistant.delta', { text: chunk });
    }, 120 + index * 120);
    turn.timers.push(timer);
  });

  const finalizeTimer = setTimeout(() => {
    if (!activeTurns.has(turn.turnId)) {
      return;
    }
    void finalizeTurn(turn.turnId, 'turn.completed', { content: responseContent });
  }, 200 + chunks.length * 120);
  turn.timers.push(finalizeTimer);
}

async function startCodexExecution(input: StartTurnBody): Promise<void> {
  const codexProcess = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
    cwd: codexDefaultCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  let completionResolve: (() => void) | null = null;
  let completionReject: ((error: Error) => void) | null = null;
  const completionPromise = new Promise<void>((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
    const turn: ActiveCodexTurn = {
      backend: 'codex',
      turnId: input.turnId,
      sessionId: input.sessionId,
      content: input.content,
      startedAt: new Date().toISOString(),
      finalized: false,
      process: codexProcess,
      threadId: null,
      codexTurnId: null,
      nextRequestId: 1,
      pendingRequests: new Map<number, PendingRequest>(),
      assistantText: '',
      notificationQueue: Promise.resolve(),
      completionResolve,
      completionReject,
    };
    activeTurns.set(input.turnId, turn);
  });

  const turn = activeTurns.get(input.turnId);
  if (!turn || turn.backend !== 'codex') {
    return;
  }

  const stdoutReader = createInterface({ input: codexProcess.stdout });
  stdoutReader.on('line', (line) => {
    turn.notificationQueue = turn.notificationQueue
      .then(async () => {
        await handleCodexMessage(turn.turnId, line);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'unknown notification error';
        // eslint-disable-next-line no-console
        console.error(`[codexpanel-runner] notification error (${turn.turnId}): ${message}`);
      });
  });

  codexProcess.stderr.on('data', (chunk) => {
    const message = chunk.toString('utf8').trim();
    if (message) {
      // eslint-disable-next-line no-console
      console.error(`[codexpanel-runner] codex stderr (${turn.turnId}): ${message}`);
    }
  });

  codexProcess.on('error', (error) => {
    void failTurn(turn.turnId, `Failed to start codex app-server: ${error.message}`);
  });

  codexProcess.on('close', (code, signal) => {
    const active = activeTurns.get(turn.turnId);
    if (!active || active.backend !== 'codex' || active.finalized) {
      return;
    }
    const detail = `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
    void failTurn(turn.turnId, detail);
  });

  try {
    await sendCodexRequest(turn.turnId, 'initialize', {
      clientInfo: { name: 'codexpanel-runner', version: '0.1.0' },
      capabilities: null,
    });
    sendCodexNotification(turn.turnId, 'initialized', {});

    const threadStartResult = (await sendCodexRequest(turn.turnId, 'thread/start', {
      cwd: codexDefaultCwd,
      approvalPolicy: codexApprovalPolicy,
      sandbox: codexSandboxMode,
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })) as Record<string, unknown>;

    const threadId = readNestedString(threadStartResult, ['thread', 'id']);
    if (!threadId) {
      throw new Error('thread/start did not return thread id');
    }
    turn.threadId = threadId;

    const turnStartParams: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text: input.content, text_elements: [] }],
    };
    if (codexDefaultModel) {
      turnStartParams.model = codexDefaultModel;
    }
    const turnStartResult = (await sendCodexRequest(turn.turnId, 'turn/start', turnStartParams)) as Record<string, unknown>;
    turn.codexTurnId = readNestedString(turnStartResult, ['turn', 'id']);
    await notifyApi(turn.turnId, 'turn.started', {});
    await completionPromise;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown codex execution error';
    await failTurn(turn.turnId, message);
  }
}

async function handleCodexMessage(turnId: string, line: string): Promise<void> {
  const turn = activeTurns.get(turnId);
  if (!turn || turn.backend !== 'codex') {
    return;
  }

  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message: unknown;
  try {
    message = JSON.parse(trimmed) as unknown;
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[codexpanel-runner] invalid JSON from codex (${turnId}): ${trimmed}`);
    return;
  }

  if (!message || typeof message !== 'object') {
    return;
  }

  const record = message as Record<string, unknown>;
  if (typeof record.id === 'number' && ('result' in record || 'error' in record)) {
    resolveCodexRequest(turnId, record);
    return;
  }

  const method = record.method;
  if (typeof method !== 'string') {
    return;
  }
  const params = (record.params ?? {}) as Record<string, unknown>;
  await handleCodexNotification(turnId, method, params);
}

async function handleCodexNotification(turnId: string, method: string, params: Record<string, unknown>): Promise<void> {
  const turn = activeTurns.get(turnId);
  if (!turn || turn.backend !== 'codex' || turn.finalized) {
    return;
  }

  if (method === 'turn/started') {
    const codexTurnId = readNestedString(params, ['turn', 'id']);
    if (codexTurnId) {
      turn.codexTurnId = codexTurnId;
    }
    return;
  }

  if (method === 'item/agentMessage/delta') {
    const delta = readNestedString(params, ['delta']);
    if (delta) {
      turn.assistantText += delta;
      await notifyApi(turnId, 'assistant.delta', { text: delta });
    }
    return;
  }

  if (method === 'item/completed') {
    const itemType = readNestedString(params, ['item', 'type']);
    if (itemType === 'agentMessage') {
      const text = readNestedString(params, ['item', 'text']);
      if (text && turn.assistantText.length === 0) {
        turn.assistantText = text;
      }
    }
    return;
  }

  if (method === 'turn/completed') {
    const status = readNestedString(params, ['turn', 'status']);
    if (status === 'failed') {
      const message = readNestedString(params, ['turn', 'error', 'message']) || 'Codex turn failed';
      await finalizeTurn(turnId, 'turn.failed', { message });
      return;
    }
    if (status === 'interrupted') {
      await finalizeTurn(turnId, 'turn.cancelled', {});
      return;
    }

    const content = turn.assistantText || extractAssistantTextFromTurn(params) || '(no assistant output)';
    await finalizeTurn(turnId, 'turn.completed', { content });
    return;
  }

  if (method === 'error') {
    const message = readNestedString(params, ['error', 'message']) || 'Codex runner error';
    await finalizeTurn(turnId, 'turn.failed', { message });
  }
}

async function sendCodexRequest(turnId: string, method: string, params: unknown): Promise<unknown> {
  const turn = activeTurns.get(turnId);
  if (!turn || turn.backend !== 'codex' || turn.finalized) {
    throw new Error('Turn not active');
  }
  if (!turn.process.stdin.writable) {
    throw new Error(`codex stdin not writable for request: ${method}`);
  }

  const id = turn.nextRequestId++;
  const payload = JSON.stringify({ id, method, params });

  const response = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      turn.pendingRequests.delete(id);
      reject(new Error(`codex request timeout: ${method}`));
    }, 15000);
    turn.pendingRequests.set(id, { resolve, reject, timeout });
  });

  turn.process.stdin.write(`${payload}\n`);
  return response;
}

function sendCodexNotification(turnId: string, method: string, params: unknown): void {
  const turn = activeTurns.get(turnId);
  if (!turn || turn.backend !== 'codex' || turn.finalized || !turn.process.stdin.writable) {
    return;
  }
  turn.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
}

function resolveCodexRequest(turnId: string, message: Record<string, unknown>): void {
  const turn = activeTurns.get(turnId);
  if (!turn || turn.backend !== 'codex') {
    return;
  }

  const id = message.id;
  if (typeof id !== 'number') {
    return;
  }
  const pending = turn.pendingRequests.get(id);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timeout);
  turn.pendingRequests.delete(id);

  if ('error' in message && message.error) {
    const errorMessage = readNestedString(message, ['error', 'message']) || 'codex request failed';
    pending.reject(new Error(errorMessage));
    return;
  }
  pending.resolve(message.result);
}

async function failTurn(turnId: string, message: string): Promise<void> {
  await finalizeTurn(turnId, 'turn.failed', { message });
}

async function finalizeTurn(turnId: string, type: RunnerEventType, payload: Record<string, unknown>): Promise<void> {
  const turn = activeTurns.get(turnId);
  if (!turn || turn.finalized) {
    return;
  }
  turn.finalized = true;
  activeTurns.delete(turnId);

  if (turn.backend === 'mock') {
    clearTurnTimers(turn.timers);
  } else {
    turn.pendingRequests.forEach(({ timeout, reject }, requestId) => {
      clearTimeout(timeout);
      reject(new Error(`Turn ended before request ${requestId} resolved`));
    });
    turn.pendingRequests.clear();
    turn.process.kill('SIGTERM');
    turn.completionResolve?.();
  }

  await notifyApi(turnId, type, payload);
}

async function cancelActiveTurn(turn: ActiveTurn, options: { emitCancelEvent: boolean }): Promise<void> {
  if (!options.emitCancelEvent) {
    silentlyDisposeTurn(turn);
    return;
  }

  if (turn.backend === 'mock') {
    await finalizeTurn(turn.turnId, 'turn.cancelled', {});
    return;
  }

  if (turn.threadId && turn.codexTurnId) {
    try {
      await sendCodexRequest(turn.turnId, 'turn/interrupt', {
        threadId: turn.threadId,
        turnId: turn.codexTurnId,
      });
    } catch {
      // Best-effort interrupt; shutdown still proceeds.
    }
  }
  await finalizeTurn(turn.turnId, 'turn.cancelled', {});
}

function silentlyDisposeTurn(turn: ActiveTurn): void {
  if (turn.finalized) {
    return;
  }
  turn.finalized = true;
  activeTurns.delete(turn.turnId);
  if (turn.backend === 'mock') {
    clearTurnTimers(turn.timers);
    return;
  }
  turn.pendingRequests.forEach(({ timeout, reject }, requestId) => {
    clearTimeout(timeout);
    reject(new Error(`Turn replaced before request ${requestId} resolved`));
  });
  turn.pendingRequests.clear();
  turn.process.kill('SIGTERM');
  turn.completionResolve?.();
}

function extractAssistantTextFromTurn(params: Record<string, unknown>): string | null {
  const turn = params.turn;
  if (!turn || typeof turn !== 'object') {
    return null;
  }
  const items = (turn as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }

  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === 'agentMessage' && typeof record.text === 'string' && record.text.length > 0) {
      return record.text;
    }
  }
  return null;
}

function readNestedString(record: Record<string, unknown>, path: string[]): string | null {
  let value: unknown = record;
  for (const key of path) {
    if (!value || typeof value !== 'object') {
      return null;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'string' ? value : null;
}

async function notifyApi(turnId: string, type: RunnerEventType, payload: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(`${apiBaseUrl}/internal/runner/turns/${turnId}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ type, payload }),
    });

    if (!response.ok) {
      const body = await response.text();
      // eslint-disable-next-line no-console
      console.error(`[codexpanel-runner] callback failed: ${type} -> ${response.status} ${body}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown callback error';
    // eslint-disable-next-line no-console
    console.error(`[codexpanel-runner] callback error: ${type} -> ${message}`);
  }
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks.length > 0 ? chunks : [''];
}

function clearTurnTimers(timers: ReturnType<typeof setTimeout>[]): void {
  timers.forEach((timer) => clearTimeout(timer));
  timers.length = 0;
}
