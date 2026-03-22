import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookCallbackMatcher,
  HookEvent,
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
  private readonly startedToolCallsByTurn = new Map<string, Set<string>>();
  private readonly aggregatedDiffsByTurn = new Map<string, Map<string, AggregatedDiffFile>>();

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
        hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
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
        hooks: this.buildClaudeHooks(turn.turnId),
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
          const thinkingDelta = extractPartialThinkingText(msg);
          if (thinkingDelta.length > 0) {
            await this.deps.appendTurnEvent(turn.turnId, 'reasoning.delta', { delta: thinkingDelta });
          }
          const startedTool = extractToolStartFromStreamEvent(msg);
          if (startedTool) {
            await this.emitToolStarted(turn.turnId, startedTool);
          }
          continue;
        }

        if (msg.type === 'tool_progress') {
          const toolCallId = readNonEmptyString(msg.tool_use_id) ?? `tool-${turn.turnId}-${Date.now()}`;
          const title = readNonEmptyString(msg.tool_name) ?? 'tool';
          await this.emitToolStarted(turn.turnId, {
            toolCallId,
            title,
            kind: title,
          });
          const elapsed = typeof msg.elapsed_time_seconds === 'number' && Number.isFinite(msg.elapsed_time_seconds)
            ? msg.elapsed_time_seconds
            : null;
          const taskId = readNonEmptyString(msg.task_id);
          await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
            toolCallId,
            title,
            kind: title,
            output: elapsed === null ? 'Running' : `Running (${elapsed.toFixed(1)}s)`,
            ...(taskId ? { taskId } : {}),
          });
          continue;
        }

        if (msg.type === 'tool_use_summary') {
          const summary = readNonEmptyString(msg.summary);
          const ids = Array.isArray(msg.preceding_tool_use_ids) ? msg.preceding_tool_use_ids : [];
          const toolCallId = ids.map(readNonEmptyString).find((id): id is string => !!id) ?? `tool-${turn.turnId}-${Date.now()}`;
          if (summary && summary.length > 0) {
            await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
              toolCallId,
              title: 'tool',
              kind: 'tool',
              output: summary,
            });
          }
          await this.deps.appendTurnEvent(turn.turnId, 'tool.completed', {
            toolCallId,
            title: 'tool',
            kind: 'tool',
            summary: summary ?? '',
          });
          continue;
        }

        if (msg.type === 'system') {
          const subtype = readNonEmptyString(msg.subtype);
          if (subtype === 'task_started') {
            const taskId = readNonEmptyString(msg.task_id) ?? `task-${turn.turnId}-${Date.now()}`;
            const description = readNonEmptyString(msg.description) ?? 'task';
            await this.emitToolStarted(turn.turnId, {
              toolCallId: taskId,
              title: 'Task',
              kind: 'task',
            });
            await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
              toolCallId: taskId,
              title: 'Task',
              kind: 'task',
              output: description,
            });
            continue;
          }
          if (subtype === 'task_progress') {
            const taskId = readNonEmptyString(msg.task_id) ?? `task-${turn.turnId}-${Date.now()}`;
            const description = readNonEmptyString(msg.description);
            if (description) {
              await this.deps.appendTurnEvent(turn.turnId, 'reasoning.delta', { delta: `${description}\n` });
              await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
                toolCallId: taskId,
                title: 'Task',
                kind: 'task',
                output: description,
              });
            }
            continue;
          }
          if (subtype === 'task_notification') {
            const taskId = readNonEmptyString(msg.task_id) ?? `task-${turn.turnId}-${Date.now()}`;
            const summary = readNonEmptyString(msg.summary) ?? 'task completed';
            await this.deps.appendTurnEvent(turn.turnId, 'tool.completed', {
              toolCallId: taskId,
              title: 'Task',
              kind: 'task',
              summary,
            });
            continue;
          }
          if (subtype === 'local_command_output') {
            const content = readNonEmptyString(msg.content);
            if (content) {
              await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
                toolCallId: `local-command-${turn.turnId}`,
                title: 'Local Command',
                kind: 'local_command',
                output: content,
              });
            }
            continue;
          }
          if (subtype === 'hook_started') {
            const hookId = readNonEmptyString(msg.hook_id) ?? `hook-${turn.turnId}-${Date.now()}`;
            const hookName = readNonEmptyString(msg.hook_name) ?? 'hook';
            const hookEvent = readNonEmptyString(msg.hook_event) ?? '';
            await this.emitToolStarted(turn.turnId, {
              toolCallId: hookId,
              title: `Hook: ${hookName}`,
              kind: 'hook',
            });
            if (hookEvent) {
              await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
                toolCallId: hookId,
                title: `Hook: ${hookName}`,
                kind: 'hook',
                output: `Event: ${hookEvent}`,
              });
            }
            continue;
          }
          if (subtype === 'hook_progress') {
            const hookId = readNonEmptyString(msg.hook_id) ?? `hook-${turn.turnId}-${Date.now()}`;
            const hookName = readNonEmptyString(msg.hook_name) ?? 'hook';
            const output = readNonEmptyString(msg.output);
            const stdout = readNonEmptyString(msg.stdout);
            const stderr = readNonEmptyString(msg.stderr);
            const detail = output ?? stdout ?? stderr;
            if (detail) {
              await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
                toolCallId: hookId,
                title: `Hook: ${hookName}`,
                kind: 'hook',
                output: detail,
              });
            }
            continue;
          }
          if (subtype === 'hook_response') {
            const hookId = readNonEmptyString(msg.hook_id) ?? `hook-${turn.turnId}-${Date.now()}`;
            const hookName = readNonEmptyString(msg.hook_name) ?? 'hook';
            const outcome = readNonEmptyString(msg.outcome) ?? 'completed';
            const output = readNonEmptyString(msg.output);
            const stderr = readNonEmptyString(msg.stderr);
            const summary = output ?? stderr ?? `Outcome: ${outcome}`;
            await this.deps.appendTurnEvent(turn.turnId, 'tool.completed', {
              toolCallId: hookId,
              title: `Hook: ${hookName}`,
              kind: 'hook',
              summary,
              outcome,
            });
            continue;
          }
          if (subtype === 'status') {
            const status = readNonEmptyString(msg.status);
            if (status) {
              await this.deps.appendTurnEvent(turn.turnId, 'reasoning.delta', {
                delta: `[status] ${status}\n`,
              });
            }
            continue;
          }
          if (subtype === 'api_retry') {
            const attempt = typeof msg.attempt === 'number' ? msg.attempt : null;
            const maxRetries = typeof msg.max_retries === 'number' ? msg.max_retries : null;
            const delayMs = typeof msg.retry_delay_ms === 'number' ? msg.retry_delay_ms : null;
            const status = typeof msg.error_status === 'number' ? String(msg.error_status) : 'connection';
            const retryText = `API retry (${status})${attempt && maxRetries ? ` ${attempt}/${maxRetries}` : ''}${delayMs ? ` in ${delayMs}ms` : ''}`;
            await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
              toolCallId: `api-retry-${turn.turnId}`,
              title: 'API Retry',
              kind: 'system',
              output: retryText,
            });
            continue;
          }
          if (subtype === 'init') {
            const model = readNonEmptyString(msg.model);
            const tools = Array.isArray(msg.tools) ? msg.tools.length : null;
            await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
              toolCallId: `session-init-${turn.turnId}`,
              title: 'Session Init',
              kind: 'system',
              output: `Initialized${model ? ` model=${model}` : ''}${tools === null ? '' : ` tools=${tools}`}`,
            });
            continue;
          }
        }

        if (msg.type === 'rate_limit_event') {
          const info =
            msg.rate_limit_info && typeof msg.rate_limit_info === 'object' && !Array.isArray(msg.rate_limit_info)
              ? (msg.rate_limit_info as Record<string, unknown>)
              : null;
          const status = info ? readNonEmptyString(info.status) : null;
          const utilization = info && typeof info.utilization === 'number' ? info.utilization : null;
          const text = `Rate limit${status ? `: ${status}` : ''}${utilization === null ? '' : ` (${Math.round(utilization * 100)}%)`}`;
          await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
            toolCallId: `rate-limit-${turn.turnId}`,
            title: 'Rate Limit',
            kind: 'system',
            output: text,
          });
          continue;
        }

        if (msg.type === 'assistant') {
          const startedTools = extractToolStartsFromAssistantMessage(msg);
          for (const startedTool of startedTools) {
            await this.emitToolStarted(turn.turnId, startedTool);
          }
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
            const errors = Array.isArray(msg.errors)
              ? msg.errors.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item.length > 0)
              : [];
            if (errors.length > 0) {
              await this.deps.appendTurnEvent(turn.turnId, 'tool.output', {
                toolCallId: `result-${turn.turnId}`,
                title: 'Execution Error',
                kind: 'system',
                output: errors.join('\n'),
              });
            }
            await this.deps.failTurn(turn.turnId, errorText);
          } else {
            const content = turn.assistantText || readNonEmptyString(msg.result) || '';
            const usage = msg.usage;
            const usagePayload =
              usage && typeof usage === 'object' && !Array.isArray(usage)
                ? {
                    usage: usage as Record<string, unknown>,
                  }
                : {};
            await this.deps.finalizeTurn(turn.turnId, 'turn.completed', { content, ...usagePayload });
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
      this.startedToolCallsByTurn.delete(input.turnId);
      this.aggregatedDiffsByTurn.delete(input.turnId);
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
    this.startedToolCallsByTurn.delete(turnId);
    this.aggregatedDiffsByTurn.delete(turnId);
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

  private async emitToolStarted(
    turnId: string,
    input: { toolCallId: string; title: string; kind: string; input?: Record<string, unknown> | null },
  ): Promise<void> {
    const toolCallId = input.toolCallId.trim();
    if (!toolCallId) {
      return;
    }
    const startedSet = this.startedToolCallsByTurn.get(turnId) ?? new Set<string>();
    if (startedSet.has(toolCallId)) {
      return;
    }
    startedSet.add(toolCallId);
    this.startedToolCallsByTurn.set(turnId, startedSet);
    await this.deps.appendTurnEvent(turnId, 'tool.started', {
      toolCallId,
      title: input.title || 'tool',
      kind: input.kind || 'tool',
      ...(input.input ? { input: input.input } : {}),
    });
  }

  private buildClaudeHooks(turnId: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    return {
      PostToolUse: [
        {
          hooks: [
            async (hookInput) => {
              if (!hookInput || typeof hookInput !== 'object' || Array.isArray(hookInput)) {
                return { continue: true };
              }
              const input = hookInput as Record<string, unknown>;
              const hookEventName = readNonEmptyString(input.hook_event_name);
              if (hookEventName !== 'PostToolUse') {
                return { continue: true };
              }
              const toolName = readNonEmptyString(input.tool_name) ?? 'tool';
              const toolUseId = readNonEmptyString(input.tool_use_id) ?? `post-tool-${turnId}-${Date.now()}`;
              const toolInput =
                input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input)
                  ? (input.tool_input as Record<string, unknown>)
                  : null;
              const toolResponse = input.tool_response;

              await this.emitToolStarted(turnId, {
                toolCallId: toolUseId,
                title: toolName,
                kind: toolName,
                input: toolInput,
              });

              if (toolName === 'Bash') {
                const output = extractBashOutput(toolResponse);
                if (output) {
                  await this.deps.appendTurnEvent(turnId, 'tool.output', {
                    toolCallId: toolUseId,
                    title: toolName,
                    kind: toolName,
                    output,
                  });
                }
              }

              if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
                const diffPayload = buildDiffPayloadFromTool(toolName, toolInput, toolResponse);
                if (diffPayload && diffPayload.files.length > 0 && diffPayload.byFile.length > 0) {
                  const merged = this.mergeTurnDiffPayload(turnId, diffPayload);
                  await this.deps.appendTurnEvent(turnId, 'diff.updated', merged);
                }
              }

              await this.deps.appendTurnEvent(turnId, 'tool.completed', {
                toolCallId: toolUseId,
                title: toolName,
                kind: toolName,
                summary: 'completed',
              });
              return { continue: true };
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            async (hookInput) => {
              if (!hookInput || typeof hookInput !== 'object' || Array.isArray(hookInput)) {
                return { continue: true };
              }
              const input = hookInput as Record<string, unknown>;
              const hookEventName = readNonEmptyString(input.hook_event_name);
              if (hookEventName !== 'PostToolUseFailure') {
                return { continue: true };
              }
              const toolName = readNonEmptyString(input.tool_name) ?? 'tool';
              const toolUseId = readNonEmptyString(input.tool_use_id) ?? `post-tool-failure-${turnId}-${Date.now()}`;
              const error = readNonEmptyString(input.error) ?? 'tool failed';

              await this.emitToolStarted(turnId, {
                toolCallId: toolUseId,
                title: toolName,
                kind: toolName,
              });
              await this.deps.appendTurnEvent(turnId, 'tool.output', {
                toolCallId: toolUseId,
                title: toolName,
                kind: toolName,
                output: error,
              });
              await this.deps.appendTurnEvent(turnId, 'tool.completed', {
                toolCallId: toolUseId,
                title: toolName,
                kind: toolName,
                summary: 'failed',
              });
              return { continue: true };
            },
          ],
        },
      ],
    };
  }

  private mergeTurnDiffPayload(turnId: string, payload: ToolDiffPayload): Record<string, unknown> {
    const filesByPath = this.aggregatedDiffsByTurn.get(turnId) ?? new Map<string, AggregatedDiffFile>();
    if (!this.aggregatedDiffsByTurn.has(turnId)) {
      this.aggregatedDiffsByTurn.set(turnId, filesByPath);
    }

    for (const file of payload.byFile) {
      const existing = filesByPath.get(file.path);
      if (existing) {
        existing.structuredPatch.push(...file.structuredPatch);
        if (file.oldPath) {
          existing.oldPath = file.oldPath;
        }
        if (file.newPath) {
          existing.newPath = file.newPath;
        }
      } else {
        filesByPath.set(file.path, {
          path: file.path,
          oldPath: file.oldPath,
          newPath: file.newPath,
          structuredPatch: file.structuredPatch.map((hunk) => ({ ...hunk, lines: [...hunk.lines] })),
        });
      }
    }

    const orderedFiles = Array.from(filesByPath.values());
    const unifiedDiff = renderUnifiedDiffByFiles(orderedFiles);
    return {
      files: orderedFiles.map((file) => file.path),
      byFile: orderedFiles.map((file) => ({
        path: file.path,
        oldPath: file.oldPath,
        newPath: file.newPath,
        structuredPatch: file.structuredPatch,
      })),
      unifiedDiff,
    };
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

type StructuredPatchEntry = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

type ToolDiffFile = {
  path: string;
  oldPath: string;
  newPath: string;
  structuredPatch: StructuredPatchEntry[];
};

type ToolDiffPayload = {
  files: string[];
  byFile: ToolDiffFile[];
};

type AggregatedDiffFile = {
  path: string;
  oldPath: string;
  newPath: string;
  structuredPatch: StructuredPatchEntry[];
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

function extractPartialThinkingText(message: Record<string, unknown>): string {
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
  const thinking = readNonEmptyString(deltaRecord.thinking);
  if (thinking) {
    return thinking;
  }
  return deltaRecord.type === 'thinking_delta' ? readNonEmptyString(deltaRecord.text) ?? '' : '';
}

function extractToolStartFromStreamEvent(
  message: Record<string, unknown>,
): { toolCallId: string; title: string; kind: string; input?: Record<string, unknown> | null } | null {
  const event = message.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return null;
  }
  const record = event as Record<string, unknown>;
  if (record.type !== 'content_block_start') {
    return null;
  }
  const block = record.content_block;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return null;
  }
  const blockRecord = block as Record<string, unknown>;
  if (blockRecord.type !== 'tool_use') {
    return null;
  }
  const toolCallId = readNonEmptyString(blockRecord.id);
  const name = readNonEmptyString(blockRecord.name);
  if (!toolCallId || !name) {
    return null;
  }
  const toolInput =
    blockRecord.input && typeof blockRecord.input === 'object' && !Array.isArray(blockRecord.input)
      ? (blockRecord.input as Record<string, unknown>)
      : null;
  return {
    toolCallId,
    title: name,
    kind: name,
    input: toolInput,
  };
}

function extractToolStartsFromAssistantMessage(
  message: Record<string, unknown>,
): Array<{ toolCallId: string; title: string; kind: string; input?: Record<string, unknown> | null }> {
  const payload = message.message;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  const content = (payload as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return [];
  }
  const startedTools: Array<{ toolCallId: string; title: string; kind: string; input?: Record<string, unknown> | null }> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      continue;
    }
    const blockRecord = block as Record<string, unknown>;
    if (blockRecord.type !== 'tool_use') {
      continue;
    }
    const toolCallId = readNonEmptyString(blockRecord.id);
    const name = readNonEmptyString(blockRecord.name);
    if (!toolCallId || !name) {
      continue;
    }
    const toolInput =
      blockRecord.input && typeof blockRecord.input === 'object' && !Array.isArray(blockRecord.input)
        ? (blockRecord.input as Record<string, unknown>)
        : null;
    startedTools.push({
      toolCallId,
      title: name,
      kind: name,
      input: toolInput,
    });
  }
  return startedTools;
}

function extractBashOutput(toolResponse: unknown): string | null {
  if (!toolResponse || typeof toolResponse !== 'object' || Array.isArray(toolResponse)) {
    return null;
  }
  const response = toolResponse as Record<string, unknown>;
  const stdout = readNonEmptyString(response.stdout);
  const stderr = readNonEmptyString(response.stderr);
  const combined = [stdout, stderr].filter((item): item is string => !!item).join('\n');
  if (combined.length > 0) {
    return combined;
  }
  return readNonEmptyString(response.output) ?? null;
}

function buildDiffPayloadFromTool(
  toolName: string,
  toolInput: Record<string, unknown> | null,
  toolResponse: unknown,
): ToolDiffPayload | null {
  const inputPath = readPathFromInput(toolInput);
  const fromResponse = buildDiffFilesFromResponse(toolResponse, inputPath);
  if (fromResponse.length > 0) {
    return {
      files: fromResponse.map((item) => item.path),
      byFile: fromResponse,
    };
  }

  const path = inputPath;
  if (!path) {
    return null;
  }

  if (toolName === 'Write' && toolInput) {
    const content = typeof toolInput.content === 'string' ? toolInput.content : '';
    if (content.length > 0) {
      return {
        files: [path],
        byFile: [
          {
            path,
            oldPath: path,
            newPath: path,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: countPatchLines(content),
                lines: prefixPatchLines(content, '+'),
              },
            ],
          },
        ],
      };
    }
  }

  if (toolName === 'Edit' && toolInput) {
    const oldString = typeof toolInput.old_string === 'string' ? toolInput.old_string : '';
    const newString = typeof toolInput.new_string === 'string' ? toolInput.new_string : '';
    if (oldString.length > 0 || newString.length > 0) {
      return {
        files: [path],
        byFile: [
          {
            path,
            oldPath: path,
            newPath: path,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: countPatchLines(oldString),
                newStart: 1,
                newLines: countPatchLines(newString),
                lines: [...prefixPatchLines(oldString, '-'), ...prefixPatchLines(newString, '+')],
              },
            ],
          },
        ],
      };
    }
  }

  if (toolName === 'MultiEdit' && toolInput) {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    if (edits.length > 0) {
      const hunks = edits
        .map((edit) => {
          if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
            return null;
          }
          const record = edit as Record<string, unknown>;
          const oldString = typeof record.old_string === 'string' ? record.old_string : '';
          const newString = typeof record.new_string === 'string' ? record.new_string : '';
          return {
            oldStart: 1,
            oldLines: countPatchLines(oldString),
            newStart: 1,
            newLines: countPatchLines(newString),
            lines: [...prefixPatchLines(oldString, '-'), ...prefixPatchLines(newString, '+')],
          };
        })
        .filter((hunk): hunk is StructuredPatchEntry => !!hunk && hunk.lines.length > 0);
      if (hunks.length > 0) {
        return {
          files: [path],
          byFile: [
            {
              path,
              oldPath: path,
              newPath: path,
              structuredPatch: hunks,
            },
          ],
        };
      }
    }
  }
  void toolResponse;
  return null;
}

function buildDiffFilesFromResponse(toolResponse: unknown, fallbackPath: string | null): ToolDiffFile[] {
  const records = collectObjectRecords(toolResponse);
  if (records.length === 0) {
    return [];
  }
  const byPath = new Map<string, ToolDiffFile>();

  for (const record of records) {
    const path =
      readPathFromRecord(record, ['filePath', 'file_path', 'path']) ??
      readPathFromRecord(record, ['targetFilePath', 'target_file_path']) ??
      fallbackPath;
    if (!path) {
      continue;
    }
    const structuredPatch = readStructuredPatch(record);
    if (structuredPatch.length === 0) {
      continue;
    }
    const oldPath = readPathFromRecord(record, ['oldPath', 'old_path']) ?? path;
    const newPath = readPathFromRecord(record, ['newPath', 'new_path']) ?? path;
    const existing = byPath.get(path);
    if (existing) {
      existing.structuredPatch.push(...structuredPatch);
      existing.oldPath = oldPath;
      existing.newPath = newPath;
      continue;
    }
    byPath.set(path, {
      path,
      oldPath,
      newPath,
      structuredPatch,
    });
  }

  return Array.from(byPath.values());
}

function collectObjectRecords(value: unknown): Record<string, unknown>[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .flatMap((item) => [item, ...collectNestedRecordCandidates(item)]);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return [record, ...collectNestedRecordCandidates(record)];
  }
  return [];
}

function collectNestedRecordCandidates(record: Record<string, unknown>): Record<string, unknown>[] {
  const nested: Record<string, unknown>[] = [];
  const keys = ['result', 'response', 'data', 'output'];
  for (const key of keys) {
    const candidate = record[key];
    if (!candidate) {
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          nested.push(entry as Record<string, unknown>);
        }
      }
      continue;
    }
    if (typeof candidate === 'object' && !Array.isArray(candidate)) {
      nested.push(candidate as Record<string, unknown>);
    }
  }
  return nested;
}

function readPathFromInput(toolInput: Record<string, unknown> | null): string | null {
  if (!toolInput) {
    return null;
  }
  return (
    readPathFromRecord(toolInput, ['filePath', 'file_path', 'path']) ??
    readPathFromRecord(toolInput, ['targetFilePath', 'target_file_path'])
  );
}

function readPathFromRecord(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const path = readNonEmptyString(record[key]);
    if (path) {
      return path;
    }
  }
  return null;
}

function readStructuredPatch(record: Record<string, unknown>): StructuredPatchEntry[] {
  const rawPatch = record.structuredPatch ?? record.structured_patch;
  if (!Array.isArray(rawPatch)) {
    return [];
  }
  const entries: StructuredPatchEntry[] = [];
  for (const item of rawPatch) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const entryRecord = item as Record<string, unknown>;
    const oldStart = readPatchNumber(entryRecord.oldStart ?? entryRecord.old_start);
    const oldLines = readPatchNumber(entryRecord.oldLines ?? entryRecord.old_lines);
    const newStart = readPatchNumber(entryRecord.newStart ?? entryRecord.new_start);
    const newLines = readPatchNumber(entryRecord.newLines ?? entryRecord.new_lines);
    const lines = Array.isArray(entryRecord.lines)
      ? entryRecord.lines
          .map((line) => (typeof line === 'string' ? line : ''))
          .filter((line) => line.length > 0)
      : [];
    if (oldStart === null || oldLines === null || newStart === null || newLines === null || lines.length === 0) {
      continue;
    }
    entries.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines,
    });
  }
  return entries;
}

function readPatchNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value);
}

function countPatchLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split('\n').length;
}

function prefixPatchLines(content: string, prefix: '+' | '-'): string[] {
  if (content.length === 0) {
    return [];
  }
  return content.split('\n').map((line) => `${prefix}${line}`);
}

function renderUnifiedDiffByFiles(files: AggregatedDiffFile[]): string {
  const chunks: string[] = [];
  for (const file of files) {
    const oldLabel = normalizeGitDiffPath(file.oldPath, 'a');
    const newLabel = normalizeGitDiffPath(file.newPath, 'b');
    chunks.push(`diff --git ${oldLabel} ${newLabel}`);
    chunks.push(`--- ${oldLabel}`);
    chunks.push(`+++ ${newLabel}`);
    for (const hunk of file.structuredPatch) {
      chunks.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      chunks.push(...hunk.lines);
    }
    chunks.push('');
  }
  while (chunks.length > 0 && chunks[chunks.length - 1] === '') {
    chunks.pop();
  }
  return chunks.join('\n');
}

function normalizeGitDiffPath(path: string, side: 'a' | 'b'): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    return `${side}/unknown`;
  }
  return `${side}/${normalized}`;
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
