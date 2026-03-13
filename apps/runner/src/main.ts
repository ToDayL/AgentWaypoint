import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { CodexBackend } from './codex-backend.js';
import { FilesystemBackend } from './filesystem-backend.js';
import type {
  ActiveMockTurn,
  ActiveTurn,
  BufferedRunnerEvent,
  CancelTurnBody,
  EnsureDirectoryBody,
  ForkThreadBody,
  ModelListItem,
  ResolveApprovalBody,
  RunnerBackend,
  RunnerEventType,
  RunnerTurnStreamState,
  StartTurnBody,
  SteerTurnBody,
} from './types.js';

const port = Number(process.env.RUNNER_PORT ?? 4700);
const host = process.env.RUNNER_HOST ?? '127.0.0.1';
const authToken = process.env.RUNNER_AUTH_TOKEN?.trim() || null;
const runnerBackend: RunnerBackend = (process.env.RUNNER_BACKEND ?? 'codex').trim().toLowerCase() === 'mock' ? 'mock' : 'codex';
const codexBin = process.env.RUNNER_CODEX_BIN?.trim() || 'codex';
const codexDefaultCwd = process.env.RUNNER_CODEX_CWD?.trim() || process.cwd();
const codexDefaultModel = process.env.RUNNER_CODEX_MODEL?.trim() || null;
const codexApprovalPolicy = process.env.RUNNER_CODEX_APPROVAL_POLICY?.trim() || 'never';
const codexSandboxMode = process.env.RUNNER_CODEX_SANDBOX?.trim() || null;
const runnerEventRetentionMs = Number(process.env.RUNNER_EVENT_RETENTION_MS ?? 5 * 60 * 1000);
const runnerEventBufferLimit = Number(process.env.RUNNER_EVENT_BUFFER_LIMIT ?? 1000);

const activeTurns = new Map<string, ActiveTurn>();
const turnStreams = new Map<string, RunnerTurnStreamState>();
const filesystemBackend = new FilesystemBackend({
  allowedRepoRoots: process.env.RUNNER_ALLOWED_REPO_ROOTS?.trim() || null,
});
const codexBackend = new CodexBackend(
  {
    codexBin,
    codexDefaultCwd,
    codexDefaultModel,
    codexApprovalPolicy,
    codexSandboxMode,
  },
  {
    activeTurns,
    appendTurnEvent,
    finalizeTurn,
    failTurn,
  },
);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;

    if (request.method === 'GET' && pathname === '/runner/health') {
      sendJson(response, 200, { status: 'ok', backend: runnerBackend, activeTurnCount: activeTurns.size });
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

    if (request.method === 'GET' && pathname === '/runner/models') {
      sendJson(response, 200, {
        data: await listModels(),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/runner/fs/suggestions') {
      const prefix = (url.searchParams.get('prefix') ?? '').trim();
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '12', 10);
      const suggestions = await filesystemBackend.suggestWorkspaceDirectories(prefix, limit);
      sendJson(response, 200, { data: suggestions });
      return;
    }

    const turnStatusMatch = request.method === 'GET' ? pathname.match(/^\/runner\/turns\/([^/]+)$/) : null;
    if (turnStatusMatch) {
      const turnId = decodeURIComponent(turnStatusMatch[1] ?? '');
      const streamState = turnStreams.get(turnId);
      if (!streamState) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Turn not found' } });
        return;
      }
      sendJson(response, 200, {
        turnId: streamState.turnId,
        sessionId: streamState.sessionId,
        status: streamState.status,
        latestSeq: streamState.nextSeq - 1,
      });
      return;
    }

    const turnStreamMatch = request.method === 'GET' ? pathname.match(/^\/runner\/turns\/([^/]+)\/stream$/) : null;
    if (turnStreamMatch) {
      const turnId = decodeURIComponent(turnStreamMatch[1] ?? '');
      const streamState = turnStreams.get(turnId);
      if (!streamState) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Turn not found' } });
        return;
      }

      const since = Math.max(Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0, 0);
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      streamState.events.filter((event) => event.seq > since).forEach((event) => {
        writeSseEvent(response, event);
      });

      if (isTerminalStatus(streamState.status)) {
        response.end();
        return;
      }

      streamState.listeners.add(response);
      const heartbeat = setInterval(() => {
        response.write(`: keepalive ${Date.now()}\n\n`);
      }, 15000);
      request.on('close', () => {
        clearInterval(heartbeat);
        streamState.listeners.delete(response);
      });
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, 404, {
        error: { code: 'NOT_FOUND', message: 'Route not found' },
      });
      return;
    }

    if (pathname === '/runner/turns/start') {
      const payload = parseStartTurnBody(await readJsonBody(request));
      payload.cwd = await filesystemBackend.resolveWorkspaceCwd(payload.cwd);
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
        ensureTurnStreamState(payload.turnId, payload.sessionId, 'queued');
        void startMockExecution(turn);
        return;
      }

      ensureTurnStreamState(payload.turnId, payload.sessionId, 'queued');
      void codexBackend.startTurn({
        turnId: payload.turnId,
        sessionId: payload.sessionId,
        content: payload.content,
        threadId: payload.threadId ?? null,
        cwd: payload.cwd ?? null,
        model: payload.model ?? null,
        sandbox: payload.sandbox ?? null,
        approvalPolicy: payload.approvalPolicy ?? null,
      });
      return;
    }

    if (pathname === '/runner/fs/ensure-directory') {
      const payload = parseEnsureDirectoryBody(await readJsonBody(request));
      const result = await filesystemBackend.ensureWorkspaceDirectory(payload.path);
      sendJson(response, 200, result);
      return;
    }

    if (pathname === '/runner/threads/fork') {
      const payload = parseForkThreadBody(await readJsonBody(request));
      const cwd = await filesystemBackend.resolveWorkspaceCwd(payload.cwd);

      if (runnerBackend === 'mock') {
        sendJson(response, 200, {
          threadId: `mock-fork-${randomUUID()}`,
        });
        return;
      }

      const threadId = await codexBackend.forkThread({ ...payload, cwd });
      sendJson(response, 200, { threadId });
      return;
    }

    if (pathname === '/runner/turns/steer') {
      const payload = parseSteerTurnBody(await readJsonBody(request));
      const turn = activeTurns.get(payload.turnId);
      if (!turn || turn.finalized) {
        sendJson(response, 404, {
          error: { code: 'NOT_FOUND', message: 'Active turn not found' },
        });
        return;
      }
      if (turn.backend !== 'codex') {
        await appendTurnEvent(turn.turnId, 'assistant.delta', { text: `\n[steer] ${payload.content}` });
        sendJson(response, 202, { accepted: true, runnerRequestId: randomUUID() });
        return;
      }
      await codexBackend.steerTurn(payload);
      sendJson(response, 202, { accepted: true, runnerRequestId: randomUUID() });
      return;
    }

    if (pathname === '/runner/turns/cancel') {
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

    if (pathname === '/runner/turns/approval') {
      const payload = parseResolveApprovalBody(await readJsonBody(request));
      await codexBackend.resolvePendingApproval(payload);
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

function writeSseEvent(response: ServerResponse, event: BufferedRunnerEvent): void {
  response.write(`id: ${event.seq}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
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
  const model = readOptionalString(record.model);
  const sandbox = readOptionalString(record.sandbox);
  const approvalPolicy = readOptionalString(record.approvalPolicy);
  return { turnId, sessionId, content, threadId, cwd, model, sandbox, approvalPolicy };
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

function parseForkThreadBody(input: unknown): ForkThreadBody {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid fork payload');
  }
  const record = input as Record<string, unknown>;
  return {
    threadId: readNonEmptyString(record.threadId, 'threadId'),
    cwd: readOptionalString(record.cwd),
    model: readOptionalString(record.model),
    sandbox: readOptionalString(record.sandbox),
    approvalPolicy: readOptionalString(record.approvalPolicy),
  };
}

function parseEnsureDirectoryBody(input: unknown): EnsureDirectoryBody {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid ensure-directory payload');
  }
  const record = input as Record<string, unknown>;
  return {
    path: readNonEmptyString(record.path, 'path'),
  };
}

function parseSteerTurnBody(input: unknown): SteerTurnBody {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid steer payload');
  }
  const record = input as Record<string, unknown>;
  return {
    turnId: readNonEmptyString(record.turnId, 'turnId'),
    content: readNonEmptyString(record.content, 'content'),
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
    throw new Error('Optional string fields must be strings when provided');
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function startMockExecution(turn: ActiveMockTurn): Promise<void> {
  await appendTurnEvent(turn.turnId, 'turn.started', {});

  const responseContent = `Echo: ${turn.content}`;
  const chunks = chunkText(responseContent, 12);
  chunks.forEach((chunk, index) => {
    const timer = setTimeout(() => {
      if (!activeTurns.has(turn.turnId)) {
        return;
      }
      void appendTurnEvent(turn.turnId, 'assistant.delta', { text: chunk });
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

async function listModels(): Promise<ModelListItem[]> {
  if (runnerBackend === 'mock') {
    const model = codexDefaultModel || 'gpt-5-codex';
    return [
      {
        id: model,
        model,
        displayName: model,
        description: 'Configured mock/default model',
        hidden: false,
        isDefault: true,
      },
    ];
  }

  return codexBackend.listModels();
}

function ensureTurnStreamState(
  turnId: string,
  sessionId: string,
  status: RunnerTurnStreamState['status'],
): RunnerTurnStreamState {
  const existing = turnStreams.get(turnId);
  if (existing) {
    existing.sessionId = sessionId;
    existing.status = status;
    return existing;
  }

  const state: RunnerTurnStreamState = {
    turnId,
    sessionId,
    status,
    nextSeq: 1,
    events: [],
    listeners: new Set<ServerResponse>(),
    cleanupTimer: null,
  };
  turnStreams.set(turnId, state);
  return state;
}

function isTerminalStatus(status: RunnerTurnStreamState['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

async function appendTurnEvent(turnId: string, type: RunnerEventType, payload: Record<string, unknown>): Promise<void> {
  const activeTurn = activeTurns.get(turnId);
  const sessionId = activeTurn?.sessionId ?? turnStreams.get(turnId)?.sessionId ?? '';
  const streamState = ensureTurnStreamState(turnId, sessionId, mapEventTypeToStatus(type));
  streamState.status = mapEventTypeToStatus(type, streamState.status);

  const event: BufferedRunnerEvent = {
    turnId,
    seq: streamState.nextSeq,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
  streamState.nextSeq += 1;
  streamState.events.push(event);
  if (streamState.events.length > runnerEventBufferLimit) {
    streamState.events.splice(0, streamState.events.length - runnerEventBufferLimit);
  }

  streamState.listeners.forEach((listener) => {
    writeSseEvent(listener, event);
    if (isTerminalStatus(streamState.status)) {
      listener.end();
    }
  });
  if (isTerminalStatus(streamState.status)) {
    streamState.listeners.clear();
    scheduleTurnStreamCleanup(streamState);
  }
}

function scheduleTurnStreamCleanup(streamState: RunnerTurnStreamState): void {
  if (streamState.cleanupTimer) {
    clearTimeout(streamState.cleanupTimer);
  }
  streamState.cleanupTimer = setTimeout(() => {
    turnStreams.delete(streamState.turnId);
  }, runnerEventRetentionMs);
}

function mapEventTypeToStatus(
  type: RunnerEventType,
  currentStatus: RunnerTurnStreamState['status'] = 'queued',
): RunnerTurnStreamState['status'] {
  if (type === 'turn.started') {
    return 'running';
  }
  if (type === 'turn.approval.requested') {
    return 'waiting_approval';
  }
  if (type === 'turn.approval.resolved') {
    return 'running';
  }
  if (type === 'turn.completed') {
    return 'completed';
  }
  if (type === 'turn.failed') {
    return 'failed';
  }
  if (type === 'turn.cancelled') {
    return 'cancelled';
  }
  return currentStatus;
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
  if (turn.backend === 'codex') {
    await codexBackend.disposePendingApprovalsForTurn(turnId, 'decline');
  }
  activeTurns.delete(turnId);

  if (turn.backend === 'mock') {
    clearTurnTimers(turn.timers);
  } else {
    turn.completionResolve?.();
  }

  await appendTurnEvent(turnId, type, payload);
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

  await codexBackend.cancelTurn(turn, options);
}

function silentlyDisposeTurn(turn: ActiveTurn): void {
  if (turn.finalized) {
    return;
  }
  turn.finalized = true;
  if (turn.backend === 'mock') {
    activeTurns.delete(turn.turnId);
    clearTurnTimers(turn.timers);
    return;
  }
  codexBackend.silentlyDisposeTurn(turn.turnId);
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
