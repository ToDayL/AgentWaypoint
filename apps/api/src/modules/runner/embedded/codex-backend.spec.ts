import { describe, expect, it } from 'vitest';
import { CodexBackend } from './codex-backend.js';
import type { ActiveCodexTurn, ActiveTurn, RunnerEventType } from './types.js';

type NotificationHandler = {
  handleCodexNotification(method: string, params: Record<string, unknown>): Promise<void>;
};

function createHarness() {
  const turn: ActiveCodexTurn = {
    backend: 'codex',
    turnId: 'waypoint-turn-1',
    sessionId: 'session-1',
    content: 'test',
    startedAt: new Date().toISOString(),
    finalized: false,
    threadId: 'codex-thread-1',
    codexTurnId: 'codex-turn-1',
    assistantText: '',
    pendingAgentMessageBreak: false,
    completionResolve: null,
    completionReject: null,
  };
  const activeTurns = new Map<string, ActiveTurn>([[turn.turnId, turn]]);
  const appended: Array<{ turnId: string; type: RunnerEventType; payload: Record<string, unknown> }> = [];
  const finalized: Array<{ turnId: string; type: RunnerEventType; payload: Record<string, unknown> }> = [];
  const failed: Array<{ turnId: string; message: string }> = [];
  const backend = new CodexBackend(
    {
      codexBin: 'codex',
      codexDefaultCwd: process.cwd(),
      codexDefaultModel: null,
      codexApprovalPolicy: 'on-request',
      codexSandboxMode: 'workspace-write',
    },
    {
      activeTurns,
      appendTurnEvent: async (turnId, type, payload) => {
        appended.push({ turnId, type, payload });
      },
      finalizeTurn: async (turnId, type, payload) => {
        finalized.push({ turnId, type, payload });
        const activeTurn = activeTurns.get(turnId);
        if (activeTurn) {
          activeTurn.finalized = true;
          activeTurns.delete(turnId);
          if (activeTurn.backend === 'codex' || activeTurn.backend === 'claude') {
            activeTurn.completionResolve?.();
          }
        }
      },
      failTurn: async (turnId, message) => {
        failed.push({ turnId, message });
      },
    },
  );
  const notify = (backend as unknown as NotificationHandler).handleCodexNotification.bind(backend);
  return { activeTurns, appended, backend, failed, finalized, notify };
}

type WorkerRequestHarness = {
  ensureCodexWorker(): Promise<{ readyPromise: Promise<void> }>;
  sendWorkerRequest(worker: unknown, method: string, params: unknown): Promise<unknown>;
};

function stubWorkerRequests(
  backend: CodexBackend,
  handler: (method: string, params: unknown) => Promise<unknown>,
): void {
  const internals = backend as unknown as WorkerRequestHarness;
  internals.ensureCodexWorker = async () => ({ readyPromise: Promise.resolve() });
  internals.sendWorkerRequest = async (_worker, method, params) => handler(method, params);
}

describe('CodexBackend reasoning effort', () => {
  it('maps model reasoning effort metadata from model/list', async () => {
    const harness = createHarness();
    stubWorkerRequests(harness.backend, async (method) => {
      expect(method).toBe('model/list');
      return {
        data: [
          {
            id: 'gpt-5.4',
            model: 'gpt-5.4',
            displayName: 'GPT-5.4',
            description: 'Test model',
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'xhigh', description: 'Deep' },
            ],
            defaultReasoningEffort: 'xhigh',
          },
        ],
        nextCursor: null,
      };
    });

    await expect(harness.backend.listModels()).resolves.toEqual([
      expect.objectContaining({
        model: 'gpt-5.4',
        supportedEfforts: [
          { value: 'low', description: 'Fast' },
          { value: 'xhigh', description: 'Deep' },
        ],
        defaultEffort: 'xhigh',
      }),
    ]);
  });

  it('passes configured effort through turn/start and the effective start event', async () => {
    const harness = createHarness();
    const requests: Array<{ method: string; params: unknown }> = [];
    stubWorkerRequests(harness.backend, async (method, params) => {
      requests.push({ method, params });
      if (method === 'thread/start') {
        return { thread: { id: 'codex-thread-effort' } };
      }
      if (method === 'turn/start') {
        setTimeout(() => {
          void harness.notify('turn/completed', {
            threadId: 'codex-thread-effort',
            turn: { id: 'codex-turn-effort', status: 'completed' },
          });
        }, 0);
        return { turn: { id: 'codex-turn-effort' } };
      }
      throw new Error(`Unexpected worker request: ${method}`);
    });

    await harness.backend.startTurn({
      turnId: 'waypoint-turn-effort',
      sessionId: 'session-effort',
      content: 'Use deep reasoning',
      backend: 'codex',
      backendConfig: {
        model: 'gpt-5.4',
        executionMode: 'safe-write',
        effort: 'xhigh',
      },
      cwd: process.cwd(),
    });

    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'turn/start',
          params: expect.objectContaining({
            model: 'gpt-5.4',
            effort: 'xhigh',
          }),
        }),
      ]),
    );
    expect(harness.appended).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: 'waypoint-turn-effort',
          type: 'turn.started',
          payload: expect.objectContaining({
            model: 'gpt-5.4',
            effort: 'xhigh',
          }),
        }),
      ]),
    );
    expect(harness.failed).toEqual([]);
  });
});

describe('CodexBackend error notifications', () => {
  it('keeps the turn active when Codex will retry', async () => {
    const harness = createHarness();

    await harness.notify('error', {
      threadId: 'codex-thread-1',
      turnId: 'codex-turn-1',
      willRetry: true,
      error: {
        message: 'Reconnecting... 2/5',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
        additionalDetails: 'upstream stream closed',
      },
    });

    expect(harness.finalized).toEqual([]);
    expect(harness.appended).toEqual([
      expect.objectContaining({
        turnId: 'waypoint-turn-1',
        type: 'tool.output',
        payload: expect.objectContaining({
          kind: 'system',
          text: 'Reconnecting... 2/5\n',
          willRetry: true,
        }),
      }),
    ]);
  });

  it('fails the turn when Codex will not retry', async () => {
    const harness = createHarness();

    await harness.notify('error', {
      threadId: 'codex-thread-1',
      turnId: 'codex-turn-1',
      willRetry: false,
      error: {
        message: 'Response stream disconnected',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
        additionalDetails: 'retry attempts exhausted',
      },
    });

    expect(harness.appended).toEqual([]);
    expect(harness.finalized).toEqual([
      {
        turnId: 'waypoint-turn-1',
        type: 'turn.failed',
        payload: {
          code: 'CODEX_RESPONSE_STREAM_DISCONNECTED',
          message: 'Response stream disconnected',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
          additionalDetails: 'retry attempts exhausted',
          willRetry: false,
        },
      },
    ]);
  });

  it('preserves a failed turn/completed notification as terminal', async () => {
    const harness = createHarness();

    await harness.notify('item/completed', {
      threadId: 'codex-thread-1',
      turnId: 'codex-turn-1',
      item: {
        type: 'agentMessage',
        text: 'partial response without deltas',
      },
    });
    await harness.notify('turn/completed', {
      threadId: 'codex-thread-1',
      turn: {
        id: 'codex-turn-1',
        status: 'failed',
        error: {
          message: 'Context window exceeded',
          codexErrorInfo: 'contextWindowExceeded',
          additionalDetails: null,
        },
      },
    });

    expect(harness.appended).toEqual([]);
    expect(harness.finalized).toEqual([
      {
        turnId: 'waypoint-turn-1',
        type: 'turn.failed',
        payload: {
          code: 'CODEX_CONTEXT_WINDOW_EXCEEDED',
          message: 'Context window exceeded',
          codexErrorInfo: 'contextWindowExceeded',
          additionalDetails: null,
          content: 'partial response without deltas',
        },
      },
    ]);
  });

  it('preserves completed item text when a turn is interrupted', async () => {
    const harness = createHarness();

    await harness.notify('item/completed', {
      threadId: 'codex-thread-1',
      turnId: 'codex-turn-1',
      item: {
        type: 'agentMessage',
        text: 'response before interruption',
      },
    });
    await harness.notify('turn/completed', {
      threadId: 'codex-thread-1',
      turn: {
        id: 'codex-turn-1',
        status: 'interrupted',
      },
    });

    expect(harness.finalized).toEqual([
      {
        turnId: 'waypoint-turn-1',
        type: 'turn.cancelled',
        payload: {
          content: 'response before interruption',
        },
      },
    ]);
  });
});
