import { BotMessage } from '@prisma/client';
import { CreateSessionBody, ForkSessionBody, UpdateSessionBody } from '../../sessions/sessions.schemas';
import { CommandOutputQuery, CreateTurnBody, ResolveTurnApprovalBody, SteerTurnBody } from '../../turns/turns.schemas';
import {
  AvailableModel,
  AvailableSkill,
  WorkspaceFileContentResult,
  WorkspaceFileResult,
  WorkspaceTreeEntry,
  WorkspaceUploadResult,
} from '../../runner/runner.types';
import { GatewayApprovalBody, GatewayInboundBody } from '../gateway.schemas';

export type PluginSendResult = {
  providerMessageId?: string;
};

export type PluginDispatchContext = {
  isTriggeredByYou: boolean;
  unifiedIdentifier: string | null;
  triggerIntegrationId: string | null;
  triggerProvider: string | null;
  bindingIntegrationId: string | null;
  bindingGuid: string | null;
  bindingChannel: string | null;
  bindingThread: string | null;
};

export type PluginBindingPolicy = {
  bindAllSessions: boolean;
};

export interface ChannelPluginContext {
  publishUserMessageForSession(input: {
    projectId: string;
    sessionId: string;
    content: string;
    triggerIdentifier: string;
    triggerProvider?: string;
    triggerIntegrationId?: string;
    triggerMessageId?: string | null;
    sourceBinding?: {
      provider?: string | null;
      integrationId?: string | null;
      guid?: string | null;
      channel?: string | null;
      thread?: string | null;
    } | null;
  }): Promise<void>;
  ingestInbound(input: GatewayInboundBody): Promise<{
    accepted: true;
    unifiedIdentifier: string;
    messageId: string;
    turnId: string;
  }>;
  resolveApproval(input: GatewayApprovalBody): Promise<{ turnId: string; status: string; accepted: true }>;
  listProjectsForUser(userId: string): Promise<unknown>;
  createProjectForUser(
    userId: string,
    input: {
      name: string;
      repoPath?: string;
      backend?: string;
      backendConfig?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  getProjectForUser(userId: string, projectId: string): Promise<unknown>;
  updateProjectForUser(
    userId: string,
    projectId: string,
    input: {
      name?: string;
      repoPath?: string | null;
      backend?: string;
      backendConfig?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  deleteProjectForUser(userId: string, projectId: string): Promise<void>;
  listSessionsForProject(userId: string, projectId: string): Promise<unknown>;
  createSessionForProject(userId: string, projectId: string, input: CreateSessionBody): Promise<unknown>;
  updateSessionForUser(userId: string, sessionId: string, input: UpdateSessionBody): Promise<unknown>;
  getSessionHistoryForUser(userId: string, sessionId: string): Promise<unknown>;
  deleteSessionForUser(userId: string, sessionId: string): Promise<void>;
  forkSessionForUser(userId: string, sessionId: string, input: ForkSessionBody): Promise<unknown>;
  compactSessionForUser(userId: string, sessionId: string): Promise<unknown>;
  createTurnForSession(userId: string, sessionId: string, input: CreateTurnBody): Promise<unknown>;
  getTurnStatusForUser(userId: string, turnId: string): Promise<unknown>;
  cancelTurnForUser(userId: string, turnId: string): Promise<unknown>;
  steerTurnForUser(userId: string, turnId: string, input: SteerTurnBody): Promise<unknown>;
  resolveTurnApprovalForUser(userId: string, turnId: string, input: ResolveTurnApprovalBody): Promise<unknown>;
  controlApprovalTimerForUser(
    userId: string,
    turnId: string,
    input: { approvalId: string; action: 'pause' | 'resume' },
  ): Promise<unknown>;
  updateIntegrationPluginConfigForUser(
    userId: string,
    integrationId: string,
    pluginConfig: Record<string, unknown>,
  ): Promise<void>;
  listModels(input: { backend?: string | null }): Promise<AvailableModel[]>;
  listSkills(input: { cwd?: string | null; backend?: string | null }): Promise<AvailableSkill[]>;
  suggestWorkspaceDirectories(input: { prefix: string; limit?: number }): Promise<string[]>;
  listWorkspaceTree(input: { path: string; limit?: number; includeHidden?: boolean }): Promise<WorkspaceTreeEntry[]>;
  readWorkspaceFile(input: { path: string; maxBytes?: number }): Promise<WorkspaceFileResult>;
  readWorkspaceFileContent(input: { path: string }): Promise<WorkspaceFileContentResult>;
  uploadWorkspaceFile(input: {
    body: NodeJS.ReadableStream;
    contentType: string;
    contentLength?: string | null;
  }): Promise<WorkspaceUploadResult>;
  getTurnForUser(
    userId: string,
    turnId: string,
  ): Promise<{
    status: string;
    sessionId: string;
    contextRemainingRatio: number | null;
    contextUpdatedAt: Date | null;
  }>;
  getEventsForTurn(
    userId: string,
    turnId: string,
    sinceSeq: number,
    limit?: number,
  ): Promise<Array<{ seq: number; type: string; payload: unknown; turnId: string; createdAt: Date }>>;
  getLatestDiffForTurn(userId: string, turnId: string): Promise<unknown>;
  getCommandOutputForTurn(userId: string, turnId: string, input: CommandOutputQuery): Promise<unknown>;
}

export interface ChannelPlugin {
  readonly provider: string;
  boot(context: ChannelPluginContext): Promise<void>;
  shutdown(): Promise<void>;
  getBindingPolicy(): PluginBindingPolicy;
  sendMessage(message: BotMessage, context: PluginDispatchContext): Promise<PluginSendResult>;
}
