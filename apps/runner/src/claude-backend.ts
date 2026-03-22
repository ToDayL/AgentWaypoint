import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SandboxSettings,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ActiveClaudeTurn, ActiveTurn, ModelListItem, ResolveApprovalBody, RunnerEventType, StartTurnBody } from './types.js';

const DEFAULT_CLAUDE_MAX_TURNS = 12;
const STEER_GRACE_WINDOW_MS = 1500;
const DEFAULT_CLAUDE_EXECUTION_MODE = 'safe-write';

type ClaudeBackendDeps = {
  activeTurns: Map<string, ActiveTurn>;
  appendTurnEvent: (turnId: string, type: RunnerEventType, payload: Record<string, unknown>) => Promise<void>;
  finalizeTurn: (turnId: string, type: RunnerEventType, payload: Record<string, unknown>) => Promise<void>;
  failTurn: (turnId: string, message: string) => Promise<void>;
};

export class ClaudeBackend {
  private readonly cancellingTurns = new Set<string>();
  private readonly turnInputs = new Map<string, AsyncInputQueue>();
  private readonly pendingApprovals = new Map<string, PendingClaudeApproval>();
  private readonly pendingApprovalsByTurn = new Map<string, Set<string>>();

  constructor(private readonly deps: ClaudeBackendDeps) {}

  async listModels(): Promise<ModelListItem[]> {
    const stream = query({
      prompt: emptyPromptStream(),
      options: {
        settingSources: ['user'],
      },
    });

    try {
      const models = await stream.supportedModels();
      const items: ModelListItem[] = [];
      models.forEach((model, index) => {
        const value = typeof model.value === 'string' ? model.value.trim() : '';
        if (!value) {
          return;
        }
        const displayName =
          typeof model.displayName === 'string' && model.displayName.trim().length > 0
            ? model.displayName.trim()
            : value;
        const description =
          typeof model.description === 'string' && model.description.trim().length > 0
            ? model.description.trim()
            : '';
        items.push({
          id: value,
          backend: 'claude',
          model: value,
          displayName,
          description,
          hidden: false,
          isDefault: index === 0,
        });
      });
      return items;
    } finally {
      stream.close();
    }
  }

  async startTurn(input: StartTurnBody): Promise<void> {
    let completionResolve: (() => void) | null = null;
    let completionReject: ((error: Error) => void) | null = null;
    const completionPromise = new Promise<void>((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });

    const turn: ActiveClaudeTurn = {
      backend: 'claude',
      turnId: input.turnId,
      sessionId: input.sessionId,
      content: input.content,
      startedAt: new Date().toISOString(),
      finalized: false,
      query: null,
      assistantText: '',
      completionResolve,
      completionReject,
    };
    this.deps.activeTurns.set(input.turnId, turn);

    try {
      const cwd = input.cwd?.trim() || process.cwd();
      const config = readBackendConfig(input.backendConfig);
      const runtimePolicy = resolveClaudeRuntimePolicy(config.executionMode, cwd);
      const resumedSessionId = readNonEmptyString(input.threadId);
      const activeSessionId = resumedSessionId ?? randomUUID();
      const inputQueue = new AsyncInputQueue();
      this.turnInputs.set(turn.turnId, inputQueue);
      inputQueue.push({
        type: 'user',
        message: {
          role: 'user',
          content: input.content,
        },
        parent_tool_use_id: null,
        session_id: input.sessionId,
      });

      const queryOptions: {
        cwd: string;
        model?: string;
        systemPrompt: { type: 'preset'; preset: 'claude_code' };
        settingSources: Array<'user' | 'project' | 'local'>;
        includePartialMessages: true;
        maxTurns: number;
        permissionMode: PermissionMode;
        allowDangerouslySkipPermissions: boolean;
        sandbox: SandboxSettings;
        canUseTool: (
          toolName: string,
          input: Record<string, unknown>,
          options: {
            signal: AbortSignal;
            suggestions?: PermissionUpdate[];
            blockedPath?: string;
            decisionReason?: string;
            title?: string;
            displayName?: string;
            description?: string;
            toolUseID: string;
            agentID?: string;
          },
        ) => Promise<PermissionResult>;
        resume?: string;
        sessionId?: string;
      } = {
        cwd,
        model: config.model ?? undefined,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
        },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        maxTurns: DEFAULT_CLAUDE_MAX_TURNS,
        permissionMode: runtimePolicy.permissionMode,
        allowDangerouslySkipPermissions: runtimePolicy.allowDangerouslySkipPermissions,
        sandbox: runtimePolicy.sandbox,
        canUseTool: (toolName, toolInput, options) => this.requestToolApproval(turn, cwd, toolName, toolInput, options),
      };
      if (resumedSessionId) {
        queryOptions.resume = resumedSessionId;
      } else {
        queryOptions.sessionId = activeSessionId;
      }

      const q = query({
        prompt: inputQueue.stream(),
        options: queryOptions,
      });
      turn.query = q;

      await this.deps.appendTurnEvent(turn.turnId, 'turn.started', {
        threadId: activeSessionId,
        cwd,
        ...(config.model ? { model: config.model } : {}),
        executionMode: runtimePolicy.executionMode,
        approvalPolicy: runtimePolicy.approvalPolicy,
        permissionMode: runtimePolicy.permissionMode,
        ...(runtimePolicy.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
        sandbox: runtimePolicy.sandbox,
      });

      let sawResult = false;
      let sawPartialAssistantDelta = false;
      for await (const message of q) {
        if (turn.finalized) {
          break;
        }
        if (!message || typeof message !== 'object') {
          continue;
        }

        const msg = message as Record<string, unknown>;
        if (msg.type === 'stream_event') {
          const text = extractPartialAssistantText(msg);
          if (text.length > 0) {
            sawPartialAssistantDelta = true;
            turn.assistantText += text;
            await this.deps.appendTurnEvent(turn.turnId, 'assistant.delta', { text });
          }
          continue;
        }

        if (msg.type === 'assistant') {
          if (sawPartialAssistantDelta) {
            continue;
          }
          const text = extractAssistantText(msg);
          if (text.length > 0) {
            turn.assistantText += text;
            await this.deps.appendTurnEvent(turn.turnId, 'assistant.delta', { text });
          }
          continue;
        }

        if (msg.type === 'result') {
          sawResult = true;
          if (this.cancellingTurns.has(turn.turnId)) {
            await this.deps.finalizeTurn(turn.turnId, 'turn.cancelled', {});
            break;
          }
          let hasPendingInput = inputQueue.hasPendingItems();
          if (!hasPendingInput) {
            hasPendingInput = await inputQueue.waitForPendingItems(STEER_GRACE_WINDOW_MS);
          }
          const subtype = typeof msg.subtype === 'string' ? msg.subtype : '';
          if (hasPendingInput) {
            sawPartialAssistantDelta = false;
            continue;
          }
          if (subtype === 'error') {
            const errorText = readNonEmptyString(msg.result) ?? readFirstString(msg.errors) ?? 'Claude query failed';
            await this.deps.failTurn(turn.turnId, errorText);
          } else {
            const content = turn.assistantText || readNonEmptyString(msg.result) || '';
            await this.deps.finalizeTurn(turn.turnId, 'turn.completed', { content });
          }
          break;
        }
      }

      if (!turn.finalized && !sawResult) {
        if (this.cancellingTurns.has(turn.turnId)) {
          await this.deps.finalizeTurn(turn.turnId, 'turn.cancelled', {});
        } else {
          await this.deps.finalizeTurn(turn.turnId, 'turn.completed', { content: turn.assistantText });
        }
      }

      await completionPromise;
    } catch (error: unknown) {
      if (this.cancellingTurns.has(turn.turnId)) {
        await this.deps.finalizeTurn(turn.turnId, 'turn.cancelled', {});
        return;
      }
      const message = error instanceof Error ? error.message : 'unknown claude execution error';
      await this.deps.failTurn(turn.turnId, message);
    } finally {
      this.disposePendingApprovalsForTurn(input.turnId, 'decline');
      this.turnInputs.get(turn.turnId)?.close();
      this.turnInputs.delete(turn.turnId);
      this.cancellingTurns.delete(turn.turnId);
    }
  }

  async cancelTurn(turn: ActiveClaudeTurn): Promise<void> {
    this.cancellingTurns.add(turn.turnId);
    const inputQueue = this.turnInputs.get(turn.turnId);
    inputQueue?.close();
    this.disposePendingApprovalsForTurn(turn.turnId, 'cancel');
    if (!turn.finalized) {
      await this.deps.finalizeTurn(turn.turnId, 'turn.cancelled', {});
    }
    // Do not block HTTP cancel response on SDK interrupt; best-effort in background.
    if (turn.query) {
      void Promise.resolve()
        .then(async () => {
          try {
            await turn.query?.interrupt();
          } catch {
            // Best-effort interrupt.
          }
        })
        .finally(() => {
          turn.query?.close();
        });
    }
  }

  silentlyDisposeTurn(turnId: string): void {
    const turn = this.deps.activeTurns.get(turnId);
    if (!turn || turn.backend !== 'claude' || turn.finalized) {
      return;
    }
    this.cancellingTurns.delete(turnId);
    this.disposePendingApprovalsForTurn(turnId, 'decline');
    this.turnInputs.get(turnId)?.close();
    this.turnInputs.delete(turnId);
    turn.finalized = true;
    turn.query?.close();
    this.deps.activeTurns.delete(turnId);
    turn.completionResolve?.();
  }

  async resolvePendingApproval(input: ResolveApprovalBody): Promise<void> {
    const pending = this.pendingApprovals.get(input.requestId);
    if (!pending || pending.turnId !== input.turnId) {
      throw new Error('Pending approval not found');
    }
    this.pendingApprovals.delete(input.requestId);
    this.removeApprovalFromTurnIndex(pending.turnId, input.requestId);

    const decision = normalizeApprovalDecision(input.decision);
    let permissionResult: PermissionResult;
    if (decision === 'accept') {
      permissionResult = {
        behavior: 'allow',
        updatedInput: pending.toolInput,
        toolUseID: pending.toolUseId,
      };
    } else if (decision === 'acceptForSession') {
      permissionResult =
        pending.suggestions.length > 0
          ? {
              behavior: 'allow',
              updatedInput: pending.toolInput,
              updatedPermissions: pending.suggestions.map((suggestion) => ({ ...suggestion, destination: 'session' })),
              toolUseID: pending.toolUseId,
            }
          : {
              behavior: 'allow',
              updatedInput: pending.toolInput,
              toolUseID: pending.toolUseId,
            };
    } else if (decision === 'cancel') {
      this.cancellingTurns.add(input.turnId);
      permissionResult = {
        behavior: 'deny',
        message: 'User rejected and cancelled this turn.',
        interrupt: true,
        toolUseID: pending.toolUseId,
      };
    } else {
      permissionResult = {
        behavior: 'deny',
        message: 'User rejected this operation.',
        toolUseID: pending.toolUseId,
      };
    }

    await this.deps.appendTurnEvent(input.turnId, 'turn.approval.resolved', {
      requestId: input.requestId,
      decision,
    });
    pending.resolve(permissionResult);
  }

  disposePendingApprovalsForTurn(turnId: string, decision: 'decline' | 'cancel'): void {
    const requestIds = this.pendingApprovalsByTurn.get(turnId);
    if (!requestIds || requestIds.size === 0) {
      return;
    }
    this.pendingApprovalsByTurn.delete(turnId);
    requestIds.forEach((requestId) => {
      const pending = this.pendingApprovals.get(requestId);
      if (!pending) {
        return;
      }
      this.pendingApprovals.delete(requestId);
      pending.resolve(
        decision === 'cancel'
          ? {
              behavior: 'deny',
              message: 'Turn was cancelled while waiting for approval.',
              interrupt: true,
              toolUseID: pending.toolUseId,
            }
          : {
              behavior: 'deny',
              message: 'Turn ended before approval was provided.',
              toolUseID: pending.toolUseId,
            },
      );
    });
  }

  async steerTurn(turn: ActiveClaudeTurn, content: string): Promise<void> {
    if (turn.finalized) {
      throw new Error('Turn is already finalized');
    }
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Steer content is required');
    }
    const inputQueue = this.turnInputs.get(turn.turnId);
    if (!inputQueue) {
      throw new Error('Steer input queue is unavailable');
    }
    inputQueue.push({
      type: 'user',
      message: {
        role: 'user',
        content: trimmed,
      },
      parent_tool_use_id: null,
      session_id: turn.sessionId,
    });
  }

  private async requestToolApproval(
    turn: ActiveClaudeTurn,
    cwd: string,
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      decisionReason?: string;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
      agentID?: string;
    },
  ): Promise<PermissionResult> {
    if (turn.finalized || this.cancellingTurns.has(turn.turnId)) {
      return {
        behavior: 'deny',
        message: 'Turn is already terminating.',
        interrupt: true,
        toolUseID: options.toolUseID,
      };
    }

    const requestId = `claude-${turn.turnId}-${options.toolUseID}`;
    const suggestions = Array.isArray(options.suggestions) ? options.suggestions : [];
    const kind = mapToolNameToApprovalKind(toolName);
    const reason = options.title ?? options.description ?? options.decisionReason ?? `Permission required for ${toolName}`;
    const command = extractApprovalCommand(toolName, input);

    await this.deps.appendTurnEvent(turn.turnId, 'turn.approval.requested', {
      requestId,
      kind,
      reason,
      cwd,
      ...(command ? { command } : {}),
      toolName,
      toolUseId: options.toolUseID,
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      ...(options.agentID ? { agentId: options.agentID } : {}),
      availableDecisions: suggestions.length > 0 ? ['accept', 'acceptForSession', 'decline', 'cancel'] : ['accept', 'decline', 'cancel'],
    });

    return await new Promise<PermissionResult>((resolve) => {
      let settled = false;
      const settle = (result: PermissionResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        options.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const pending: PendingClaudeApproval = {
        turnId: turn.turnId,
        requestId,
        toolUseId: options.toolUseID,
        toolInput: input,
        suggestions,
        resolve: settle,
      };
      this.pendingApprovals.set(requestId, pending);
      this.addApprovalToTurnIndex(turn.turnId, requestId);

      const onAbort = () => {
        if (!this.pendingApprovals.has(requestId)) {
          return;
        }
        this.pendingApprovals.delete(requestId);
        this.removeApprovalFromTurnIndex(turn.turnId, requestId);
        void this.deps.appendTurnEvent(turn.turnId, 'turn.approval.resolved', {
          requestId,
          decision: 'cancel',
        });
        settle({
          behavior: 'deny',
          message: 'Approval request was interrupted.',
          interrupt: true,
          toolUseID: options.toolUseID,
        });
      };

      options.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private addApprovalToTurnIndex(turnId: string, requestId: string): void {
    const ids = this.pendingApprovalsByTurn.get(turnId);
    if (ids) {
      ids.add(requestId);
      return;
    }
    this.pendingApprovalsByTurn.set(turnId, new Set([requestId]));
  }

  private removeApprovalFromTurnIndex(turnId: string, requestId: string): void {
    const ids = this.pendingApprovalsByTurn.get(turnId);
    if (!ids) {
      return;
    }
    ids.delete(requestId);
    if (ids.size === 0) {
      this.pendingApprovalsByTurn.delete(turnId);
    }
  }
}

type PendingClaudeApproval = {
  turnId: string;
  requestId: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
};

function readBackendConfig(
  config: Record<string, unknown> | null | undefined,
): { model: string | null; executionMode: string | null } {
  const model =
    config && typeof config.model === 'string' && config.model.trim().length > 0 ? config.model.trim() : null;
  const executionMode =
    config && typeof config.executionMode === 'string' && config.executionMode.trim().length > 0
      ? config.executionMode.trim()
      : DEFAULT_CLAUDE_EXECUTION_MODE;
  return { model, executionMode };
}

function resolveClaudeRuntimePolicy(executionMode: string | null, cwd: string): {
  executionMode: 'read-only' | 'safe-write' | 'yolo';
  approvalPolicy: 'on-request' | 'never';
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions: boolean;
  sandbox: SandboxSettings;
} {
  if (executionMode === 'read-only') {
    return {
      executionMode: 'read-only',
      approvalPolicy: 'on-request',
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: true,
      },
    };
  }
  if (executionMode === 'yolo') {
    return {
      executionMode: 'yolo',
      approvalPolicy: 'never',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      sandbox: {
        enabled: false,
        allowUnsandboxedCommands: true,
      },
    };
  }
  return {
    executionMode: 'safe-write',
    approvalPolicy: 'on-request',
    permissionMode: 'acceptEdits',
    allowDangerouslySkipPermissions: false,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
    },
  };
}

function extractAssistantText(message: Record<string, unknown>): string {
  const payload = message.message;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  const content = (payload as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return '';
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== 'text') {
      continue;
    }
    const text = typeof record.text === 'string' ? record.text : '';
    if (text.length > 0) {
      chunks.push(text);
    }
  }
  return chunks.join('');
}

function extractApprovalCommand(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'Bash') {
    const command = readNonEmptyString(input.command);
    if (command) {
      return command;
    }
  }
  const argv = input.argv;
  if (Array.isArray(argv)) {
    const command = argv
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
      .join(' ');
    if (command.length > 0) {
      return command;
    }
  }
  return null;
}

function mapToolNameToApprovalKind(toolName: string): string {
  if (toolName === 'Bash') {
    return 'command_execution';
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    return 'file_change';
  }
  return 'permission';
}


function normalizeApprovalDecision(
  decision: ResolveApprovalBody['decision'],
): 'accept' | 'acceptForSession' | 'decline' | 'cancel' {
  if (decision === 'accept' || decision === 'acceptForSession' || decision === 'decline' || decision === 'cancel') {
    return decision;
  }
  throw new Error('Claude backend only supports accept/acceptForSession/decline/cancel approval decisions');
}

function extractPartialAssistantText(message: Record<string, unknown>): string {
  const event = message.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return '';
  }
  const record = event as Record<string, unknown>;
  if (record.type !== 'content_block_delta') {
    return '';
  }
  const delta = record.delta;
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
    return '';
  }
  const deltaRecord = delta as Record<string, unknown>;
  const directText = typeof deltaRecord.text === 'string' ? deltaRecord.text : '';
  if (directText.length > 0) {
    return directText;
  }
  if (deltaRecord.type === 'text_delta' && typeof deltaRecord.text === 'string') {
    return deltaRecord.text;
  }
  return '';
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFirstString(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const item of value) {
    const text = readNonEmptyString(item);
    if (text) {
      return text;
    }
  }
  return null;
}

async function* emptyPromptStream(): AsyncGenerator<never, void, unknown> {
  return;
}

class AsyncInputQueue {
  private readonly items: SDKUserMessage[] = [];
  private closed = false;
  private waitingResolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private readonly pendingWaiters = new Set<(pending: boolean) => void>();

  push(item: SDKUserMessage): void {
    if (this.closed) {
      throw new Error('Input queue is closed');
    }
    this.pendingWaiters.forEach((resolve) => resolve(true));
    this.pendingWaiters.clear();
    if (this.waitingResolve) {
      const resolve = this.waitingResolve;
      this.waitingResolve = null;
      resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    this.items.length = 0;
    this.pendingWaiters.forEach((resolve) => resolve(false));
    this.pendingWaiters.clear();
    if (this.waitingResolve) {
      const resolve = this.waitingResolve;
      this.waitingResolve = null;
      resolve({ value: undefined, done: true });
    }
  }

  stream(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            if (self.items.length > 0) {
              const value = self.items.shift();
              if (!value) {
                return { value: undefined, done: true };
              }
              return { value, done: false };
            }
            if (self.closed) {
              return { value: undefined, done: true };
            }
            return await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
              self.waitingResolve = resolve;
            });
          },
        };
      },
    };
  }

  hasPendingItems(): boolean {
    return this.items.length > 0;
  }

  async waitForPendingItems(timeoutMs: number): Promise<boolean> {
    if (this.items.length > 0) {
      return true;
    }
    if (this.closed || timeoutMs <= 0) {
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWaiters.delete(onPending);
        resolve(false);
      }, timeoutMs);
      const onPending = (pending: boolean): void => {
        clearTimeout(timer);
        this.pendingWaiters.delete(onPending);
        resolve(pending);
      };
      this.pendingWaiters.add(onPending);
    });
  }
}
