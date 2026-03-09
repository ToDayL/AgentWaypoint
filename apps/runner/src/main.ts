import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

type StartTurnBody = {
  turnId: string;
  sessionId: string;
  content: string;
};

type CancelTurnBody = {
  turnId: string;
};

type RunnerEventType = 'turn.started' | 'assistant.delta' | 'turn.completed' | 'turn.failed' | 'turn.cancelled';

const port = Number(process.env.RUNNER_PORT ?? 4700);
const host = process.env.RUNNER_HOST ?? '127.0.0.1';
const authToken = process.env.RUNNER_AUTH_TOKEN?.trim() || null;
const apiBaseUrl = (process.env.RUNNER_API_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

type ActiveTurn = {
  sessionId: string;
  content: string;
  startedAt: string;
  timers: ReturnType<typeof setTimeout>[];
};

const activeTurns = new Map<string, ActiveTurn>();

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/runner/health') {
      sendJson(response, 200, { status: 'ok', activeTurnCount: activeTurns.size });
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
        clearTurnTimers(existing.timers);
      }

      const turn: ActiveTurn = {
        sessionId: payload.sessionId,
        content: payload.content,
        startedAt: new Date().toISOString(),
        timers: [],
      };
      activeTurns.set(payload.turnId, turn);
      void startMockExecution(payload.turnId, payload.content, turn.timers);

      sendJson(response, 202, {
        accepted: true,
        runnerRequestId: randomUUID(),
      });
      return;
    }

    if (request.url === '/runner/turns/cancel') {
      const payload = parseCancelTurnBody(await readJsonBody(request));
      const turn = activeTurns.get(payload.turnId);
      const cancelled = !!turn;
      if (turn) {
        clearTurnTimers(turn.timers);
        activeTurns.delete(payload.turnId);
        void notifyApi(payload.turnId, 'turn.cancelled', {});
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
  console.log(`[codexpanel-runner] listening on http://${host}:${port}`);
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

async function startMockExecution(
  turnId: string,
  content: string,
  timers: ReturnType<typeof setTimeout>[],
): Promise<void> {
  await notifyApi(turnId, 'turn.started', {});

  const responseContent = `Echo: ${content}`;
  const chunks = chunkText(responseContent, 12);
  chunks.forEach((chunk, index) => {
    const timer = setTimeout(() => {
      if (!activeTurns.has(turnId)) {
        return;
      }
      void notifyApi(turnId, 'assistant.delta', { text: chunk });
    }, 120 + index * 120);
    timers.push(timer);
  });

  const finalizeTimer = setTimeout(() => {
    if (!activeTurns.has(turnId)) {
      return;
    }
    activeTurns.delete(turnId);
    void notifyApi(turnId, 'turn.completed', { content: responseContent });
  }, 200 + chunks.length * 120);
  timers.push(finalizeTimer);
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
