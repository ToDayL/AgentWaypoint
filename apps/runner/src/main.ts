import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import Busboy from 'busboy';
import { ClaudeBackend } from './claude-backend.js';
import { CodexBackend } from './codex-backend.js';
import { FilesystemBackend } from './filesystem-backend.js';
import type {
  ActiveMockTurn,
  ActiveTurn,
  BufferedRunnerEvent,
  CancelTurnBody,
  CloseThreadBody,
  CompactThreadBody,
  EnsureDirectoryBody,
  ForkThreadBody,
  ModelListItem,
  SkillListItem,
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
const defaultRunnerBackend: RunnerBackend = 'codex';
const allRunnerBackends: RunnerBackend[] = ['codex', 'claude', 'mock'];
const supportedBackends = parseSupportedBackends(process.env.RUNNER_SUPPORTED_BACKENDS);
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
const claudeBackend = new ClaudeBackend({
  activeTurns,
  appendTurnEvent,
  finalizeTurn,
  failTurn,
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;

    if (request.method === 'GET' && pathname === '/runner/health') {
      sendJson(response, 200, {
        status: 'ok',
        backend: supportedBackends.length === 1 ? supportedBackends[0] : 'multi',
        supportedBackends,
        activeTurnCount: activeTurns.size,
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

    if (request.method === 'GET' && pathname === '/runner/models') {
      const requestedBackendParam = (url.searchParams.get('backend') ?? '').trim();
      const requestedBackend = requestedBackendParam
        ? parseRunnerBackend(requestedBackendParam, 'backend')
        : null;
      sendJson(response, 200, {
        data: await listModels(requestedBackend),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/runner/skills') {
      const cwd = (url.searchParams.get('cwd') ?? '').trim() || null;
      const requestedBackendParam = (url.searchParams.get('backend') ?? '').trim();
      const requestedBackend = requestedBackendParam
        ? parseRunnerBackend(requestedBackendParam, 'backend')
        : null;
      sendJson(response, 200, {
        data: await listSkills(cwd, requestedBackend),
      });
      return;
    }

    if (
      request.method === 'GET' &&
      (pathname === '/runner/codex/rate-limits' || pathname === '/runner/account/rate-limits')
    ) {
      if (!isBackendSupported('codex')) {
        sendJson(response, 200, {
          rateLimits: null,
          rateLimitsByLimitId: null,
        });
        return;
      }
      sendJson(response, 200, await codexBackend.readCodexRateLimits());
      return;
    }

    if (request.method === 'GET' && pathname === '/runner/fs/suggestions') {
      const prefix = (url.searchParams.get('prefix') ?? '').trim();
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '12', 10);
      const suggestions = await filesystemBackend.suggestWorkspaceDirectories(prefix, limit);
      sendJson(response, 200, { data: suggestions });
      return;
    }

    if (request.method === 'GET' && pathname === '/runner/fs/tree') {
      const treePath = (url.searchParams.get('path') ?? '').trim();
      if (!treePath) {
        throw new Error('path is required');
      }
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
      const entries = await filesystemBackend.listWorkspaceTree(treePath, limit);
      sendJson(response, 200, { data: entries });
      return;
    }

    if (request.method === 'GET' && pathname === '/runner/fs/file') {
      const filePath = (url.searchParams.get('path') ?? '').trim();
      if (!filePath) {
        throw new Error('path is required');
      }
      const maxBytes = Number.parseInt(url.searchParams.get('maxBytes') ?? String(256 * 1024), 10);
      const result = await filesystemBackend.readWorkspaceFile(filePath, maxBytes);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'GET' && pathname === '/runner/fs/file-content') {
      const filePath = (url.searchParams.get('path') ?? '').trim();
      if (!filePath) {
        throw new Error('path is required');
      }
      const result = await filesystemBackend.readWorkspaceFileBinary(filePath);
      response.writeHead(200, {
        'content-type': result.mimeType,
        'content-length': String(result.size),
        'cache-control': 'no-store',
        'x-agentwaypoint-file-path': encodeURIComponent(result.path),
      });
      response.end(result.content);
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
      const requestedBackend = resolveRequestedBackend(payload.backend, 'backend');
      const existing = activeTurns.get(payload.turnId);
      if (existing) {
        await cancelActiveTurn(existing, { emitCancelEvent: false });
      }

      sendJson(response, 202, {
        accepted: true,
        runnerRequestId: randomUUID(),
      });

      if (requestedBackend === 'mock') {
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

      if (requestedBackend !== 'codex') {
        if (requestedBackend === 'claude') {
          ensureTurnStreamState(payload.turnId, payload.sessionId, 'queued');
          void claudeBackend.startTurn(payload);
          return;
        }
        throw new Error(`Unsupported backend: ${requestedBackend}`);
      }
      ensureTurnStreamState(payload.turnId, payload.sessionId, 'queued');
      void codexBackend.startTurn(payload);
      return;
    }

    if (pathname === '/runner/fs/ensure-directory') {
      const payload = parseEnsureDirectoryBody(await readJsonBody(request));
      const result = await filesystemBackend.ensureWorkspaceDirectory(payload.path);
      sendJson(response, 200, result);
      return;
    }

    if (pathname === '/runner/fs/upload') {
      const upload = await parseWorkspaceUploadForm(request);
      const result = await filesystemBackend.saveWorkspaceUpload({
        workspacePath: upload.workspacePath,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        content: upload.content,
      });
      sendJson(response, 200, result);
      return;
    }

    if (pathname === '/runner/threads/fork') {
      const payload = parseForkThreadBody(await readJsonBody(request));
      const cwd = await filesystemBackend.resolveWorkspaceCwd(payload.cwd);
      const requestedBackend = resolveRequestedBackend(payload.backend, 'backend');

      if (requestedBackend === 'mock') {
        sendJson(response, 200, {
          threadId: `mock-fork-${randomUUID()}`,
        });
        return;
      }

      if (requestedBackend !== 'codex') {
        throw new Error(`Unsupported backend: ${requestedBackend}`);
      }
      const threadId = await codexBackend.forkThread({ ...payload, cwd });
      sendJson(response, 200, { threadId });
      return;
    }

    if (pathname === '/runner/threads/close') {
      const payload = parseCloseThreadBody(await readJsonBody(request));
      if (!isBackendSupported('codex')) {
        response.statusCode = 204;
        response.end();
        return;
      }

      await codexBackend.closeThread(payload);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (pathname === '/runner/threads/compact') {
      const payload = parseCompactThreadBody(await readJsonBody(request));
      const cwd = await filesystemBackend.resolveWorkspaceCwd(payload.cwd);
      const requestedBackend = resolveRequestedBackend(payload.backend, 'backend');

      if (requestedBackend === 'mock') {
        sendJson(response, 202, {
          accepted: true,
          runnerRequestId: randomUUID(),
        });
        return;
      }

      if (requestedBackend !== 'codex') {
        throw new Error(`Unsupported backend: ${requestedBackend}`);
      }
      await codexBackend.compactThread({ ...payload, cwd });
      sendJson(response, 202, {
        accepted: true,
        runnerRequestId: randomUUID(),
      });
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
      if (turn.backend === 'claude') {
        try {
          await claudeBackend.steerTurn(turn, payload.content);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to steer claude turn';
          sendJson(response, 409, {
            error: { code: 'CONFLICT', message },
          });
          return;
        }
        sendJson(response, 202, { accepted: true, runnerRequestId: randomUUID() });
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
      const turn = activeTurns.get(payload.turnId);
      if (turn?.backend === 'claude') {
        await claudeBackend.resolvePendingApproval(payload);
      } else {
        await codexBackend.resolvePendingApproval(payload);
      }
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
  console.log(
    `[agentwaypoint-runner] listening on http://${host}:${port} (supportedBackends=${supportedBackends.join(',')})`,
  );
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
  const backend = readOptionalString(record.backend);
  const backendConfig = readOptionalRecord(record.backendConfig, 'backendConfig');
  const threadId = readOptionalString(record.threadId);
  const cwd = readOptionalString(record.cwd);
  return { turnId, sessionId, content, backend, backendConfig, threadId, cwd };
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
    backend: readOptionalString(record.backend),
    backendConfig: readOptionalRecord(record.backendConfig, 'backendConfig'),
    cwd: readOptionalString(record.cwd),
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

function parseCloseThreadBody(input: unknown): CloseThreadBody {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid close-thread payload');
  }
  const record = input as Record<string, unknown>;
  return {
    threadId: readNonEmptyString(record.threadId, 'threadId'),
  };
}

function parseCompactThreadBody(input: unknown): CompactThreadBody {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid compact-thread payload');
  }
  const record = input as Record<string, unknown>;
  return {
    threadId: readNonEmptyString(record.threadId, 'threadId'),
    backend: readOptionalString(record.backend),
    backendConfig: readOptionalRecord(record.backendConfig, 'backendConfig'),
    cwd: readOptionalString(record.cwd),
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

function readOptionalRecord(value: unknown, field: string): Record<string, unknown> | null {
  if (value === null || typeof value === 'undefined') {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseRunnerBackend(value: string, field: string): RunnerBackend {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'mock' || normalized === 'claude') {
    return normalized;
  }
  throw new Error(`${field} must be one of: codex, claude, mock`);
}

function parseSupportedBackends(value: string | undefined): RunnerBackend[] {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return [...allRunnerBackends];
  }
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseRunnerBackend(entry, 'RUNNER_SUPPORTED_BACKENDS'));
  const unique = Array.from(new Set(parsed));
  return unique.length > 0 ? unique : [...allRunnerBackends];
}

function isBackendSupported(backend: RunnerBackend): boolean {
  return supportedBackends.includes(backend);
}

function resolveRequestedBackend(input: string | null | undefined, field: string): RunnerBackend {
  const parsed = parseRunnerBackend(input ?? defaultRunnerBackend, field);
  if (!isBackendSupported(parsed)) {
    throw new Error(`${field} backend "${parsed}" is not enabled`);
  }
  return parsed;
}

async function parseWorkspaceUploadForm(
  request: IncomingMessage,
): Promise<{ workspacePath: string; fileName: string; mimeType: string; content: Buffer }> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('multipart/form-data')) {
    throw new Error('content-type must be multipart/form-data');
  }

  return await new Promise((resolve, reject) => {
    const parser = Busboy({
      headers: request.headers,
      limits: {
        files: 1,
        fields: 8,
        fileSize: 20 * 1024 * 1024,
      },
    });

    let workspacePath = '';
    let fileName = '';
    let mimeType = 'application/octet-stream';
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let hasFile = false;
    let fileTooLarge = false;

    parser.on('field', (name: string, value: string) => {
      if (name === 'workspacePath' && workspacePath.length === 0) {
        workspacePath = value.trim();
      }
    });

    parser.on(
      'file',
      (
        name: string,
        stream: NodeJS.ReadableStream & { resume: () => void; on: (event: string, handler: (...args: unknown[]) => void) => void },
        info: { filename: string; mimeType: string },
      ) => {
      if (name !== 'file') {
        stream.resume();
        return;
      }
      hasFile = true;
      if (typeof info.filename === 'string' && info.filename.trim().length > 0) {
        fileName = info.filename.trim();
      }
      if (typeof info.mimeType === 'string' && info.mimeType.trim().length > 0) {
        mimeType = info.mimeType.trim();
      }

      stream.on('data', (chunk: Buffer | string) => {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bufferChunk.length;
        chunks.push(bufferChunk);
      });
      stream.on('limit', () => {
        fileTooLarge = true;
      });
      stream.on('error', (error: unknown) => {
        reject(error instanceof Error ? error : new Error('Failed to read upload stream'));
      });
      },
    );

    parser.on('filesLimit', () => {
      reject(new Error('Only one file can be uploaded per request'));
    });
    parser.on('error', (error: unknown) => {
      reject(error instanceof Error ? error : new Error('Failed to parse multipart request'));
    });
    parser.on('finish', () => {
      if (!workspacePath) {
        reject(new Error('workspacePath is required'));
        return;
      }
      if (!hasFile) {
        reject(new Error('file is required'));
        return;
      }
      if (fileTooLarge) {
        reject(new Error('Uploaded file exceeds 20MB limit'));
        return;
      }
      if (totalBytes <= 0) {
        reject(new Error('Uploaded file is empty'));
        return;
      }
      resolve({
        workspacePath,
        fileName: fileName || 'upload.bin',
        mimeType,
        content: Buffer.concat(chunks, totalBytes),
      });
    });

    request.pipe(parser);
  });
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

async function listModels(requestedBackend: RunnerBackend | null): Promise<ModelListItem[]> {
  if (requestedBackend && !isBackendSupported(requestedBackend)) {
    return [];
  }

  if (requestedBackend === 'claude') {
    return claudeBackend.listModels();
  }

  if (requestedBackend === 'mock') {
    return [buildMockModel()];
  }

  if (requestedBackend === 'codex') {
    return codexBackend.listModels();
  }

  const models: ModelListItem[] = [];
  if (isBackendSupported('codex')) {
    models.push(...(await codexBackend.listModels()));
  }
  if (isBackendSupported('claude')) {
    models.push(...(await claudeBackend.listModels()));
  }
  if (isBackendSupported('mock')) {
    models.push(buildMockModel());
  }
  return models;
}

async function listSkills(cwd: string | null, requestedBackend: RunnerBackend | null): Promise<SkillListItem[]> {
  if (requestedBackend && !isBackendSupported(requestedBackend)) {
    return [];
  }

  if (requestedBackend === 'codex') {
    return isBackendSupported('codex') ? codexBackend.listSkills(cwd?.trim() || codexDefaultCwd) : [];
  }

  if (requestedBackend === 'claude' || requestedBackend === 'mock') {
    return [];
  }

  if (!isBackendSupported('codex')) {
    return [];
  }

  return codexBackend.listSkills(cwd?.trim() || codexDefaultCwd);
}

function buildMockModel(): ModelListItem {
  const model = codexDefaultModel || 'gpt-5-codex';
  return {
    id: model,
    backend: 'mock',
    model,
    displayName: model,
    description: 'Configured mock/default model',
    hidden: false,
    isDefault: true,
  };
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
  } else if (turn.backend === 'claude') {
    claudeBackend.disposePendingApprovalsForTurn(turnId, 'decline');
    turn.query?.close();
    turn.completionResolve?.();
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
  if (turn.backend === 'claude') {
    await claudeBackend.cancelTurn(turn);
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
  if (turn.backend === 'claude') {
    claudeBackend.disposePendingApprovalsForTurn(turn.turnId, 'decline');
    claudeBackend.silentlyDisposeTurn(turn.turnId);
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
