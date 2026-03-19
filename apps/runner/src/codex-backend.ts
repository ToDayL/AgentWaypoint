import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type {
  ActiveCodexTurn,
  ActiveTurn,
  CodexWorker,
  CloseThreadBody,
  CompactThreadBody,
  ForkThreadBody,
  ModelListItem,
  SkillListItem,
  PendingApprovalRequest,
  ResolveApprovalBody,
  RunnerEventType,
  StartTurnBody,
  SteerTurnBody,
} from './types.js';

type CodexBackendConfig = {
  codexBin: string;
  codexDefaultCwd: string;
  codexDefaultModel: string | null;
  codexApprovalPolicy: string;
  codexSandboxMode: string | null;
};

type CodexBackendDeps = {
  activeTurns: Map<string, ActiveTurn>;
  appendTurnEvent: (turnId: string, type: RunnerEventType, payload: Record<string, unknown>) => Promise<void>;
  finalizeTurn: (turnId: string, type: RunnerEventType, payload: Record<string, unknown>) => Promise<void>;
  failTurn: (turnId: string, message: string) => Promise<void>;
};

export class CodexBackend {
  private codexWorkerPromise: Promise<CodexWorker> | null = null;
  private readonly pendingApprovalRequests = new Map<string, PendingApprovalRequest>();
  private readonly rawNotificationLogMode: 'off' | 'all' | 'usage';

  constructor(
    private readonly config: CodexBackendConfig,
    private readonly deps: CodexBackendDeps,
  ) {
    const mode = (process.env.RUNNER_LOG_RAW_NOTIFICATIONS ?? '').trim().toLowerCase();
    this.rawNotificationLogMode =
      mode === '1' || mode === 'true' || mode === 'all'
        ? 'all'
        : mode === 'usage'
          ? 'usage'
          : 'off';
  }

  async listModels(): Promise<ModelListItem[]> {
    const worker = await this.ensureCodexWorker();
    await worker.readyPromise;

    const items: ModelListItem[] = [];
    let cursor: string | null = null;

    while (true) {
      const result = (await this.sendWorkerRequest(worker, 'model/list', {
        cursor,
        includeHidden: false,
        limit: 100,
      })) as Record<string, unknown>;

      const data = Array.isArray(result.data) ? result.data : [];
      for (const entry of data) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const record = entry as Record<string, unknown>;
        const id = readOptionalString(record.id) ?? '';
        const model = readOptionalString(record.model) ?? '';
        if (!id || !model) {
          continue;
        }
        items.push({
          id,
          model,
          displayName: readOptionalString(record.displayName) ?? model,
          description: readOptionalString(record.description) ?? '',
          hidden: record.hidden === true,
          isDefault: record.isDefault === true,
        });
      }

      const nextCursor = readOptionalString(result.nextCursor);
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }

    return items;
  }

  async listSkills(cwd: string): Promise<SkillListItem[]> {
    const worker = await this.ensureCodexWorker();
    await worker.readyPromise;

    const result = (await this.sendWorkerRequest(worker, 'skills/list', {
      cwds: [cwd],
      forceReload: false,
    })) as Record<string, unknown>;

    const entries = Array.isArray(result.data) ? result.data : [];
    const skillItems: SkillListItem[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const skills = Array.isArray((entry as { skills?: unknown }).skills) ? (entry as { skills: unknown[] }).skills : [];
      for (const skillEntry of skills) {
        if (!skillEntry || typeof skillEntry !== 'object') {
          continue;
        }
        const record = skillEntry as Record<string, unknown>;
        const name = readOptionalString(record.name) ?? '';
        if (!name) {
          continue;
        }
        skillItems.push({
          name,
          description: readOptionalString(record.description) ?? '',
          path: readOptionalString(record.path) ?? '',
          enabled: record.enabled !== false,
        });
      }
    }

    const deduped = new Map<string, SkillListItem>();
    for (const item of skillItems) {
      if (!deduped.has(item.name)) {
        deduped.set(item.name, item);
      }
    }
    return Array.from(deduped.values());
  }

  async readAccountRateLimits(): Promise<Record<string, unknown>> {
    const worker = await this.ensureCodexWorker();
    await worker.readyPromise;
    const result = await this.sendWorkerRequest(worker, 'account/rateLimits/read', null);
    if (!result || typeof result !== 'object') {
      throw new Error('account/rateLimits/read returned invalid response');
    }
    return result as Record<string, unknown>;
  }

  async startTurn(input: StartTurnBody): Promise<void> {
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
    this.deps.activeTurns.set(input.turnId, turn);

    try {
      const worker = await this.ensureCodexWorker();
      await worker.readyPromise;

      const workspaceCwd = input.cwd?.trim() || this.config.codexDefaultCwd;
      const model = input.model?.trim() || this.config.codexDefaultModel;
      const sandbox = input.sandbox?.trim() || this.config.codexSandboxMode;
      const approvalPolicy = input.approvalPolicy?.trim() || this.config.codexApprovalPolicy;
      const threadId = await this.resolveThreadId(worker, input.threadId ?? null, workspaceCwd, {
        model,
        sandbox,
        approvalPolicy,
      });
      turn.threadId = threadId;

      const turnStartResult = (await this.sendWorkerRequest(worker, 'turn/start', {
        threadId,
        input: [{ type: 'text', text: input.content, text_elements: [] }],
      })) as Record<string, unknown>;
      turn.codexTurnId = readNestedString(turnStartResult, ['turn', 'id']);

      await this.deps.appendTurnEvent(turn.turnId, 'turn.started', {
        threadId,
        cwd: workspaceCwd,
        ...(model ? { model } : {}),
        ...(sandbox ? { sandbox } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
      });
      await completionPromise;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown codex execution error';
      await this.deps.failTurn(turn.turnId, message);
    }
  }

  async forkThread(input: ForkThreadBody): Promise<string> {
    const worker = await this.ensureCodexWorker();
    await worker.readyPromise;

    const result = (await this.sendWorkerRequest(worker, 'thread/fork', {
      threadId: input.threadId,
      cwd: input.cwd ?? this.config.codexDefaultCwd,
      model: input.model ?? this.config.codexDefaultModel,
      sandbox: input.sandbox ?? this.config.codexSandboxMode,
      approvalPolicy: input.approvalPolicy ?? this.config.codexApprovalPolicy,
    })) as Record<string, unknown>;
    const threadId = readNestedString(result, ['thread', 'id']);
    if (!threadId) {
      throw new Error('thread/fork did not return thread id');
    }
    return threadId;
  }

  async closeThread(input: CloseThreadBody): Promise<void> {
    const worker = await this.ensureCodexWorker();
    await worker.readyPromise;
    await this.sendWorkerRequest(worker, 'thread/archive', {
      threadId: input.threadId,
    });
  }

  async compactThread(input: CompactThreadBody): Promise<void> {
    const worker = await this.ensureCodexWorker();
    await worker.readyPromise;
    const cwd = input.cwd?.trim() || this.config.codexDefaultCwd;
    const model = input.model?.trim() || this.config.codexDefaultModel;
    const sandbox = input.sandbox?.trim() || this.config.codexSandboxMode;
    const approvalPolicy = input.approvalPolicy?.trim() || this.config.codexApprovalPolicy;

    await this.sendWorkerRequest(worker, 'thread/resume', {
      threadId: input.threadId,
      cwd,
      model,
      sandbox,
      approvalPolicy,
      persistExtendedHistory: false,
    });

    await this.sendWorkerRequest(worker, 'thread/compact/start', {
      threadId: input.threadId,
    });
  }

  async steerTurn(input: SteerTurnBody): Promise<void> {
    const turn = this.deps.activeTurns.get(input.turnId);
    if (!turn || turn.finalized || turn.backend !== 'codex') {
      throw new Error('Active codex turn not found');
    }
    if (!turn.threadId || !turn.codexTurnId) {
      throw new Error('Turn is not ready for steering yet');
    }

    const worker = await this.ensureCodexWorker();
    await worker.readyPromise;
    await this.sendWorkerRequest(worker, 'turn/steer', {
      threadId: turn.threadId,
      expectedTurnId: turn.codexTurnId,
      input: [{ type: 'text', text: input.content, text_elements: [] }],
    });
  }

  async cancelTurn(turn: ActiveCodexTurn, options: { emitCancelEvent: boolean }): Promise<void> {
    if (!options.emitCancelEvent) {
      this.silentlyDisposeTurn(turn.turnId);
      return;
    }

    if (turn.threadId && turn.codexTurnId) {
      try {
        const worker = await this.ensureCodexWorker();
        await this.sendWorkerRequest(worker, 'turn/interrupt', {
          threadId: turn.threadId,
          turnId: turn.codexTurnId,
        });
      } catch {
        // Best-effort interrupt; shutdown still proceeds.
      }
    }
    await this.deps.finalizeTurn(turn.turnId, 'turn.cancelled', {});
  }

  silentlyDisposeTurn(turnId: string): void {
    const turn = this.deps.activeTurns.get(turnId);
    if (!turn || turn.backend !== 'codex' || turn.finalized) {
      return;
    }
    turn.finalized = true;
    void this.disposePendingApprovalsForTurn(turn.turnId, 'decline');
    this.deps.activeTurns.delete(turn.turnId);
    turn.completionResolve?.();
  }

  async resolvePendingApproval(input: ResolveApprovalBody): Promise<void> {
    const pending = this.pendingApprovalRequests.get(input.requestId);
    if (!pending || pending.turnId !== input.turnId) {
      throw new Error('Pending approval not found');
    }

    const result = buildApprovalResponse(pending.method, pending.params, input.decision);
    this.respondToServerRequest(pending.worker, pending.rawRequestId, { result });
    this.pendingApprovalRequests.delete(input.requestId);
    await this.deps.appendTurnEvent(input.turnId, 'turn.approval.resolved', {
      requestId: input.requestId,
      decision: describeApprovalDecision(input.decision),
    });
  }

  async disposePendingApprovalsForTurn(turnId: string, decision: 'decline' | 'cancel'): Promise<void> {
    const pendingIds = [...this.pendingApprovalRequests.values()]
      .filter((entry) => entry.turnId === turnId)
      .map((entry) => entry.requestId);

    for (const requestId of pendingIds) {
      const pending = this.pendingApprovalRequests.get(requestId);
      if (!pending) {
        continue;
      }
      const result = buildApprovalResponse(pending.method, pending.params, decision);
      this.respondToServerRequest(pending.worker, pending.rawRequestId, { result });
      this.pendingApprovalRequests.delete(requestId);
      await this.deps.appendTurnEvent(turnId, 'turn.approval.resolved', {
        requestId,
        decision: describeApprovalDecision(decision),
      });
    }
  }

  private async ensureCodexWorker(): Promise<CodexWorker> {
    if (this.codexWorkerPromise) {
      return this.codexWorkerPromise;
    }

    this.codexWorkerPromise = (async () => {
      const child = spawn(this.config.codexBin, ['app-server', '--listen', 'stdio://'], {
        cwd: this.config.codexDefaultCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });

      const worker: CodexWorker = {
        process: child,
        nextRequestId: 1,
        pendingRequests: new Map(),
        notificationQueue: Promise.resolve(),
        readyPromise: Promise.resolve(),
        closed: false,
      };

      const stdoutReader = createInterface({ input: child.stdout });
      stdoutReader.on('line', (line) => {
        worker.notificationQueue = worker.notificationQueue
          .then(async () => {
            await this.handleWorkerMessage(worker, line);
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'unknown worker message error';
            console.error(`[agentwaypoint-runner] worker notification error: ${message}`);
          });
      });

      child.stderr.on('data', (chunk) => {
        const message = chunk.toString('utf8').trim();
        if (message) {
          console.error(`[agentwaypoint-runner] codex stderr: ${message}`);
        }
      });

      child.on('error', (error) => {
        this.handleWorkerExit(worker, `Failed to start codex app-server: ${error.message}`);
      });

      child.on('close', (code, signal) => {
        this.handleWorkerExit(worker, `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      });

      worker.readyPromise = (async () => {
        await this.sendWorkerRequest(worker, 'initialize', {
          clientInfo: { name: 'agentwaypoint-runner', version: '0.1.0' },
          capabilities: null,
        });
        this.sendWorkerNotification(worker, 'initialized', {});
      })();

      return worker;
    })();

    return this.codexWorkerPromise;
  }

  private handleWorkerExit(worker: CodexWorker, reason: string): void {
    if (worker.closed) {
      return;
    }
    worker.closed = true;

    worker.pendingRequests.forEach(({ timeout, reject }) => {
      clearTimeout(timeout);
      reject(new Error(reason));
    });
    worker.pendingRequests.clear();

    this.codexWorkerPromise = null;

    this.deps.activeTurns.forEach((turn) => {
      if (turn.backend === 'codex' && !turn.finalized) {
        void this.deps.failTurn(turn.turnId, reason);
      }
    });
  }

  private async resolveThreadId(
    worker: CodexWorker,
    preferredThreadId: string | null,
    cwd: string,
    options: { model: string | null; sandbox: string | null; approvalPolicy: string | null },
  ): Promise<string> {
    if (preferredThreadId) {
      try {
        await this.sendWorkerRequest(worker, 'thread/resume', {
          threadId: preferredThreadId,
          cwd,
          model: options.model,
          sandbox: options.sandbox,
          approvalPolicy: options.approvalPolicy,
          persistExtendedHistory: false,
        });
        return preferredThreadId;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown resume error';
        console.error(`[agentwaypoint-runner] thread/resume failed for ${preferredThreadId}: ${message}`);
      }
    }

    const threadStartResult = (await this.sendWorkerRequest(worker, 'thread/start', {
      cwd,
      approvalPolicy: options.approvalPolicy ?? this.config.codexApprovalPolicy,
      sandbox: options.sandbox ?? this.config.codexSandboxMode,
      model: options.model,
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

  private async handleWorkerMessage(worker: CodexWorker, line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(trimmed) as unknown;
    } catch {
      console.error(`[agentwaypoint-runner] invalid JSON from codex worker: ${trimmed}`);
      return;
    }

    if (!message || typeof message !== 'object') {
      return;
    }

    const record = message as Record<string, unknown>;
    if (typeof record.id === 'number' && ('result' in record || 'error' in record)) {
      this.resolveWorkerRequest(worker, record);
      return;
    }

    if ((typeof record.id === 'number' || typeof record.id === 'string') && typeof record.method === 'string') {
      await this.handleServerRequest(worker, record);
      return;
    }

    const method = record.method;
    if (typeof method !== 'string') {
      return;
    }
    const params = (record.params ?? {}) as Record<string, unknown>;
    await this.handleCodexNotification(method, params);
  }

  private async sendWorkerRequest(worker: CodexWorker, method: string, params: unknown): Promise<unknown> {
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

  private sendWorkerNotification(worker: CodexWorker, method: string, params: unknown): void {
    if (worker.closed || !worker.process.stdin.writable) {
      return;
    }
    worker.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private resolveWorkerRequest(worker: CodexWorker, message: Record<string, unknown>): void {
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

  private async handleCodexNotification(method: string, params: Record<string, unknown>): Promise<void> {
    this.logRawNotification(method, params);

    if (method === 'turn/started') {
      const threadId = readNestedString(params, ['threadId']);
      const codexTurnId = readNestedString(params, ['turn', 'id']);
      if (!threadId) {
        return;
      }
      const turn = this.findTurnByThread(threadId, codexTurnId);
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
      const turn = this.findTurnByThread(threadId, codexTurnId);
      if (!turn || turn.finalized) {
        return;
      }
      if (codexTurnId && !turn.codexTurnId) {
        turn.codexTurnId = codexTurnId;
      }
      turn.assistantText += delta;
      await this.deps.appendTurnEvent(turn.turnId, 'assistant.delta', { text: delta });
      return;
    }

    if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      const threadId = readNestedString(params, ['threadId']);
      const codexTurnId = readNestedString(params, ['turnId']);
      if (!threadId) {
        return;
      }
      const turn = this.findTurnByThread(threadId, codexTurnId);
      if (!turn || turn.finalized) {
        return;
      }
      const payload = buildToolOutputPayload(method, params);
      if (!payload.text) {
        return;
      }
      await this.deps.appendTurnEvent(turn.turnId, 'tool.output', payload);
      return;
    }

    if (method === 'item/completed') {
      const threadId = readNestedString(params, ['threadId']);
      const codexTurnId = readNestedString(params, ['turnId']);
      if (!threadId) {
        return;
      }
      const turn = this.findTurnByThread(threadId, codexTurnId);
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

      await this.deps.appendTurnEvent(turn.turnId, 'tool.completed', buildToolLifecyclePayload('completed', params));
      return;
    }

    if (method === 'item/started') {
      const threadId = readNestedString(params, ['threadId']);
      const codexTurnId = readNestedString(params, ['turnId']);
      if (!threadId) {
        return;
      }
      const turn = this.findTurnByThread(threadId, codexTurnId);
      if (!turn || turn.finalized) {
        return;
      }
      await this.deps.appendTurnEvent(turn.turnId, 'tool.started', buildToolLifecyclePayload('started', params));
      return;
    }

    if (method === 'turn/plan/updated') {
      const threadId = readNestedString(params, ['threadId']);
      const codexTurnId = readNestedString(params, ['turnId']);
      if (!threadId) {
        return;
      }
      const turn = this.findTurnByThread(threadId, codexTurnId);
      if (!turn || turn.finalized) {
        return;
      }
      await this.deps.appendTurnEvent(turn.turnId, 'plan.updated', {
        explanation: typeof params.explanation === 'string' ? params.explanation : null,
        plan: Array.isArray(params.plan) ? params.plan : [],
      });
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      const threadId = readNestedString(params, ['threadId']);
      const codexTurnId = readNestedString(params, ['turnId']);
      if (!threadId) {
        return;
      }
      const turn = this.findTurnByThread(threadId, codexTurnId);
      if (!turn) {
        return;
      }

      const modelContextWindow = readNestedNumber(params, ['tokenUsage', 'modelContextWindow']);
      const totalTokens = readNestedNumber(params, ['tokenUsage', 'last', 'inputTokens']);
      const remainingTokens =
        modelContextWindow !== null && totalTokens !== null ? Math.max(modelContextWindow - totalTokens, 0) : null;
      const remainingRatio =
        modelContextWindow !== null && modelContextWindow > 0 && remainingTokens !== null
          ? remainingTokens / modelContextWindow
          : null;

      await this.deps.appendTurnEvent(turn.turnId, 'thread.token_usage.updated', {
        threadId,
        turnId: codexTurnId,
        modelContextWindow,
        totalTokens,
        remainingTokens,
        remainingRatio,
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
      const turn = this.findTurnByThread(threadId, codexTurnId);
      if (!turn || turn.finalized) {
        return;
      }
      await this.deps.appendTurnEvent(turn.turnId, 'reasoning.delta', {
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
      const turn = this.findTurnByThread(threadId, codexTurnId);
      if (!turn || turn.finalized) {
        return;
      }
      const diffText = readOptionalPayloadString(params.diff) ?? readOptionalPayloadString(params.unifiedDiff);
      await this.deps.appendTurnEvent(turn.turnId, 'diff.updated', {
        diffStat: readOptionalObject(params.diffStat),
        diffAvailable: !!diffText,
        unifiedDiff: diffText,
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
      const turn = this.findTurnByThread(threadId, codexTurnId);
      if (!turn || turn.finalized) {
        return;
      }

      const status = readNestedString(params, ['turn', 'status']);
      if (status === 'failed') {
        const message = readNestedString(params, ['turn', 'error', 'message']) || 'Codex turn failed';
        await this.deps.finalizeTurn(turn.turnId, 'turn.failed', { message });
        return;
      }
      if (status === 'interrupted') {
        await this.deps.finalizeTurn(turn.turnId, 'turn.cancelled', {});
        return;
      }

      const content = turn.assistantText || extractAssistantTextFromTurn(params) || '(no assistant output)';
      await this.deps.finalizeTurn(turn.turnId, 'turn.completed', { content });
      return;
    }

    if (method === 'error') {
      const threadId = readNestedString(params, ['threadId']);
      const codexTurnId = readNestedString(params, ['turnId']);
      if (!threadId) {
        return;
      }
      const turn = this.findTurnByThread(threadId, codexTurnId);
      if (!turn || turn.finalized) {
        return;
      }

      const message = readNestedString(params, ['error', 'message']) || 'Codex runner error';
      await this.deps.finalizeTurn(turn.turnId, 'turn.failed', { message });
    }
  }

  private logRawNotification(method: string, params: Record<string, unknown>): void {
    if (this.rawNotificationLogMode === 'off') {
      return;
    }
    if (this.rawNotificationLogMode === 'usage' && method !== 'thread/tokenUsage/updated') {
      return;
    }

    try {
      console.log(`[agentwaypoint-runner] raw notification ${method}: ${JSON.stringify(params)}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'serialize failed';
      console.error(`[agentwaypoint-runner] raw notification ${method}: <unserializable: ${message}>`);
    }
  }

  private async handleServerRequest(worker: CodexWorker, message: Record<string, unknown>): Promise<void> {
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
      this.respondToServerRequest(worker, rawRequestId, { error: { message: `Unsupported server request: ${String(method)}` } });
      return;
    }

    const params = message.params;
    if (!params || typeof params !== 'object') {
      this.respondToServerRequest(worker, rawRequestId, { error: { message: 'Server request params must be an object' } });
      return;
    }

    const paramsRecord = params as Record<string, unknown>;
    const threadId = readNestedString(paramsRecord, ['threadId']);
    const codexTurnId = readNestedString(paramsRecord, ['turnId']);
    if (!threadId) {
      this.respondToServerRequest(worker, rawRequestId, { error: { message: 'Approval request missing threadId' } });
      return;
    }

    const turn = this.findTurnByThread(threadId, codexTurnId);
    if (!turn || turn.finalized) {
      this.respondToServerRequest(worker, rawRequestId, { error: { message: 'Approval request turn is no longer active' } });
      return;
    }

    const requestId = String(rawRequestId);
    this.pendingApprovalRequests.set(requestId, {
      worker,
      rawRequestId,
      requestId,
      turnId: turn.turnId,
      method,
      params: paramsRecord,
    });

    await this.deps.appendTurnEvent(turn.turnId, 'turn.approval.requested', buildApprovalRequestedPayload(requestId, method, paramsRecord));
  }

  private findTurnByThread(threadId: string, codexTurnId: string | null): ActiveCodexTurn | null {
    let fallback: ActiveCodexTurn | null = null;
    for (const turn of this.deps.activeTurns.values()) {
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

  private respondToServerRequest(
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

function readNestedNumber(record: Record<string, unknown>, path: string[]): number | null {
  let value: unknown = record;
  for (const key of path) {
    if (!value || typeof value !== 'object') {
      return null;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function readOptionalPayloadString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCommandForDisplay(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const command = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
      .join(' ');
    return command.length > 0 ? command : null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      readCommandForDisplay(record.command) ??
      readCommandForDisplay(record.argv) ??
      readCommandForDisplay(record.args) ??
      null
    );
  }
  return null;
}

function readOptionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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
      command: readCommandForDisplay(params.command),
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
