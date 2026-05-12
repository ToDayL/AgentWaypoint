import { Injectable } from '@nestjs/common';
import { BotMessage } from '@prisma/client';
import {
  AvailableModel,
  AvailableSkill,
  WorkspaceFileContentResult,
  WorkspaceFileResult,
  WorkspaceTreeEntry,
  WorkspaceUploadResult,
} from '../../../runner/runner.types';
import { CreateSessionBody, ForkSessionBody, UpdateSessionBody } from '../../../sessions/sessions.schemas';
import { CreateTurnBody, ResolveTurnApprovalBody, SteerTurnBody } from '../../../turns/turns.schemas';
import { GatewayApprovalBody, GatewayInboundBody } from '../../gateway.schemas';
import { ChannelPlugin, ChannelPluginContext, PluginBindingPolicy, PluginDispatchContext } from '../plugin.types';

type WebDispatchedEvent = {
  seq: number;
  type: string;
  payload: unknown;
  turnId: string;
  createdAt: Date;
};

type SessionDispatchedBuffer = {
  turnId: string;
  events: WebDispatchedEvent[];
};

const MAX_SESSION_BUFFER_EVENTS = 500;

@Injectable()
export class WebPlugin implements ChannelPlugin {
  readonly provider = 'web';
  private context: ChannelPluginContext | null = null;
  private readonly bindingPolicy: PluginBindingPolicy = {
    bindAllSessions: true,
  };
  private readonly dispatchedEventsBySession = new Map<string, SessionDispatchedBuffer>();
  private fallbackSeq = 0;

  async boot(context: ChannelPluginContext): Promise<void> {
    this.context = context;
  }

  async shutdown(): Promise<void> {
    this.context = null;
    return;
  }

  getBindingPolicy(): PluginBindingPolicy {
    return this.bindingPolicy;
  }

  async sendMessage(message: BotMessage, _context: PluginDispatchContext): Promise<{ providerMessageId: string }> {
    this.captureDispatchedEvent(message);
    const providerMessageId = `web-plugin-${message.id}`;
    return { providerMessageId };
  }

  async ingestInbound(input: GatewayInboundBody): Promise<{
    accepted: true;
    unifiedIdentifier: string;
    messageId: string;
    turnId: string;
  }> {
    const context = this.requireContext();
    return context.ingestInbound(input);
  }

  async resolveApproval(input: GatewayApprovalBody): Promise<{ turnId: string; status: string; accepted: true }> {
    const context = this.requireContext();
    return context.resolveApproval(input);
  }

  async listProjectsForUser(userId: string): Promise<unknown> {
    return this.requireContext().listProjectsForUser(userId);
  }

  async createProjectForUser(
    userId: string,
    input: {
      name: string;
      repoPath?: string;
      backend?: string;
      backendConfig?: Record<string, unknown>;
    },
  ): Promise<unknown> {
    return this.requireContext().createProjectForUser(userId, input);
  }

  async getProjectForUser(userId: string, projectId: string): Promise<unknown> {
    return this.requireContext().getProjectForUser(userId, projectId);
  }

  async updateProjectForUser(
    userId: string,
    projectId: string,
    input: {
      name?: string;
      repoPath?: string | null;
      backend?: string;
      backendConfig?: Record<string, unknown>;
    },
  ): Promise<unknown> {
    return this.requireContext().updateProjectForUser(userId, projectId, input);
  }

  async deleteProjectForUser(userId: string, projectId: string): Promise<void> {
    await this.requireContext().deleteProjectForUser(userId, projectId);
  }

  async listSessionsForProject(userId: string, projectId: string): Promise<unknown> {
    return this.requireContext().listSessionsForProject(userId, projectId);
  }

  async createSessionForProject(userId: string, projectId: string, input: CreateSessionBody): Promise<unknown> {
    return this.requireContext().createSessionForProject(userId, projectId, input);
  }

  async updateSessionForUser(userId: string, sessionId: string, input: UpdateSessionBody): Promise<unknown> {
    return this.requireContext().updateSessionForUser(userId, sessionId, input);
  }

  async getSessionHistoryForUser(userId: string, sessionId: string): Promise<unknown> {
    return this.requireContext().getSessionHistoryForUser(userId, sessionId);
  }

  async deleteSessionForUser(userId: string, sessionId: string): Promise<void> {
    await this.requireContext().deleteSessionForUser(userId, sessionId);
  }

  async forkSessionForUser(userId: string, sessionId: string, input: ForkSessionBody): Promise<unknown> {
    return this.requireContext().forkSessionForUser(userId, sessionId, input);
  }

  async compactSessionForUser(userId: string, sessionId: string): Promise<unknown> {
    return this.requireContext().compactSessionForUser(userId, sessionId);
  }

  async createTurnForSession(userId: string, sessionId: string, input: CreateTurnBody): Promise<unknown> {
    return this.requireContext().createTurnForSession(userId, sessionId, input);
  }

  async getTurnStatusForUser(userId: string, turnId: string): Promise<unknown> {
    return this.requireContext().getTurnStatusForUser(userId, turnId);
  }

  async cancelTurnForUser(userId: string, turnId: string): Promise<unknown> {
    return this.requireContext().cancelTurnForUser(userId, turnId);
  }

  async steerTurnForUser(userId: string, turnId: string, input: SteerTurnBody): Promise<unknown> {
    return this.requireContext().steerTurnForUser(userId, turnId, input);
  }

  async resolveTurnApprovalForUser(userId: string, turnId: string, input: ResolveTurnApprovalBody): Promise<unknown> {
    return this.requireContext().resolveTurnApprovalForUser(userId, turnId, input);
  }

  async controlApprovalTimerForUser(
    userId: string,
    turnId: string,
    input: { approvalId: string; action: 'pause' | 'resume' },
  ): Promise<unknown> {
    return this.requireContext().controlApprovalTimerForUser(userId, turnId, input);
  }

  async listModels(input: { backend?: string | null }): Promise<AvailableModel[]> {
    return this.requireContext().listModels(input);
  }

  async listSkills(input: { cwd?: string | null; backend?: string | null }): Promise<AvailableSkill[]> {
    return this.requireContext().listSkills(input);
  }

  async suggestWorkspaceDirectories(input: { prefix: string; limit?: number }): Promise<string[]> {
    return this.requireContext().suggestWorkspaceDirectories(input);
  }

  async listWorkspaceTree(input: { path: string; limit?: number; includeHidden?: boolean }): Promise<WorkspaceTreeEntry[]> {
    return this.requireContext().listWorkspaceTree(input);
  }

  async readWorkspaceFile(input: { path: string; maxBytes?: number }): Promise<WorkspaceFileResult> {
    return this.requireContext().readWorkspaceFile(input);
  }

  async readWorkspaceFileContent(input: { path: string }): Promise<WorkspaceFileContentResult> {
    return this.requireContext().readWorkspaceFileContent(input);
  }

  async uploadWorkspaceFile(input: {
    body: NodeJS.ReadableStream;
    contentType: string;
    contentLength?: string | null;
  }): Promise<WorkspaceUploadResult> {
    return this.requireContext().uploadWorkspaceFile(input);
  }

  async getTurnForUser(userId: string, turnId: string): Promise<{ status: string; sessionId: string }> {
    return this.requireContext().getTurnForUser(userId, turnId);
  }

  async getEventsForTurn(
    userId: string,
    turnId: string,
    sinceSeq: number,
  ): Promise<Array<{ seq: number; type: string; payload: unknown; turnId: string; createdAt: Date }>> {
    return this.requireContext().getEventsForTurn(userId, turnId, sinceSeq);
  }

  getDispatchedEventsForSessionTurn(
    sessionId: string,
    turnId: string,
    sinceSeq: number,
  ): Array<{ seq: number; type: string; payload: unknown; turnId: string; createdAt: Date }> {
    const buffer = this.dispatchedEventsBySession.get(sessionId);
    if (!buffer || buffer.turnId !== turnId) {
      return [];
    }
    return buffer.events.filter((event) => event.seq > sinceSeq);
  }

  private captureDispatchedEvent(message: BotMessage): void {
    if (!message.payloadRaw || typeof message.payloadRaw !== 'object' || Array.isArray(message.payloadRaw)) {
      return;
    }
    const raw = message.payloadRaw as Record<string, unknown>;
    const kind = message.kind;
    const sessionId = message.sessionId;
    if (!sessionId) {
      return;
    }
    if (kind === 'event') {
      const turnId = readString(raw.turnId);
      const type = readString(raw.type);
      if (!turnId || !type) {
        return;
      }
      const seq = readNumber(raw.seq) ?? this.nextFallbackSeq();
      const payload = raw.payload ?? {};
      const createdAt = readDate(raw.createdAt) ?? new Date();
      this.pushDispatchedEvent(turnId, {
        seq,
        type,
        payload,
        turnId,
        createdAt,
      }, sessionId);
      return;
    }
  }

  private pushDispatchedEvent(turnId: string, event: WebDispatchedEvent, sessionId: string): void {
    const existing = this.dispatchedEventsBySession.get(sessionId);
    if (!existing || existing.turnId !== turnId) {
      this.dispatchedEventsBySession.set(sessionId, {
        turnId,
        events: [event],
      });
      return;
    }
    existing.events.push(event);
    if (existing.events.length > MAX_SESSION_BUFFER_EVENTS) {
      const overflow = existing.events.length - MAX_SESSION_BUFFER_EVENTS;
      existing.events.splice(0, overflow);
    }
  }

  private nextFallbackSeq(): number {
    this.fallbackSeq += 1;
    return this.fallbackSeq;
  }

  private requireContext(): ChannelPluginContext {
    if (!this.context) {
      throw new Error('Web plugin has not been booted');
    }
    return this.context;
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
