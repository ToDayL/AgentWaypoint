import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BotMessage } from '@prisma/client';
import { ProjectsService } from '../projects/projects.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';
import { CreateSessionBody, ForkSessionBody } from '../sessions/sessions.schemas';
import { SessionsService } from '../sessions/sessions.service';
import { CreateTurnBody, ResolveTurnApprovalBody, SteerTurnBody } from '../turns/turns.schemas';
import { TurnsService } from '../turns/turns.service';
import { DiscordPlugin } from './plugins/discord/discord.plugin';
import { WebPlugin } from './plugins/web/web.plugin';
import { ChannelsService, SessionProviderBinding } from './channels.service';
import { ChannelPlugin, ChannelPluginContext, PluginDispatchContext } from './plugins/plugin.types';
import { QueueSignalService } from '../queue-signal/queue-signal.service';

const FALLBACK_DISPATCH_POLL_MS = 5_000;

@Injectable()
export class ChannelsGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelsGatewayService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeWake: (() => void) | null = null;
  private dispatching = false;
  private dispatchRequested = false;
  private readonly gatewayInstanceId = 'internal-channels-gateway';
  private readonly plugins: ChannelPlugin[];
  private readonly pluginContext: ChannelPluginContext = {
    ingestInbound: async (input) => this.channelsService.ingestInboundForGateway(input),
    resolveApproval: async (input) => this.channelsService.resolveApprovalForGateway(input),
    listProjectsForUser: async (userId) => this.projectsService.listForUser(userId),
    createProjectForUser: async (userId, input) =>
      this.projectsService.createForUser(userId, {
        name: input.name,
        repoPath: input.repoPath,
        backend: input.backend,
        backendConfig: input.backendConfig,
      }),
    getProjectForUser: async (userId, projectId) => this.projectsService.getByIdForUser(userId, projectId),
    updateProjectForUser: async (userId, projectId, input) =>
      this.projectsService.updateByIdForUser(
        userId,
        projectId,
        compactProjectUpdateInput({
          name: input.name,
          repoPath: input.repoPath,
          backend: input.backend,
          backendConfig: input.backendConfig,
        }),
      ),
    deleteProjectForUser: async (userId, projectId) => {
      await this.projectsService.deleteByIdForUser(userId, projectId);
    },
    listSessionsForProject: async (userId, projectId) => this.sessionsService.listForProject(userId, projectId),
    createSessionForProject: async (userId, projectId, input) => this.sessionsService.createForProject(userId, projectId, input),
    getSessionHistoryForUser: async (userId, sessionId) => this.sessionsService.getHistoryForSession(userId, sessionId),
    deleteSessionForUser: async (userId, sessionId) => {
      await this.sessionsService.deleteByIdForUser(userId, sessionId);
    },
    forkSessionForUser: async (userId, sessionId, input) => this.sessionsService.forkSessionForUser(userId, sessionId, input),
    compactSessionForUser: async (userId, sessionId) => this.sessionsService.compactSessionForUser(userId, sessionId),
    createTurnForSession: async (userId, sessionId, input) => this.turnsService.createTurnForSession(userId, sessionId, input),
    getTurnStatusForUser: async (userId, turnId) => this.turnsService.getTurnStatusForUser(userId, turnId),
    cancelTurnForUser: async (userId, turnId) => this.turnsService.cancelTurnForUser(userId, turnId),
    steerTurnForUser: async (userId, turnId, input) => this.turnsService.steerTurnForUser(userId, turnId, input),
    resolveTurnApprovalForUser: async (userId, turnId, input) =>
      this.turnsService.resolveTurnApprovalForUser(userId, turnId, input),
    updateIntegrationPluginConfigForUser: async (userId, integrationId, pluginConfig) => {
      await this.channelsService.updateIntegration(userId, integrationId, {
        pluginConfig,
      });
    },
    listModels: async (input) =>
      this.runnerAdapter.listModels({
        backend: input.backend ?? null,
      }),
    listSkills: async (input) =>
      this.runnerAdapter.listSkills({
        cwd: input.cwd ?? null,
        backend: input.backend ?? null,
      }),
    suggestWorkspaceDirectories: async (input) =>
      this.runnerAdapter.suggestWorkspaceDirectories({
        prefix: input.prefix,
        limit: input.limit,
      }),
    listWorkspaceTree: async (input) =>
      this.runnerAdapter.listWorkspaceTree({
        path: input.path,
        limit: input.limit,
        includeHidden: input.includeHidden,
      }),
    readWorkspaceFile: async (input) =>
      this.runnerAdapter.readWorkspaceFile({
        path: input.path,
        maxBytes: input.maxBytes,
      }),
    readWorkspaceFileContent: async (input) =>
      this.runnerAdapter.readWorkspaceFileContent({
        path: input.path,
      }),
    uploadWorkspaceFile: async (input) =>
      this.runnerAdapter.uploadWorkspaceFile({
        body: input.body,
        contentType: input.contentType,
        contentLength: input.contentLength,
      }),
    getTurnForUser: async (userId, turnId) => this.turnsService.getTurnForUser(userId, turnId),
    getEventsForTurn: async (userId, turnId, sinceSeq) => this.turnsService.getEventsForTurn(userId, turnId, sinceSeq),
  };

  constructor(
    @Inject(ChannelsService) private readonly channelsService: ChannelsService,
    @Inject(TurnsService) private readonly turnsService: TurnsService,
    @Inject(ProjectsService) private readonly projectsService: ProjectsService,
    @Inject(SessionsService) private readonly sessionsService: SessionsService,
    @Inject(WebPlugin) private readonly webPluginPlugin: WebPlugin,
    @Inject(DiscordPlugin) private readonly discordPlugin: DiscordPlugin,
    @Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter,
    @Inject(QueueSignalService) private readonly queueSignalService: QueueSignalService,
  ) {
    this.plugins = [this.webPluginPlugin, this.discordPlugin];
  }

  async onModuleInit(): Promise<void> {
    await Promise.all(this.plugins.map((plugin) => plugin.boot(this.pluginContext)));
    this.unsubscribeWake = this.queueSignalService.subscribeOutboundWake(() => {
      this.requestDispatch();
    });
    this.timer = setInterval(() => {
      this.requestDispatch();
    }, FALLBACK_DISPATCH_POLL_MS);
    this.requestDispatch();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.unsubscribeWake) {
      this.unsubscribeWake();
      this.unsubscribeWake = null;
    }
    await Promise.all(this.plugins.map((plugin) => plugin.shutdown()));
  }

  async getTurnForUser(userId: string, turnId: string) {
    return this.turnsService.getTurnForUser(userId, turnId);
  }

  async getEventsForTurn(userId: string, turnId: string, sinceSeq: number) {
    return this.turnsService.getEventsForTurn(userId, turnId, sinceSeq);
  }

  async listProjectsForUser(userId: string) {
    return this.projectsService.listForUser(userId);
  }

  async createProjectForUser(
    userId: string,
    input: {
      name: string;
      repoPath?: string;
      backend?: string;
      backendConfig?: Record<string, unknown>;
    },
  ) {
    return this.projectsService.createForUser(userId, {
      name: input.name,
      repoPath: input.repoPath,
      backend: input.backend,
      backendConfig: input.backendConfig,
    });
  }

  async getProjectForUser(userId: string, projectId: string) {
    return this.projectsService.getByIdForUser(userId, projectId);
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
  ) {
    return this.projectsService.updateByIdForUser(
      userId,
      projectId,
      compactProjectUpdateInput({
        name: input.name,
        repoPath: input.repoPath,
        backend: input.backend,
        backendConfig: input.backendConfig,
      }),
    );
  }

  async deleteProjectForUser(userId: string, projectId: string) {
    return this.projectsService.deleteByIdForUser(userId, projectId);
  }

  async listSessionsForProject(userId: string, projectId: string) {
    return this.sessionsService.listForProject(userId, projectId);
  }

  async createSessionForProject(userId: string, projectId: string, input: CreateSessionBody) {
    return this.sessionsService.createForProject(userId, projectId, input);
  }

  async getSessionHistoryForUser(userId: string, sessionId: string) {
    return this.sessionsService.getHistoryForSession(userId, sessionId);
  }

  async deleteSessionForUser(userId: string, sessionId: string) {
    return this.sessionsService.deleteByIdForUser(userId, sessionId);
  }

  async forkSessionForUser(userId: string, sessionId: string, input: ForkSessionBody) {
    return this.sessionsService.forkSessionForUser(userId, sessionId, input);
  }

  async compactSessionForUser(userId: string, sessionId: string) {
    return this.sessionsService.compactSessionForUser(userId, sessionId);
  }

  async createTurnForSession(userId: string, sessionId: string, input: CreateTurnBody) {
    return this.turnsService.createTurnForSession(userId, sessionId, input);
  }

  async getTurnStatusForUser(userId: string, turnId: string) {
    return this.turnsService.getTurnStatusForUser(userId, turnId);
  }

  async cancelTurnForUser(userId: string, turnId: string) {
    return this.turnsService.cancelTurnForUser(userId, turnId);
  }

  async steerTurnForUser(userId: string, turnId: string, input: SteerTurnBody) {
    return this.turnsService.steerTurnForUser(userId, turnId, input);
  }

  async resolveTurnApprovalForUser(userId: string, turnId: string, input: ResolveTurnApprovalBody) {
    return this.turnsService.resolveTurnApprovalForUser(userId, turnId, input);
  }

  private requestDispatch(): void {
    if (this.dispatching) {
      this.dispatchRequested = true;
      return;
    }
    void this.dispatchLoop();
  }

  private async dispatchLoop(): Promise<void> {
    if (this.dispatching) {
      return;
    }
    this.dispatching = true;
    try {
      while (true) {
        const queued = await this.channelsService.pullOutboundForGateway(20);
        if (queued.length === 0) {
          break;
        }
        for (const message of queued) {
          const deliveries = await this.findDeliveriesForMessage(message);
          if (deliveries.length === 0) {
            await this.markSentWithoutRecipients(message);
            continue;
          }
          await this.dispatchOne(message, deliveries);
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Dispatch loop failed: ${error.message}`, error.stack);
      } else {
        this.logger.error('Dispatch loop failed');
      }
    } finally {
      this.dispatching = false;
      if (this.dispatchRequested) {
        this.dispatchRequested = false;
        this.requestDispatch();
      }
    }
  }

  private async findDeliveriesForMessage(
    message: BotMessage,
  ): Promise<Array<{ plugin: ChannelPlugin; binding: SessionProviderBinding }>> {
    const explicitBindings = await this.channelsService.resolveBindingsForMessage({
      projectId: message.projectId,
      sessionId: message.sessionId,
    });
    const deliveries: Array<{ plugin: ChannelPlugin; binding: SessionProviderBinding }> = [];
    const seen = new Set<string>();
    for (const binding of explicitBindings) {
      const plugin = this.plugins.find((candidate) => candidate.provider === binding.provider);
      if (!plugin) {
        continue;
      }
      const key = `${plugin.provider}:${binding.integrationId}:${binding.guid ?? ''}:${binding.channel ?? ''}:${binding.thread ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deliveries.push({ plugin, binding });
    }

    // Plugin-level bind-all policy (e.g. web) guarantees delivery for all sessions.
    for (const plugin of this.plugins) {
      if (!plugin.getBindingPolicy().bindAllSessions) {
        continue;
      }
      const key = `${plugin.provider}::`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deliveries.push({
        plugin,
        binding: {
          provider: plugin.provider,
          integrationId: '',
          guid: null,
          channel: null,
          thread: null,
        },
      });
    }

    return deliveries;
  }

  private async dispatchOne(
    message: BotMessage,
    deliveries: Array<{ plugin: ChannelPlugin; binding: SessionProviderBinding }>,
  ): Promise<void> {
    try {
      const claimed = await this.channelsService.claimOutboundForGateway(message.id, {
        gatewayInstanceId: this.gatewayInstanceId,
        leaseSeconds: 30,
      });
      const sendResults = await Promise.all(
        deliveries.map(async ({ plugin, binding }) => {
          const dispatchContext = buildDispatchContextForPlugin(plugin, binding, claimed);
          return plugin.sendMessage(claimed, dispatchContext);
        }),
      );
      const providerMessageId = sendResults.find((result) => typeof result.providerMessageId === 'string')?.providerMessageId;
      await this.channelsService.reportOutboundResultForGateway(claimed.id, {
        status: 'sent',
        providerMessageId,
      });
    } catch (error: unknown) {
      if (isNotClaimableError(error)) {
        return;
      }
      await this.channelsService
        .reportOutboundResultForGateway(message.id, {
          status: 'failed',
          errorCode: 'PLUGIN_SEND_FAILED',
          errorMessage: error instanceof Error ? error.message : 'Send failed',
        })
        .catch(() => undefined);
    }
  }

  private async markSentWithoutRecipients(message: BotMessage): Promise<void> {
    try {
      const claimed = await this.channelsService.claimOutboundForGateway(message.id, {
        gatewayInstanceId: this.gatewayInstanceId,
        leaseSeconds: 30,
      });
      await this.channelsService.reportOutboundResultForGateway(claimed.id, {
        status: 'sent',
      });
    } catch (error: unknown) {
      if (isNotClaimableError(error)) {
        return;
      }
      await this.channelsService
        .reportOutboundResultForGateway(message.id, {
          status: 'failed',
          errorCode: 'GATEWAY_MARK_SENT_FAILED',
          errorMessage: error instanceof Error ? error.message : 'Mark sent failed',
        })
        .catch(() => undefined);
    }
  }
}

function isNotClaimableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes('Message is not claimable') || error.message.includes('Message not found');
}

function extractUnifiedIdentifier(message: BotMessage): string | null {
  if (!message.payloadRaw || typeof message.payloadRaw !== 'object' || Array.isArray(message.payloadRaw)) {
    return null;
  }
  const raw = (message.payloadRaw as Record<string, unknown>).triggerIdentifier;
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : null;
}

function buildDispatchContextForPlugin(
  plugin: ChannelPlugin,
  binding: SessionProviderBinding,
  message: BotMessage,
): PluginDispatchContext {
  const unifiedIdentifier = extractUnifiedIdentifier(message);
  const trigger = extractTriggerMetadata(message);
  const isTriggeredByYou =
    trigger.triggerProvider !== null &&
    trigger.triggerIntegrationId !== null &&
    trigger.triggerProvider === plugin.provider &&
    trigger.triggerIntegrationId === binding.integrationId;
  return {
    unifiedIdentifier,
    isTriggeredByYou,
    triggerIntegrationId: trigger.triggerIntegrationId,
    triggerProvider: trigger.triggerProvider,
    bindingIntegrationId: binding.integrationId || null,
    bindingGuid: binding.guid,
    bindingChannel: binding.channel,
    bindingThread: binding.thread,
  };
}

function extractTriggerMetadata(message: BotMessage): { triggerProvider: string | null; triggerIntegrationId: string | null } {
  if (!message.payloadRaw || typeof message.payloadRaw !== 'object' || Array.isArray(message.payloadRaw)) {
    return {
      triggerProvider: null,
      triggerIntegrationId: null,
    };
  }
  const raw = message.payloadRaw as Record<string, unknown>;
  const triggerProvider = normalizeOptionalString(raw.triggerProvider);
  const triggerIntegrationId = normalizeOptionalString(raw.triggerIntegrationId);
  return {
    triggerProvider,
    triggerIntegrationId,
  };
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function compactProjectUpdateInput(input: {
  name?: string;
  repoPath?: string | null;
  backend?: string;
  backendConfig?: Record<string, unknown>;
}): {
  name?: string;
  repoPath?: string | null;
  backend?: string;
  backendConfig?: Record<string, unknown>;
} {
  const next: {
    name?: string;
    repoPath?: string | null;
    backend?: string;
    backendConfig?: Record<string, unknown>;
  } = {};
  if (Object.prototype.hasOwnProperty.call(input, 'name') && typeof input.name !== 'undefined') {
    next.name = input.name;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'repoPath') && typeof input.repoPath !== 'undefined') {
    next.repoPath = input.repoPath;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'backend') && typeof input.backend !== 'undefined') {
    next.backend = input.backend;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'backendConfig') && typeof input.backendConfig !== 'undefined') {
    next.backendConfig = input.backendConfig;
  }
  return next;
}
