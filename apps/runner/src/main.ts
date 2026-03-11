import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';

type StartTurnBody = {
  turnId: string;
  sessionId: string;
  content: string;
  threadId?: string | null;
  cwd?: string | null;
};

type CancelTurnBody = {
  turnId: string;
};

type ResolveApprovalBody = {
  turnId: string;
  requestId: string;
  decision:
    | 'accept'
    | 'acceptForSession'
    | 'decline'
    | 'cancel'
    | {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: string[];
        };
      }
    | {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            action: 'allow' | 'deny';
            host: string;
          };
        };
      };
};

type RunnerEventType =
  | 'turn.started'
  | 'assistant.delta'
  | 'turn.approval.requested'
  | 'turn.approval.resolved'
  | 'plan.updated'
  | 'reasoning.delta'
  | 'diff.updated'
  | 'tool.started'
  | 'tool.output'
  | 'tool.completed'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled';
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

type ActiveCodexTurn = ActiveTurnBase & {
  backend: 'codex';
  threadId: string | null;
  codexTurnId: string | null;
  assistantText: string;
  completionResolve: (() => void) | null;
  completionReject: ((error: Error) => void) | null;
};

type ActiveTurn = ActiveMockTurn | ActiveCodexTurn;

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingApprovalRequest = {
  worker: CodexWorker;
  rawRequestId: string | number;
  requestId: string;
  turnId: string;
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval' | 'item/permissions/requestApproval';
  params: Record<string, unknown>;
};

type CodexWorker = {
  process: ChildProcessWithoutNullStreams;
  nextRequestId: number;
  pendingRequests: Map<number, PendingRequest>;
  notificationQueue: Promise<void>;
  readyPromise: Promise<void>;
  closed: boolean;
};

const activeTurns = new Map<string, ActiveTurn>();
const pendingApprovalRequests = new Map<string, PendingApprovalRequest>();
let codexWorkerPromise: Promise<CodexWorker> | null = null;

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
        threadId: payload.threadId ?? null,
        cwd: payload.cwd ?? null,
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

    if (request.url === '/runner/turns/approval') {
      const payload = parseResolveApprovalBody(await readJsonBody(request));
      await resolvePendingApproval(payload);
      sendJson(response, 202, {
        accepted: true,
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
  console.log(`[agentwaypoint-runner] listening on http://${host}:${port} (backend=${runnerBackend})`);
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
  const threadId = readOptionalString(record.threadId);
  const cwd = readOptionalString(record.cwd);
  return { turnId, sessionId, content, threadId, cwd };
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

function parseResolveApprovalBody(input: unknown): ResolveApprovalBody {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid approval payload');
  }
  const record = input as Record<string, unknown>;

  return {
    turnId: readNonEmptyString(record.turnId, 'turnId'),
    requestId: readNonEmptyString(record.requestId, 'requestId'),
    decision: parseApprovalDecision(record.decision),
  };
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('threadId must be a string when provided');
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  let completionResolve: (() => void) | null = null;
  let completionReject: ((error: Error) => void) | null = null;
  const completionPromise = new Promise<void>((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
  });

  const turn: ActiveCodexTurn = {
    backend: 'codex',
    turnId: input.turnId,
    sessionId: input.sessionId,
    content: input.content,
    startedAt: new Date().toISOString(),
    finalized: false,
    threadId: null,
    codexTurnId: null,
    assistantText: '',
    completionResolve,
    completionReject,
  };
  activeTurns.set(input.turnId, turn);

  try {
    const worker = await ensureCodexWorker();
    await worker.readyPromise;

    const workspaceCwd = input.cwd?.trim() || codexDefaultCwd;
    const threadId = await resolveThreadId(worker, input.threadId ?? null, workspaceCwd);
    turn.threadId = threadId;

    const turnStartParams: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text: input.content, text_elements: [] }],
      cwd: workspaceCwd,
    };
    if (codexDefaultModel) {
      turnStartParams.model = codexDefaultModel;
    }

    const turnStartResult = (await sendWorkerRequest(worker, 'turn/start', turnStartParams)) as Record<string, unknown>;
    turn.codexTurnId = readNestedString(turnStartResult, ['turn', 'id']);

    await notifyApi(turn.turnId, 'turn.started', { threadId });
    await completionPromise;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown codex execution error';
    await failTurn(turn.turnId, message);
  }
}

async function ensureCodexWorker(): Promise<CodexWorker> {
  if (runnerBackend !== 'codex') {
    throw new Error('Codex worker requested when backend is not codex');
  }
  if (codexWorkerPromise) {
    return codexWorkerPromise;
  }

  codexWorkerPromise = (async () => {
    const child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd: codexDefaultCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const worker: CodexWorker = {
      process: child,
      nextRequestId: 1,
      pendingRequests: new Map<number, PendingRequest>(),
      notificationQueue: Promise.resolve(),
      readyPromise: Promise.resolve(),
      closed: false,
    };

    const stdoutReader = createInterface({ input: child.stdout });
    stdoutReader.on('line', (line) => {
      worker.notificationQueue = worker.notificationQueue
        .then(async () => {
          await handleWorkerMessage(worker, line);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'unknown worker message error';
          // eslint-disable-next-line no-console
          console.error(`[agentwaypoint-runner] worker notification error: ${message}`);
        });
    });

    child.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (message) {
        // eslint-disable-next-line no-console
        console.error(`[agentwaypoint-runner] codex stderr: ${message}`);
      }
    });

    child.on('error', (error) => {
      handleWorkerExit(worker, `Failed to start codex app-server: ${error.message}`);
    });

    child.on('close', (code, signal) => {
      handleWorkerExit(worker, `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });

    worker.readyPromise = (async () => {
      await sendWorkerRequest(worker, 'initialize', {
        clientInfo: { name: 'agentwaypoint-runner', version: '0.1.0' },
        capabilities: null,
      });
      sendWorkerNotification(worker, 'initialized', {});
    })();

    return worker;
  })();

  return codexWorkerPromise;
}

function handleWorkerExit(worker: CodexWorker, reason: string): void {
  if (worker.closed) {
    return;
  }
  worker.closed = true;

  worker.pendingRequests.forEach(({ timeout, reject }) => {
    clearTimeout(timeout);
    reject(new Error(reason));
  });
  worker.pendingRequests.clear();

  codexWorkerPromise = null;

  activeTurns.forEach((turn) => {
    if (turn.backend === 'codex' && !turn.finalized) {
      void failTurn(turn.turnId, reason);
    }
  });
}

async function resolveThreadId(worker: CodexWorker, preferredThreadId: string | null, cwd: string): Promise<string> {
  if (preferredThreadId) {
    try {
      await sendWorkerRequest(worker, 'thread/resume', {
        threadId: preferredThreadId,
        cwd,
        persistExtendedHistory: false,
      });
      return preferredThreadId;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown resume error';
      // eslint-disable-next-line no-console
      console.error(`[agentwaypoint-runner] thread/resume failed for ${preferredThreadId}: ${message}`);
    }
  }

  const threadStartResult = (await sendWorkerRequest(worker, 'thread/start', {
    cwd,
    approvalPolicy: codexApprovalPolicy,
    sandbox: codexSandboxMode,
    ephemeral: false,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  })) as Record<string, unknown>;

  const threadId = readNestedString(threadStartResult, ['thread', 'id']);
  if (!threadId) {
    throw new Error('thread/start did not return thread id');
  }
  return threadId;
}

async function handleWorkerMessage(worker: CodexWorker, line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message: unknown;
  try {
    message = JSON.parse(trimmed) as unknown;
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[agentwaypoint-runner] invalid JSON from codex worker: ${trimmed}`);
    return;
  }

  if (!message || typeof message !== 'object') {
    return;
  }

  const record = message as Record<string, unknown>;
  if (typeof record.id === 'number' && ('result' in record || 'error' in record)) {
    resolveWorkerRequest(worker, record);
    return;
  }

  if ((typeof record.id === 'number' || typeof record.id === 'string') && typeof record.method === 'string') {
    await handleServerRequest(worker, record);
    return;
  }

  const method = record.method;
  if (typeof method !== 'string') {
    return;
  }
  const params = (record.params ?? {}) as Record<string, unknown>;
  await handleCodexNotification(method, params);
}

async function sendWorkerRequest(worker: CodexWorker, method: string, params: unknown): Promise<unknown> {
  if (worker.closed || !worker.process.stdin.writable) {
    throw new Error(`codex worker unavailable for request: ${method}`);
  }

  const id = worker.nextRequestId++;
  const payload = JSON.stringify({ id, method, params });

  const response = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.pendingRequests.delete(id);
      reject(new Error(`codex request timeout: ${method}`));
    }, 15000);
    worker.pendingRequests.set(id, { resolve, reject, timeout });
  });

  worker.process.stdin.write(`${payload}\n`);
  return response;
}

function sendWorkerNotification(worker: CodexWorker, method: string, params: unknown): void {
  if (worker.closed || !worker.process.stdin.writable) {
    return;
  }
  worker.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
}

function resolveWorkerRequest(worker: CodexWorker, message: Record<string, unknown>): void {
  const id = message.id;
  if (typeof id !== 'number') {
    return;
  }

  const pending = worker.pendingRequests.get(id);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timeout);
  worker.pendingRequests.delete(id);

  if ('error' in message && message.error) {
    const errorMessage = readNestedString(message, ['error', 'message']) || 'codex request failed';
    pending.reject(new Error(errorMessage));
    return;
  }
  pending.resolve(message.result);
}

async function handleCodexNotification(method: string, params: Record<string, unknown>): Promise<void> {
  if (method === 'turn/started') {
    const threadId = readNestedString(params, ['threadId']);
    const codexTurnId = readNestedString(params, ['turn', 'id']);
    if (!threadId) {
      return;
    }
    const turn = findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      return;
    }
    if (codexTurnId) {
      turn.codexTurnId = codexTurnId;
    }
    return;
  }

  if (method === 'item/agentMessage/delta') {
    const threadId = readNestedString(params, ['threadId']);
    const codexTurnId = readNestedString(params, ['turnId']);
    const delta = readNestedString(params, ['delta']);
    if (!threadId || !delta) {
      return;
    }
    const turn = findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      return;
    }
    if (codexTurnId && !turn.codexTurnId) {
      turn.codexTurnId = codexTurnId;
    }
    turn.assistantText += delta;
    await notifyApi(turn.turnId, 'assistant.delta', { text: delta });
    return;
  }

  if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
    const threadId = readNestedString(params, ['threadId']);
    const codexTurnId = readNestedString(params, ['turnId']);
    if (!threadId) {
      return;
    }
    const turn = findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      return;
    }
    const payload = buildToolOutputPayload(method, params);
    if (!payload.text) {
      return;
    }
    await notifyApi(turn.turnId, 'tool.output', payload);
    return;
  }

  if (method === 'item/completed') {
    const threadId = readNestedString(params, ['threadId']);
    const codexTurnId = readNestedString(params, ['turnId']);
    if (!threadId) {
      return;
    }
    const turn = findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      return;
    }

    const itemType = readNestedString(params, ['item', 'type']);
    if (itemType === 'agentMessage') {
      const text = readNestedString(params, ['item', 'text']);
      if (text && turn.assistantText.length === 0) {
        turn.assistantText = text;
      }
      return;
    }

    await notifyApi(turn.turnId, 'tool.completed', buildToolLifecyclePayload('completed', params));
    return;
  }

  if (method === 'item/started') {
    const threadId = readNestedString(params, ['threadId']);
    const codexTurnId = readNestedString(params, ['turnId']);
    if (!threadId) {
      return;
    }
    const turn = findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      return;
    }
    await notifyApi(turn.turnId, 'tool.started', buildToolLifecyclePayload('started', params));
    return;
  }

  if (method === 'turn/plan/updated') {
    const threadId = readNestedString(params, ['threadId']);
    const codexTurnId = readNestedString(params, ['turnId']);
    if (!threadId) {
      return;
    }
    const turn = findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      return;
    }
    await notifyApi(turn.turnId, 'plan.updated', {
      explanation: typeof params.explanation === 'string' ? params.explanation : null,
      plan: Array.isArray(params.plan) ? params.plan : [],
    });
    return;
  }

  if (
    method === 'item/reasoning/textDelta' ||
    method === 'item/reasoning/summaryTextDelta' ||
    method === 'item/plan/delta'
  ) {
    const threadId = readNestedString(params, ['threadId']);
    const codexTurnId = readNestedString(params, ['turnId']);
    const delta = readNestedString(params, ['delta']);
    if (!threadId || !delta) {
      return;
    }
    const turn = findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      return;
    }
    await notifyApi(turn.turnId, 'reasoning.delta', {
      kind: method === 'item/plan/delta' ? 'plan' : method === 'item/reasoning/summaryTextDelta' ? 'summary' : 'reasoning',
      itemId: readNestedString(params, ['itemId']),
      delta,
    });
    return;
  }

  if (method === 'turn/diff/updated') {
    const threadId = readNestedString(params, ['threadId']);
    const codexTurnId = readNestedString(params, ['turnId']);
    if (!threadId) {
      return;
    }
    const turn = findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      return;
    }
    await notifyApi(turn.turnId, 'diff.updated', {
      diffStat: readOptionalObject(params.diffStat),
      diffAvailable: params.diff !== undefined || params.unifiedDiff !== undefined,
      unifiedDiff: readOptionalPayloadString(params.unifiedDiff),
      diff: readOptionalPayloadString(params.diff),
    });
    return;
  }

  if (method === 'turn/completed') {
    const threadId = readNestedString(params, ['threadId']);
    const codexTurnId = readNestedString(params, ['turn', 'id']);
    if (!threadId) {
      return;
    }
    const turn = findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      return;
    }

    const status = readNestedString(params, ['turn', 'status']);
    if (status === 'failed') {
      const message = readNestedString(params, ['turn', 'error', 'message']) || 'Codex turn failed';
      await finalizeTurn(turn.turnId, 'turn.failed', { message });
      return;
    }
    if (status === 'interrupted') {
      await finalizeTurn(turn.turnId, 'turn.cancelled', {});
      return;
    }

    const content = turn.assistantText || extractAssistantTextFromTurn(params) || '(no assistant output)';
    await finalizeTurn(turn.turnId, 'turn.completed', { content });
    return;
  }

  if (method === 'error') {
    const threadId = readNestedString(params, ['threadId']);
    const codexTurnId = readNestedString(params, ['turnId']);
    if (!threadId) {
      return;
    }
    const turn = findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      return;
    }

    const message = readNestedString(params, ['error', 'message']) || 'Codex runner error';
    await finalizeTurn(turn.turnId, 'turn.failed', { message });
  }
}

async function handleServerRequest(worker: CodexWorker, message: Record<string, unknown>): Promise<void> {
  const rawRequestId = message.id;
  if (typeof rawRequestId !== 'number' && typeof rawRequestId !== 'string') {
    return;
  }

  const method = message.method;
  if (
    method !== 'item/commandExecution/requestApproval' &&
    method !== 'item/fileChange/requestApproval' &&
    method !== 'item/permissions/requestApproval'
  ) {
    respondToServerRequest(worker, rawRequestId, { error: { message: `Unsupported server request: ${String(method)}` } });
    return;
  }

  const params = message.params;
  if (!params || typeof params !== 'object') {
    respondToServerRequest(worker, rawRequestId, { error: { message: 'Server request params must be an object' } });
    return;
  }

  const paramsRecord = params as Record<string, unknown>;
  const threadId = readNestedString(paramsRecord, ['threadId']);
  const codexTurnId = readNestedString(paramsRecord, ['turnId']);
  if (!threadId) {
    respondToServerRequest(worker, rawRequestId, { error: { message: 'Approval request missing threadId' } });
    return;
  }

  const turn = findTurnByThread(threadId, codexTurnId);
  if (!turn || turn.finalized) {
    respondToServerRequest(worker, rawRequestId, { error: { message: 'Approval request turn is no longer active' } });
    return;
  }

  const requestId = String(rawRequestId);
  pendingApprovalRequests.set(requestId, {
    worker,
    rawRequestId,
    requestId,
    turnId: turn.turnId,
    method,
    params: paramsRecord,
  });

  await notifyApi(turn.turnId, 'turn.approval.requested', buildApprovalRequestedPayload(requestId, method, paramsRecord));
}

function findTurnByThread(threadId: string, codexTurnId: string | null): ActiveCodexTurn | null {
  let fallback: ActiveCodexTurn | null = null;
  for (const turn of activeTurns.values()) {
    if (turn.backend !== 'codex' || turn.finalized || turn.threadId !== threadId) {
      continue;
    }
    if (codexTurnId && turn.codexTurnId === codexTurnId) {
      return turn;
    }
    if (!fallback) {
      fallback = turn;
    }
  }
  return fallback;
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
  await disposePendingApprovalsForTurn(turnId, 'decline');
  activeTurns.delete(turnId);

  if (turn.backend === 'mock') {
    clearTurnTimers(turn.timers);
  } else {
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
      const worker = await ensureCodexWorker();
      await sendWorkerRequest(worker, 'turn/interrupt', {
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
  void disposePendingApprovalsForTurn(turn.turnId, 'decline');
  activeTurns.delete(turn.turnId);
  if (turn.backend === 'mock') {
    clearTurnTimers(turn.timers);
    return;
  }
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
      console.error(`[agentwaypoint-runner] callback failed: ${type} -> ${response.status} ${body}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown callback error';
    // eslint-disable-next-line no-console
    console.error(`[agentwaypoint-runner] callback error: ${type} -> ${message}`);
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

async function resolvePendingApproval(input: ResolveApprovalBody): Promise<void> {
  const pending = pendingApprovalRequests.get(input.requestId);
  if (!pending || pending.turnId !== input.turnId) {
    throw new Error('Pending approval not found');
  }

  const result = buildApprovalResponse(pending.method, pending.params, input.decision);
  respondToServerRequest(pending.worker, pending.rawRequestId, { result });
  pendingApprovalRequests.delete(input.requestId);
  await notifyApi(input.turnId, 'turn.approval.resolved', {
    requestId: input.requestId,
    decision: describeApprovalDecision(input.decision),
  });
}

async function disposePendingApprovalsForTurn(turnId: string, decision: 'decline' | 'cancel'): Promise<void> {
  const pendingIds = [...pendingApprovalRequests.values()]
    .filter((entry) => entry.turnId === turnId)
    .map((entry) => entry.requestId);

  for (const requestId of pendingIds) {
    const pending = pendingApprovalRequests.get(requestId);
    if (!pending) {
      continue;
    }
    const result = buildApprovalResponse(pending.method, pending.params, decision);
    respondToServerRequest(pending.worker, pending.rawRequestId, { result });
    pendingApprovalRequests.delete(requestId);
    await notifyApi(turnId, 'turn.approval.resolved', {
      requestId,
      decision: describeApprovalDecision(decision),
    });
  }
}

function respondToServerRequest(
  worker: CodexWorker,
  requestId: string | number,
  response: { result?: unknown; error?: { message: string } },
): void {
  if (worker.closed || !worker.process.stdin.writable) {
    return;
  }

  if (response.error) {
    worker.process.stdin.write(
      `${JSON.stringify({ id: requestId, error: { code: -32603, message: response.error.message } })}\n`,
    );
    return;
  }

  worker.process.stdin.write(`${JSON.stringify({ id: requestId, result: response.result ?? {} })}\n`);
}

function buildApprovalRequestedPayload(
  requestId: string,
  method: PendingApprovalRequest['method'],
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (method === 'item/commandExecution/requestApproval') {
    return {
      requestId,
      kind: 'command_execution',
      reason: readOptionalPayloadString(params.reason),
      command: readOptionalPayloadString(params.command),
      cwd: readOptionalPayloadString(params.cwd),
      itemId: readOptionalPayloadString(params.itemId),
      approvalId: readOptionalPayloadString(params.approvalId),
      availableDecisions: Array.isArray(params.availableDecisions) ? params.availableDecisions : [],
      additionalPermissions: readOptionalObject(params.additionalPermissions),
      networkApprovalContext: readOptionalObject(params.networkApprovalContext),
      proposedExecpolicyAmendment: Array.isArray(params.proposedExecpolicyAmendment)
        ? params.proposedExecpolicyAmendment
        : [],
      proposedNetworkPolicyAmendments: Array.isArray(params.proposedNetworkPolicyAmendments)
        ? params.proposedNetworkPolicyAmendments
        : [],
      commandActions: Array.isArray(params.commandActions) ? params.commandActions : [],
      skillMetadata: readOptionalObject(params.skillMetadata),
    };
  }

  if (method === 'item/fileChange/requestApproval') {
    return {
      requestId,
      kind: 'file_change',
      reason: readOptionalPayloadString(params.reason),
      itemId: readOptionalPayloadString(params.itemId),
      grantRoot: readOptionalPayloadString(params.grantRoot),
    };
  }

  return {
    requestId,
    kind: 'permissions',
    reason: readOptionalPayloadString(params.reason),
    itemId: readOptionalPayloadString(params.itemId),
    permissions: readOptionalObject(params.permissions),
  };
}

function buildToolLifecyclePayload(phase: 'started' | 'completed', params: Record<string, unknown>): Record<string, unknown> {
  const item = readOptionalObject(params.item) ?? {};
  const kind = readOptionalPayloadString(item.type) ?? 'tool';
  const title =
    readOptionalPayloadString(item.title) ??
    readOptionalPayloadString(item.name) ??
    readOptionalPayloadString(item.command) ??
    kind;

  return {
    phase,
    itemId: readOptionalPayloadString(item.id) ?? readOptionalPayloadString(params.itemId),
    kind,
    title,
    status: readOptionalPayloadString(item.status),
    command: readOptionalPayloadString(item.command),
    text: readOptionalPayloadString(item.text),
    path: readOptionalPayloadString(item.path),
    item,
  };
}

function buildToolOutputPayload(method: string, params: Record<string, unknown>): Record<string, unknown> & { text: string | null } {
  const kind = method === 'item/fileChange/outputDelta' ? 'file_change' : 'command_execution';
  const text =
    readOptionalPayloadString(params.delta) ??
    readOptionalPayloadString(params.output) ??
    readOptionalPayloadString(params.text);

  return {
    kind,
    itemId: readOptionalPayloadString(params.itemId),
    stream: readOptionalPayloadString(params.stream),
    text,
  };
}

function buildApprovalResponse(
  method: PendingApprovalRequest['method'],
  params: Record<string, unknown>,
  decision: ResolveApprovalBody['decision'],
): Record<string, unknown> {
  if (method === 'item/commandExecution/requestApproval') {
    return {
      decision: normalizeCommandApprovalDecision(decision),
    };
  }

  if (method === 'item/fileChange/requestApproval') {
    return {
      decision: normalizeSimpleApprovalDecision(decision) === 'accept' ? 'accept' : 'decline',
    };
  }

  return {
    permissions: normalizeSimpleApprovalDecision(decision) === 'accept' ? readOptionalObject(params.permissions) ?? {} : {},
  };
}

function parseApprovalDecision(input: unknown): ResolveApprovalBody['decision'] {
  if (typeof input === 'string') {
    const value = input.trim();
    if (value === 'approve') return 'accept';
    if (value === 'reject') return 'decline';
    if (value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel') {
      return value;
    }
    throw new Error('Unsupported approval decision');
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Unsupported approval decision');
  }

  const record = input as Record<string, unknown>;
  const execPolicy = record.acceptWithExecpolicyAmendment;
  if (execPolicy && typeof execPolicy === 'object' && !Array.isArray(execPolicy)) {
    const entries = (execPolicy as Record<string, unknown>).execpolicy_amendment;
    if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      throw new Error('acceptWithExecpolicyAmendment requires a non-empty execpolicy_amendment array');
    }
    return {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: entries.map((entry) => String(entry).trim()),
      },
    };
  }

  const networkPolicy = record.applyNetworkPolicyAmendment;
  if (networkPolicy && typeof networkPolicy === 'object' && !Array.isArray(networkPolicy)) {
    const amendment = (networkPolicy as Record<string, unknown>).network_policy_amendment;
    if (!amendment || typeof amendment !== 'object' || Array.isArray(amendment)) {
      throw new Error('applyNetworkPolicyAmendment requires network_policy_amendment');
    }
    const action = readNonEmptyString((amendment as Record<string, unknown>).action, 'network_policy_amendment.action');
    const host = readNonEmptyString((amendment as Record<string, unknown>).host, 'network_policy_amendment.host');
    if (action !== 'allow' && action !== 'deny') {
      throw new Error('network_policy_amendment.action must be allow or deny');
    }
    return {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          action,
          host,
        },
      },
    };
  }

  throw new Error('Unsupported approval decision');
}

function normalizeCommandApprovalDecision(decision: ResolveApprovalBody['decision']): unknown {
  if (typeof decision === 'string') {
    return decision;
  }
  return decision;
}

function normalizeSimpleApprovalDecision(decision: ResolveApprovalBody['decision']): 'accept' | 'decline' {
  if (typeof decision === 'string') {
    return decision === 'accept' || decision === 'acceptForSession' ? 'accept' : 'decline';
  }
  return 'accept';
}

function describeApprovalDecision(decision: ResolveApprovalBody['decision']): string {
  if (typeof decision === 'string') {
    return decision;
  }
  if ('acceptWithExecpolicyAmendment' in decision) {
    return `acceptWithExecpolicyAmendment:${decision.acceptWithExecpolicyAmendment.execpolicy_amendment.join(',')}`;
  }
  return `applyNetworkPolicyAmendment:${decision.applyNetworkPolicyAmendment.network_policy_amendment.action}:${decision.applyNetworkPolicyAmendment.network_policy_amendment.host}`;
}

function readOptionalPayloadString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readOptionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
