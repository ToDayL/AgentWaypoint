import { Inject, Injectable, Logger } from '@nestjs/common';
import { BotIntegration, BotMessage } from '@prisma/client';
import {
  ActionRowBuilder,
  type ApplicationCommandDataResolvable,
  ApplicationCommandOptionType,
  type AutocompleteInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Message,
  MessageType,
  Partials,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { GatewayDispatchPayload } from 'discord.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Dispatcher, ProxyAgent } from 'undici';
import { ChannelsService } from '../../channels.service';
import { ChannelPlugin, ChannelPluginContext, PluginBindingPolicy, PluginDispatchContext } from '../plugin.types';

type DiscordPluginConfig = {
  trigger?: {
    requireMention?: boolean;
    allowedUsers?: string[];
    allowedGuilds?: string[];
    allowedChannels?: string[];
    allowDM?: boolean;
  };
  message?: {
    sendStyle?: 'reply' | 'new_message';
    allowEveryoneMention?: boolean;
    ignoreBotMessages?: boolean;
    maxInboundLength?: number;
  };
  channelBindings?: Record<string, DiscordChannelBinding>;
  sessionBindings?: Record<string, DiscordSessionBinding | DiscordSessionBinding[]>;
  sessionIds?: string[];
};

type DiscordChannelBinding = {
  projectId: string;
  channel: string;
  guild?: string | null;
};

type DiscordSessionBinding = {
  channel: string;
  thread: string | null;
  guid?: string | null;
};

type DiscordRuntime = {
  integrationId: string;
  ownerUserId: string;
  client: Client;
  botToken: string;
  config: DiscordPluginConfig;
  stopped: boolean;
  processedMessageIds: Map<string, number>;
  processingMessageIds: Set<string>;
  approvalMenus: Map<string, DiscordApprovalMenuState>;
  triggerMessageActions: Map<string, 'watching' | 'active' | 'final'>;
  triggerMessageEffects: Map<string, 'watching' | 'active' | 'approval_pending' | 'final_success' | 'final_cancel' | 'final_error'>;
  steerTriggerByTurnId: Map<string, { channelId: string; messageId: string }>;
  typingByMessageKey: Map<string, string>;
  typingIntervals: Map<string, ReturnType<typeof setInterval>>;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  loginInFlight: boolean;
  recoveryInFlight: boolean;
};

type ApprovalDecision =
  | 'approve'
  | 'reject'
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow' | 'deny'; host: string } } };

type DiscordApprovalRequest = {
  turnId: string;
  approvalId: string;
  kind: string;
  payload: Record<string, unknown>;
};

type DiscordApprovalActionOption = {
  key: string;
  label: string;
  decision: ApprovalDecision;
  secondary?: boolean;
};

type DiscordApprovalMenuState = {
  turnId: string;
  approvalId: string;
  options: DiscordApprovalActionOption[];
  optionByKey: Map<string, DiscordApprovalActionOption>;
  expiresAt: number;
};

type DiscordInboundAttachment = {
  url: string;
  fileName: string;
  contentType: string | null;
  contentLength: number | null;
};

class DiscordRecoverableError extends Error {
  readonly integrationId: string | null;

  constructor(message: string, options?: { cause?: unknown; integrationId?: string | null }) {
    super(message, options);
    this.name = 'DiscordRecoverableError';
    this.integrationId = options?.integrationId ?? null;
  }
}

const DEFAULT_RECONCILE_INTERVAL_MS = 10_000;
const DISCORD_LOGIN_TIMEOUT_MS = 20_000;
const DISCORD_RECONNECT_BASE_DELAY_MS = 3_000;
const DISCORD_RECONNECT_MAX_DELAY_MS = 60_000;
const DISCORD_RECONNECT_MAX_ATTEMPTS = 5;
const RAW_FALLBACK_DELAY_MS = 500;
const PROCESSED_MESSAGE_TTL_MS = 5 * 60_000;
const PROCESSED_MESSAGE_MAX = 4_000;
const DISCORD_MESSAGE_MAX_LENGTH = 2_000;
const DISCORD_PROJECT_COMMAND = 'project';
const DISCORD_SESSION_COMMAND = 'session';
const DISCORD_CANCEL_COMMAND = 'cancel';
const DISCORD_FS_COMMAND = 'fs';
const EXECUTION_MODE_CHOICES = ['read-only', 'safe-write', 'yolo'] as const;
const AUTOCOMPLETE_MODEL_TIMEOUT_MS = 1_200;
const AUTOCOMPLETE_MODEL_CACHE_TTL_MS = 60_000;
const DISCORD_APPROVAL_SELECT_PREFIX = 'aw-approval';
const DISCORD_APPROVAL_MENU_TTL_MS = 24 * 60 * 60 * 1000;
const DISCORD_ACTION_EYE = '👀';
const DISCORD_ACTION_FLASH = '⚡';
const DISCORD_ACTION_CHECK = '✅';
const DISCORD_ACTION_CROSS = '❌';
const DISCORD_ACTION_ALERT = '❗';
const DISCORD_TYPING_HEARTBEAT_MS = 8_000;
const THREAD_STARTER_CONTEXT_MAX_LENGTH = 1_200;
const WORKSPACE_UPLOAD_MAX_SIZE_BYTES = 20 * 1024 * 1024;
const FS_TREE_SECOND_LEVEL_CONCURRENCY = 8;
const FS_TREE_SECOND_LEVEL_MAX_DIRS = 48;
let proxyConfigured = false;
let sharedProxyDispatcher: Dispatcher | null = null;
let httpsWebSocketProxyPatched = false;

@Injectable()
export class DiscordPlugin implements ChannelPlugin {
  readonly provider = 'discord';
  private readonly logger = new Logger(DiscordPlugin.name);
  private readonly bindingPolicy: PluginBindingPolicy = {
    bindAllSessions: false,
  };
  private context: ChannelPluginContext | null = null;
  private runtimes = new Map<string, DiscordRuntime>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private proxyDispatcher: Dispatcher | null = null;
  private modelAutocompleteCache = new Map<string, { expiresAt: number; models: string[] }>();
  private healthWriteByIntegration = new Map<string, Promise<void>>();
  private uncaughtExceptionHandler: ((error: Error) => void) | null = null;
  private unhandledRejectionHandler: ((reason: unknown) => void) | null = null;

  constructor(
    @Inject(ChannelsService) private readonly channelsService: ChannelsService,
  ) {}

  async boot(context: ChannelPluginContext): Promise<void> {
    this.context = context;
    this.proxyDispatcher = configureProxyFromEnvironment(this.logger);
    this.installProcessSafetyGuards();
    void this.reconcileRuntimes();
    this.reconcileTimer = setInterval(() => {
      void this.reconcileRuntimes();
    }, DEFAULT_RECONCILE_INTERVAL_MS);
  }

  async shutdown(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map((runtime) => this.stopRuntime(runtime)));
    if (this.healthWriteByIntegration.size > 0) {
      await Promise.allSettled(this.healthWriteByIntegration.values());
      this.healthWriteByIntegration.clear();
    }
    this.removeProcessSafetyGuards();
    this.context = null;
  }

  getBindingPolicy(): PluginBindingPolicy {
    return this.bindingPolicy;
  }

  async sendMessage(message: BotMessage, context: PluginDispatchContext): Promise<{ providerMessageId: string }> {
    const integrationId = normalizeOptionalString(context.bindingIntegrationId);
    if (!integrationId) {
      throw new Error('Missing Discord integration binding for outbound message');
    }
    const runtime = this.runtimes.get(integrationId);
    if (!runtime || runtime.stopped) {
      throw new Error(`Discord runtime unavailable for integration ${integrationId}`);
    }

    const targetChannelId = normalizeOptionalString(context.bindingThread) ?? normalizeOptionalString(context.bindingChannel);
    if (!targetChannelId) {
      throw new Error(`Discord binding target missing for outbound message ${message.id}`);
    }

    const channel = await runtime.client.channels.fetch(targetChannelId);
    if (!channel?.isSendable()) {
      throw new Error(`Discord channel ${targetChannelId} is not sendable`);
    }

    const approval = extractDiscordApprovalRequest(message);
    const triggerMessageId = readDiscordTriggerMessageId(message);
    if (approval) {
      const reactionTargetChannelId =
        normalizeOptionalString(context.bindingThread) ?? normalizeOptionalString(context.bindingChannel);
      if (context.isTriggeredByYou && triggerMessageId && reactionTargetChannelId) {
        await this.applyTriggerMessageAction(runtime, reactionTargetChannelId, triggerMessageId, {
          action: 'approval_pending',
          onlyIfTracked: false,
          skipOutboundText: true,
        });
      }
      const providerMessageId = await this.sendApprovalPrompt(
        runtime,
        channel as unknown as { send: (options: Record<string, unknown>) => Promise<{ id: string }> },
        approval,
      );
      return { providerMessageId };
    }
    if (shouldSkipUserMessageForSourceBinding(message, context)) {
      return { providerMessageId: `discord-source-skipped-${message.id}` };
    }

    const reactionEffect = describeDiscordReactionEffect(message);
    const outboundText = buildDiscordOutboundText(message);
    let providerMessageId: string | null = null;
    if (outboundText) {
      const chunks = splitDiscordMessageChunks(outboundText);
      for (const chunk of chunks) {
        const sent = await this.sendDiscordOutboundChunk(runtime, channel, chunk, triggerMessageId, context);
        providerMessageId = sent.id;
      }
    }

    if (reactionEffect) {
      const turnId = readDiscordTurnId(message);
      const reactionTargetChannelId =
        normalizeOptionalString(context.bindingThread) ?? normalizeOptionalString(context.bindingChannel);
      if (context.isTriggeredByYou && triggerMessageId && reactionTargetChannelId) {
        await this.applyTriggerMessageAction(runtime, reactionTargetChannelId, triggerMessageId, reactionEffect);
      }
      if (turnId) {
        const steerTarget = runtime.steerTriggerByTurnId.get(turnId);
        if (steerTarget) {
          await this.applyTriggerMessageAction(runtime, steerTarget.channelId, steerTarget.messageId, reactionEffect);
          if (
            reactionEffect.action === 'final_success' ||
            reactionEffect.action === 'final_cancel' ||
            reactionEffect.action === 'final_error'
          ) {
            runtime.steerTriggerByTurnId.delete(turnId);
          }
        }
      }
      if (reactionEffect.skipOutboundText && !providerMessageId) {
        return { providerMessageId: `discord-reaction-${message.id}` };
      }
    }

    if (providerMessageId) {
      return { providerMessageId };
    }
    return { providerMessageId: `discord-skipped-${message.id}` };
  }

  private async reconcileRuntimes(): Promise<void> {
    if (this.reconciling) {
      return;
    }
    this.reconciling = true;
    try {
      const activeIntegrations = await this.channelsService.listActiveIntegrationsForGateway({});
      const discordIntegrations = activeIntegrations.filter((integration) => integration.provider === this.provider);
      const targetById = new Map(discordIntegrations.map((integration) => [integration.id, integration]));

      for (const [integrationId, runtime] of this.runtimes) {
        const target = targetById.get(integrationId);
        if (!target || !hasSameRuntimeIdentity(target, runtime.botToken, runtime.config)) {
          this.runtimes.delete(integrationId);
          await this.stopRuntime(runtime);
        }
      }

      for (const integration of discordIntegrations) {
        if (this.runtimes.has(integration.id)) {
          continue;
        }
        const runtime = this.createRuntime(integration);
        if (!runtime) {
          continue;
        }
        this.runtimes.set(integration.id, runtime);
        await this.startRuntime(runtime);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown reconcile error';
      this.logger.warn(`Failed to reconcile Discord runtimes: ${message}`);
    } finally {
      this.reconciling = false;
    }
  }

  private createRuntime(integration: BotIntegration): DiscordRuntime | null {
    const botToken = readBotToken(integration.credentialsEncrypted);
    if (!botToken) {
      this.logger.warn(`Skipping discord integration ${integration.id}: missing bot token`);
      return null;
    }
    const config = readDiscordPluginConfig(integration.pluginConfig);
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
      rest: this.proxyDispatcher ? { agent: this.proxyDispatcher } : undefined,
    });

    const runtime: DiscordRuntime = {
      integrationId: integration.id,
      ownerUserId: integration.ownerUserId,
      client,
      botToken,
      config,
      stopped: false,
      processedMessageIds: new Map<string, number>(),
      processingMessageIds: new Set<string>(),
      approvalMenus: new Map<string, DiscordApprovalMenuState>(),
      triggerMessageActions: new Map<string, 'watching' | 'active' | 'final'>(),
      triggerMessageEffects: new Map<
        string,
        'watching' | 'active' | 'approval_pending' | 'final_success' | 'final_cancel' | 'final_error'
      >(),
      steerTriggerByTurnId: new Map<string, { channelId: string; messageId: string }>(),
      typingByMessageKey: new Map<string, string>(),
      typingIntervals: new Map<string, ReturnType<typeof setInterval>>(),
      reconnectTimer: null,
      reconnectAttempt: 0,
      loginInFlight: false,
      recoveryInFlight: false,
    };

    client.on('messageCreate', async (message) => {
      if (!this.tryBeginMessageProcessing(runtime, message.id)) {
        return;
      }
      try {
        await this.handleMessage(runtime, message);
        this.markMessageProcessed(runtime, message.id);
      } catch (error: unknown) {
        const messageText = error instanceof Error ? error.message : 'unknown messageCreate error';
        this.logger.warn(`Discord messageCreate handler failed for integration ${runtime.integrationId}: ${messageText}`);
      } finally {
        this.finishMessageProcessing(runtime, message.id);
      }
    });
    client.on('raw', (packet: GatewayDispatchPayload) => {
      if (packet.t !== 'MESSAGE_CREATE') {
        return;
      }
      const data = packet.d as unknown as Record<string, unknown>;
      const messageId = typeof data.id === 'string' ? data.id : '';
      if (messageId && this.isMessageHandledOrInFlight(runtime, messageId)) {
        return;
      }
      setTimeout(() => {
        const rawMessageId = typeof data.id === 'string' ? data.id : '';
        if (!this.tryBeginMessageProcessing(runtime, rawMessageId)) {
          return;
        }
        void this.handleRawMessageCreate(runtime, data)
          .then(() => {
            this.markMessageProcessed(runtime, rawMessageId);
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'unknown raw send error';
            this.logger.warn(`Discord raw fallback failed for integration ${runtime.integrationId}: ${message}`);
          })
          .finally(() => {
            this.finishMessageProcessing(runtime, rawMessageId);
          });
      }, RAW_FALLBACK_DELAY_MS);
    });
    client.on('clientReady', () => {
      void this.registerProjectCommand(runtime).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'unknown command registration error';
        this.logger.warn(`Discord command registration failed for integration ${runtime.integrationId}: ${message}`);
      });
    });
    client.on('interactionCreate', async (interaction) => {
      if (interaction.isAutocomplete()) {
        try {
          await this.handleCommandAutocomplete(runtime, interaction);
        } catch {
          await interaction.respond([]);
        }
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith(`${DISCORD_APPROVAL_SELECT_PREFIX}:`)) {
        try {
          await this.handleApprovalSelect(runtime, interaction);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'unknown approval interaction error';
          this.logger.warn(`Discord approval interaction failed for integration ${runtime.integrationId}: ${message}`);
          await safeMenuReply(interaction, `Failed to resolve approval: ${message}`);
        }
        return;
      }
      if (!interaction.isChatInputCommand()) {
        return;
      }
      try {
        if (interaction.commandName === DISCORD_PROJECT_COMMAND) {
          await this.handleProjectCommand(runtime, interaction);
          return;
        }
        if (interaction.commandName === DISCORD_SESSION_COMMAND) {
          await this.handleSessionCommand(runtime, interaction);
          return;
        }
        if (interaction.commandName === DISCORD_CANCEL_COMMAND) {
          await this.handleCancelCommand(runtime, interaction);
          return;
        }
        if (interaction.commandName === DISCORD_FS_COMMAND) {
          await this.handleFsCommand(runtime, interaction);
          return;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown interaction error';
        this.logger.warn(`Discord interaction failed for integration ${runtime.integrationId}: ${message}`);
        await safeReply(interaction, `Failed: ${message}`);
      }
    });

    client.on('error', (error) => {
      throw new DiscordRecoverableError(`client error: ${error.message}`, {
        cause: error,
        integrationId: runtime.integrationId,
      });
    });
    client.on('shardError', (error, shardId) => {
      throw new DiscordRecoverableError(`shard error (shard=${shardId}): ${error.message}`, {
        cause: error,
        integrationId: runtime.integrationId,
      });
    });
    client.on('shardDisconnect', (event, shardId) => {
      throw new DiscordRecoverableError(`shard disconnect (shard=${shardId}, code=${event.code})`, {
        integrationId: runtime.integrationId,
      });
    });
    client.on('invalidated', () => {
      throw new DiscordRecoverableError('session invalidated', {
        integrationId: runtime.integrationId,
      });
    });

    return runtime;
  }

  private async startRuntime(runtime: DiscordRuntime): Promise<void> {
    if (runtime.stopped || runtime.loginInFlight) {
      return;
    }
    runtime.loginInFlight = true;
    try {
      await withTimeout(
        runtime.client.login(runtime.botToken),
        DISCORD_LOGIN_TIMEOUT_MS,
        `Discord login timed out after ${DISCORD_LOGIN_TIMEOUT_MS}ms`,
      );
      runtime.reconnectAttempt = 0;
      this.clearRuntimeReconnectTimer(runtime);
      void this.markRuntimeHealthy(runtime);
      this.logger.log(
        `Discord runtime started for integration ${runtime.integrationId} as ${runtime.client.user?.tag ?? 'unknown'} (${runtime.client.user?.id ?? 'unknown'})`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown login error';
      this.logger.warn(`Discord runtime failed to login for integration ${runtime.integrationId}: ${message}`);
      this.scheduleRuntimeRecovery(runtime, `login failed: ${message}`);
    } finally {
      runtime.loginInFlight = false;
    }
  }

  private async stopRuntime(runtime: DiscordRuntime): Promise<void> {
    runtime.stopped = true;
    this.clearRuntimeReconnectTimer(runtime);
    runtime.approvalMenus.clear();
    runtime.triggerMessageActions.clear();
    runtime.triggerMessageEffects.clear();
    runtime.processingMessageIds.clear();
    runtime.steerTriggerByTurnId.clear();
    runtime.typingByMessageKey.clear();
    for (const interval of runtime.typingIntervals.values()) {
      clearInterval(interval);
    }
    runtime.typingIntervals.clear();
    try {
      await runtime.client.destroy();
    } catch {
      // ignore
    }
  }

  private scheduleRuntimeRecovery(runtime: DiscordRuntime, reason: string): void {
    if (runtime.stopped || runtime.reconnectTimer) {
      return;
    }

    runtime.reconnectAttempt += 1;
    if (runtime.reconnectAttempt <= DISCORD_RECONNECT_MAX_ATTEMPTS) {
      void this.markRuntimeError(runtime, reason);
      const delay = Math.min(
        DISCORD_RECONNECT_MAX_DELAY_MS,
        DISCORD_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, runtime.reconnectAttempt - 1),
      );
      this.logger.warn(
        `Scheduling Discord reconnect for integration ${runtime.integrationId} in ${delay}ms (attempt ${runtime.reconnectAttempt}/${DISCORD_RECONNECT_MAX_ATTEMPTS}) due to ${reason}`,
      );
      runtime.reconnectTimer = setTimeout(() => {
        runtime.reconnectTimer = null;
        void this.reconnectRuntime(runtime, reason);
      }, delay);
      return;
    }

    this.logger.warn(
      `Reconnect retries exhausted for integration ${runtime.integrationId}; disabling runtime until integration is reconfigured or service restarts (last reason: ${reason})`,
    );
    void this.markRuntimeError(
      runtime,
      `Reconnect retries exhausted after ${DISCORD_RECONNECT_MAX_ATTEMPTS} attempts. Last reason: ${reason}`,
    );
    void this.stopRuntime(runtime);
  }

  private async reconnectRuntime(runtime: DiscordRuntime, reason: string): Promise<void> {
    if (runtime.stopped || runtime.recoveryInFlight) {
      return;
    }
    runtime.recoveryInFlight = true;
    try {
      try {
        await runtime.client.destroy();
      } catch {
        // ignore destroy failures during reconnect cycle
      }
      this.logger.warn(`Attempting Discord reconnect for integration ${runtime.integrationId} after ${reason}`);
      await this.startRuntime(runtime);
    } finally {
      runtime.recoveryInFlight = false;
    }
  }

  private clearRuntimeReconnectTimer(runtime: DiscordRuntime): void {
    if (!runtime.reconnectTimer) {
      return;
    }
    clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  }

  private async markRuntimeHealthy(runtime: DiscordRuntime): Promise<void> {
    await this.enqueueHealthWrite(runtime.integrationId, async () => {
      try {
        await this.channelsService.markIntegrationRuntimeHealthyForGateway(runtime.integrationId);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown health update error';
        this.logger.warn(`Failed to mark Discord integration healthy ${runtime.integrationId}: ${message}`);
      }
    });
  }

  private async markRuntimeError(runtime: DiscordRuntime, reason: string): Promise<void> {
    await this.enqueueHealthWrite(runtime.integrationId, async () => {
      try {
        await this.channelsService.markIntegrationRuntimeErrorForGateway(runtime.integrationId, reason);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown health update error';
        this.logger.warn(`Failed to mark Discord integration error ${runtime.integrationId}: ${message}`);
      }
    });
  }

  private async enqueueHealthWrite(integrationId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.healthWriteByIntegration.get(integrationId) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // Previous write failures are logged at source; keep queue progressing.
      })
      .then(write);
    this.healthWriteByIntegration.set(integrationId, next);
    await next;
    if (this.healthWriteByIntegration.get(integrationId) === next) {
      this.healthWriteByIntegration.delete(integrationId);
    }
  }

  private installProcessSafetyGuards(): void {
    if (!this.uncaughtExceptionHandler) {
      this.uncaughtExceptionHandler = (error: Error) => {
        if (this.tryHandleDiscordProcessError(error, 'uncaughtException')) {
          return;
        }
        throw error;
      };
      process.on('uncaughtException', this.uncaughtExceptionHandler);
    }
    if (!this.unhandledRejectionHandler) {
      this.unhandledRejectionHandler = (reason: unknown) => {
        if (this.tryHandleDiscordProcessError(reason, 'unhandledRejection')) {
          return;
        }
        throw toError(reason);
      };
      process.on('unhandledRejection', this.unhandledRejectionHandler);
    }
  }

  private removeProcessSafetyGuards(): void {
    if (this.uncaughtExceptionHandler) {
      process.off('uncaughtException', this.uncaughtExceptionHandler);
      this.uncaughtExceptionHandler = null;
    }
    if (this.unhandledRejectionHandler) {
      process.off('unhandledRejection', this.unhandledRejectionHandler);
      this.unhandledRejectionHandler = null;
    }
  }

  private tryHandleDiscordProcessError(errorLike: unknown, source: 'uncaughtException' | 'unhandledRejection'): boolean {
    if (!(errorLike instanceof DiscordRecoverableError)) {
      return false;
    }
    const error = errorLike;
    this.logger.warn(`Captured Discord runtime ${source}: ${error.message}`);
    if (error.integrationId) {
      const runtime = this.runtimes.get(error.integrationId);
      if (runtime) {
        this.scheduleRuntimeRecovery(runtime, `${source}: ${error.message}`);
      }
      return true;
    }
    for (const runtime of this.runtimes.values()) {
      this.scheduleRuntimeRecovery(runtime, `${source}: ${error.message}`);
    }
    return true;
  }

  private async sendApprovalPrompt(
    runtime: DiscordRuntime,
    channel: { send: (options: Record<string, unknown>) => Promise<{ id: string }> },
    approval: DiscordApprovalRequest,
  ): Promise<string> {
    const options = getDiscordApprovalActionOptions(approval.kind, approval.payload).slice(0, 25);
    if (options.length === 0) {
      throw new Error(`No approval actions available for approval ${approval.approvalId}`);
    }
    this.compactApprovalMenus(runtime);
    const menuId = buildApprovalMenuId();
    const optionByKey = new Map(options.map((option) => [option.key, option]));
    runtime.approvalMenus.set(menuId, {
      turnId: approval.turnId,
      approvalId: approval.approvalId,
      options,
      optionByKey,
      expiresAt: Date.now() + DISCORD_APPROVAL_MENU_TTL_MS,
    });

    const select = new StringSelectMenuBuilder()
      .setCustomId(`${DISCORD_APPROVAL_SELECT_PREFIX}:${menuId}`)
      .setPlaceholder('Choose approval action')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        options.map((option) => ({
          label: option.label.slice(0, 100),
          value: option.key.slice(0, 100),
        })),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const sent = await channel.send({
      content: limitDiscordMessageLength(formatApprovalPromptContent(approval.kind, approval.payload)),
      components: [row],
      allowedMentions: buildAllowedMentions(runtime.config.message?.allowEveryoneMention ?? false),
    });
    return sent.id;
  }

  private async handleApprovalSelect(runtime: DiscordRuntime, interaction: StringSelectMenuInteraction): Promise<void> {
    this.compactApprovalMenus(runtime);
    const menuId = interaction.customId.slice(`${DISCORD_APPROVAL_SELECT_PREFIX}:`.length);
    const state = runtime.approvalMenus.get(menuId);
    if (!state || state.expiresAt <= Date.now()) {
      runtime.approvalMenus.delete(menuId);
      await safeMenuReply(interaction, 'This approval action has expired. Please request approval again.');
      return;
    }
    const selectedKey = interaction.values[0] ?? '';
    const selected = state.optionByKey.get(selectedKey);
    if (!selected) {
      await safeMenuReply(interaction, 'Unknown approval action.');
      return;
    }

    // Acknowledge quickly to avoid Discord "interaction failed" when backend resolution takes >3s.
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }

    await this.requireContext().resolveApproval({
      turnId: state.turnId,
      approvalId: state.approvalId,
      decision: selected.decision,
    });

    runtime.approvalMenus.delete(menuId);
    await interaction.editReply({
      content: limitDiscordMessageLength(
        `${interaction.message.content}\n\nApproved by <@${interaction.user.id}>: ${selected.label}`,
      ),
      components: [],
      allowedMentions: buildAllowedMentions(runtime.config.message?.allowEveryoneMention ?? false),
    });
  }

  private compactApprovalMenus(runtime: DiscordRuntime): void {
    const now = Date.now();
    for (const [menuId, state] of runtime.approvalMenus) {
      if (state.expiresAt <= now) {
        runtime.approvalMenus.delete(menuId);
      }
    }
  }

  private async registerProjectCommand(runtime: DiscordRuntime): Promise<void> {
    if (!runtime.client.application) {
      return;
    }
    const definitions = buildDiscordCommandDefinitions();
    await runtime.client.application.commands.set(definitions);
    for (const guild of runtime.client.guilds.cache.values()) {
      try {
        await guild.commands.set(definitions);
      } catch {
        // ignore per-guild registration failure; global command remains registered.
      }
    }
  }

  private async handleProjectCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === 'list') {
      await this.handleProjectListCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'info') {
      await this.handleProjectInfoCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'create') {
      await this.handleProjectCreateCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'bind') {
      await this.handleProjectBindCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'change') {
      await this.handleProjectChangeCommand(runtime, interaction);
      return;
    }
    await safeReply(interaction, `Unsupported subcommand: ${subcommand}`);
  }

  private async handleSessionCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === 'list') {
      await this.handleSessionListCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'create') {
      await this.handleSessionCreateCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'bind') {
      await this.handleSessionBindCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'info') {
      await this.handleSessionInfoCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'history') {
      await this.handleSessionHistoryCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'change') {
      await this.handleSessionChangeCommand(runtime, interaction);
      return;
    }
    await safeReply(interaction, `Unsupported subcommand: ${subcommand}`);
  }

  private async handleCancelCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return;
    }
    const sessionId = findSessionIdByTarget(runtime.config, target.bindingChannelId, target.bindingThreadId);
    if (!sessionId) {
      await interaction.editReply('No bound session found for this target.');
      return;
    }
    const active = await this.readSteerableTurnForSession(runtime.ownerUserId, sessionId);
    if (!active) {
      await interaction.editReply(`No active steerable turn for session \`${sessionId}\`.`);
      return;
    }
    await this.requireContext().cancelTurnForUser(runtime.ownerUserId, active.turnId);
    await interaction.editReply(`Cancel requested for turn \`${active.turnId}\`.`);
  }

  private async handleFsCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === 'get') {
      await this.handleFsGetCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'ls') {
      await this.handleFsListCommand(runtime, interaction);
      return;
    }
    if (subcommand === 'tree') {
      await this.handleFsTreeCommand(runtime, interaction);
      return;
    }
    await safeReply(interaction, `Unsupported subcommand: ${subcommand}`);
  }

  private async handleFsGetCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return;
    }

    const sessionId = findSessionIdByTarget(runtime.config, target.bindingChannelId, target.bindingThreadId);
    if (!sessionId) {
      await interaction.editReply('No bound session found for this target.');
      return;
    }

    const sessionHistory = await this.requireContext().getSessionHistoryForUser(runtime.ownerUserId, sessionId);
    const historyRecord = asRecord(sessionHistory) ?? {};
    const sessionRecord = asRecord(historyRecord.session);
    if (!sessionRecord) {
      await interaction.editReply(`Unable to resolve session metadata for \`${sessionId}\`.`);
      return;
    }
    const requestedPath = interaction.options.getString('path', true).trim();
    const workspace = await this.resolveSessionWorkspaceForFs(runtime, sessionRecord);
    const resolvedPath = resolveFsPathForGet(workspace, requestedPath);
    if (!resolvedPath) {
      await interaction.editReply(
        workspace
          ? 'Invalid path. Use a workspace-relative path or an absolute path starting with `/`.'
          : 'Invalid path. Use an absolute path starting with `/`.',
      );
      return;
    }

    const file = await this.requireContext().readWorkspaceFileContent({ path: resolvedPath });
    const fileName = sanitizeDiscordFileName(path.basename(file.path));
    await interaction.editReply({
      content: `File: \`${file.path}\``,
      files: [
        {
          attachment: file.content,
          name: fileName,
        },
      ],
    });
  }

  private async resolveSessionWorkspaceForFs(
    runtime: DiscordRuntime,
    sessionRecord: Record<string, unknown>,
  ): Promise<string | null> {
    const sessionRuntime = readSessionRuntimeMetaForDisplay(sessionRecord.meta);
    const runtimeWorkspace = normalizeOptionalString(sessionRuntime.workspace);
    if (runtimeWorkspace && runtimeWorkspace !== '(auto)') {
      return runtimeWorkspace;
    }

    const projectId = normalizeOptionalString(sessionRecord.projectId);
    if (!projectId) {
      return null;
    }
    const project = asRecord(await this.requireContext().getProjectForUser(runtime.ownerUserId, projectId));
    return normalizeOptionalString(project?.repoPath);
  }

  private async handleFsListCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const sessionRecord = await this.resolveSessionRecordForFs(runtime, interaction);
    if (!sessionRecord) {
      return;
    }

    const workspace = await this.resolveSessionWorkspaceForFs(runtime, sessionRecord);
    const requestedPath = normalizeOptionalString(interaction.options.getString('path'));
    const resolvedPath = resolveFsPathForListing(workspace, requestedPath);
    if (!resolvedPath) {
      await interaction.editReply(
        workspace
          ? 'Invalid path. Use a workspace-relative path or an absolute path starting with `/`.'
          : 'Invalid path. Use an absolute path starting with `/`.',
      );
      return;
    }

    const entries = await this.requireContext()
      .listWorkspaceTree({
        path: resolvedPath,
        limit: 500,
        includeHidden: true,
      })
      .catch(() => null as Array<{ name: string; path: string; isDirectory: boolean }> | null);
    if (!entries) {
      await interaction.editReply(`Unable to list directory: \`${resolvedPath}\`.`);
      return;
    }

    const lines = entries.map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name));
    const content = renderFsTextReply(`Listing: ${resolvedPath}`, lines);
    await this.editFsReplyWithOverflowAsFile(
      interaction,
      content,
      `fs-ls-${path.basename(resolvedPath) || 'root'}.md`,
    );
  }

  private async handleFsTreeCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const sessionRecord = await this.resolveSessionRecordForFs(runtime, interaction);
    if (!sessionRecord) {
      return;
    }

    const workspace = await this.resolveSessionWorkspaceForFs(runtime, sessionRecord);
    const requestedPath = normalizeOptionalString(interaction.options.getString('path'));
    const resolvedPath = resolveFsPathForListing(workspace, requestedPath);
    if (!resolvedPath) {
      await interaction.editReply(
        workspace
          ? 'Invalid path. Use a workspace-relative path or an absolute path starting with `/`.'
          : 'Invalid path. Use an absolute path starting with `/`.',
      );
      return;
    }

    const firstLevel = await this.requireContext()
      .listWorkspaceTree({
        path: resolvedPath,
        limit: 200,
        includeHidden: true,
      })
      .catch(() => null as Array<{ name: string; path: string; isDirectory: boolean }> | null);
    if (!firstLevel) {
      await interaction.editReply(`Unable to list directory: \`${resolvedPath}\`.`);
      return;
    }

    const firstLevelDirectories = firstLevel.filter((entry) => entry.isDirectory);
    const directoriesToExpand = firstLevelDirectories.slice(0, FS_TREE_SECOND_LEVEL_MAX_DIRS);
    const secondLevelByPath = new Map<string, Array<{ name: string; path: string; isDirectory: boolean }>>();

    for (let start = 0; start < directoriesToExpand.length; start += FS_TREE_SECOND_LEVEL_CONCURRENCY) {
      const batch = directoriesToExpand.slice(start, start + FS_TREE_SECOND_LEVEL_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (entry) => {
          const secondLevel = await this.requireContext()
            .listWorkspaceTree({
              path: entry.path,
              limit: 120,
              includeHidden: true,
            })
            .catch(() => [] as Array<{ name: string; path: string; isDirectory: boolean }>);
          return { path: entry.path, secondLevel };
        }),
      );
      for (const result of batchResults) {
        secondLevelByPath.set(result.path, result.secondLevel);
      }
    }

    const lines: string[] = [];
    for (const firstEntry of firstLevel) {
      lines.push(firstEntry.isDirectory ? `- ${firstEntry.name}/` : `- ${firstEntry.name}`);
      if (!firstEntry.isDirectory) {
        continue;
      }
      const secondLevel = secondLevelByPath.get(firstEntry.path) ?? [];
      for (const secondEntry of secondLevel) {
        lines.push(secondEntry.isDirectory ? `  - ${secondEntry.name}/` : `  - ${secondEntry.name}`);
      }
    }
    if (firstLevelDirectories.length > directoriesToExpand.length) {
      lines.push(
        `... skipped depth-2 expansion for ${firstLevelDirectories.length - directoriesToExpand.length} directories`,
      );
    }

    const content = renderFsTextReply(`Tree (depth=2): ${resolvedPath}`, lines);
    await this.editFsReplyWithOverflowAsFile(
      interaction,
      content,
      `fs-tree-${path.basename(resolvedPath) || 'root'}.md`,
    );
  }

  private async resolveSessionRecordForFs(
    runtime: DiscordRuntime,
    interaction: ChatInputCommandInteraction,
  ): Promise<Record<string, unknown> | null> {
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return null;
    }

    const sessionId = findSessionIdByTarget(runtime.config, target.bindingChannelId, target.bindingThreadId);
    if (!sessionId) {
      await interaction.editReply('No bound session found for this target.');
      return null;
    }

    const sessionHistory = await this.requireContext().getSessionHistoryForUser(runtime.ownerUserId, sessionId);
    const historyRecord = asRecord(sessionHistory) ?? {};
    const sessionRecord = asRecord(historyRecord.session);
    if (!sessionRecord) {
      await interaction.editReply(`Unable to resolve session metadata for \`${sessionId}\`.`);
      return null;
    }
    return sessionRecord;
  }

  private async editFsReplyWithOverflowAsFile(
    interaction: ChatInputCommandInteraction,
    content: string,
    fileNameHint: string,
  ): Promise<void> {
    if (content.length <= DISCORD_MESSAGE_MAX_LENGTH) {
      await interaction.editReply(content);
      return;
    }

    const baseName = path.basename(fileNameHint || 'fs-output.md');
    const safeName = sanitizeDiscordFileName(baseName).replace(/\.md$/i, '') || 'fs-output';
    const fileName = `${safeName}.md`;
    let tempDirectory: string | null = null;
    try {
      tempDirectory = await mkdtemp(path.join(tmpdir(), 'agentwaypoint-discord-fs-'));
      const filePath = path.join(tempDirectory, fileName);
      await writeFile(filePath, content, 'utf8');
      await interaction.editReply({
        content: limitDiscordMessageLength(`Output exceeds Discord message limit. Attached: \`${fileName}\`.`),
        files: [
          {
            attachment: filePath,
            name: fileName,
          },
        ],
      });
    } catch {
      await interaction.editReply(limitDiscordMessageLength(content));
    } finally {
      if (tempDirectory) {
        await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async handleProjectListCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const projects = asRecordArray(await this.requireContext().listProjectsForUser(runtime.ownerUserId));
    if (projects.length === 0) {
      await interaction.editReply('No projects found.');
      return;
    }
    const lines = projects
      .map((project) => {
        const id = normalizeOptionalString(project.id) ?? 'unknown';
        const name = normalizeOptionalString(project.name) ?? 'unnamed';
        const backend = normalizeOptionalString(project.backend) ?? 'unknown';
        const repoPath = normalizeOptionalString(project.repoPath) ?? '(auto)';
        return `- \`${id}\` ${name} | backend=${backend} | repo=${repoPath}`;
      })
      .join('\n');
    await interaction.editReply(`Projects:\n${lines}`);
  }

  private async handleProjectInfoCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const projectRef = normalizeOptionalString(interaction.options.getString('project'));
    const project = projectRef
      ? await this.resolveProjectByRef(runtime.ownerUserId, projectRef)
      : await this.resolveBoundProjectForInteraction(runtime, interaction);
    if (!project) {
      await interaction.editReply(
        projectRef
          ? `Project not found: ${projectRef}`
          : 'No bound project found for current channel/thread.',
      );
      return;
    }
    const id = normalizeOptionalString(project.id) ?? 'unknown';
    const name = normalizeOptionalString(project.name) ?? 'unnamed';
    const backend = normalizeOptionalString(project.backend) ?? 'unknown';
    const repoPath = normalizeOptionalString(project.repoPath) ?? '(auto)';
    const backendConfig = normalizeJsonRecordForDisplay(project.backendConfig);
    const info =
      `id: ${id}\n` +
      `name: ${name}\n` +
      `backend: ${backend}\n` +
      `repoPath: ${repoPath}\n` +
      `backendConfig: ${JSON.stringify(backendConfig)}`;
    await interaction.editReply(`Project info:\n\`\`\`\n${info}\n\`\`\``);
  }

  private async resolveBoundProjectForInteraction(
    runtime: DiscordRuntime,
    interaction: ChatInputCommandInteraction,
  ): Promise<Record<string, unknown> | null> {
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      return null;
    }

    const threadBoundSessionId = findSessionIdByTarget(runtime.config, target.bindingChannelId, target.bindingThreadId);
    if (threadBoundSessionId) {
      const session = await this.readSessionForOwner(runtime.ownerUserId, threadBoundSessionId);
      if (session) {
        const project = await this.tryGetProjectById(runtime.ownerUserId, session.projectId);
        if (project) {
          return project;
        }
      }
    }

    const channelProjectId = findProjectIdByChannel(runtime.config, target.bindingChannelId);
    if (!channelProjectId) {
      return null;
    }
    return this.tryGetProjectById(runtime.ownerUserId, channelProjectId);
  }

  private async handleProjectCreateCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    const threadError = this.validateCommandNotInThread(interaction);
    if (threadError) {
      await safeReply(interaction, threadError);
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const name = interaction.options.getString('name', true).trim();
    const workingDir = normalizeOptionalString(interaction.options.getString('working_dir'));
    const backend = normalizeOptionalString(interaction.options.getString('backend'))?.toLowerCase() ?? null;
    const model = normalizeOptionalString(interaction.options.getString('model'));
    const executionMode = normalizeOptionalString(interaction.options.getString('execution_mode'));
    if ((model && !executionMode) || (!model && executionMode)) {
      await interaction.editReply('Please provide both model and execution_mode together.');
      return;
    }
    if (backend === 'claude' && (!model || !executionMode)) {
      await interaction.editReply('Backend `claude` requires both model and execution_mode.');
      return;
    }
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return;
    }

    const createInput: {
      name: string;
      repoPath?: string;
      backend?: string;
      backendConfig?: Record<string, unknown>;
    } = {
      name,
      repoPath: workingDir ?? undefined,
    };
    if (backend) {
      createInput.backend = backend;
    }
    if (model && executionMode) {
      if (!EXECUTION_MODE_CHOICES.includes(executionMode as (typeof EXECUTION_MODE_CHOICES)[number])) {
        await interaction.editReply(`Unsupported execution_mode: ${executionMode}`);
        return;
      }
      createInput.backendConfig = {
        model,
        executionMode,
      };
    }

    const created = await this.requireContext().createProjectForUser(runtime.ownerUserId, createInput);
    const project = asRecord(created) ?? {};
    const projectId = readRequiredId(created, 'project');

    const nextConfig = applyChannelProjectBinding(runtime.config, {
      channelId: target.bindingChannelId,
      guildId: target.guildId,
      projectId,
    });
    await this.persistRuntimeConfig(runtime, nextConfig);
    await interaction.editReply(`Created and bound project \`${projectId}\` to this channel.`);
  }

  private async handleProjectBindCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    const threadError = this.validateCommandNotInThread(interaction);
    if (threadError) {
      await safeReply(interaction, threadError);
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const projectRef = interaction.options.getString('project', true).trim();
    const project = await this.resolveProjectByRef(runtime.ownerUserId, projectRef);
    if (!project) {
      await interaction.editReply(`Project not found: ${projectRef}`);
      return;
    }
    const projectId = readRequiredId(project, 'project');
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return;
    }
    const nextConfig = applyChannelProjectBinding(runtime.config, {
      channelId: target.bindingChannelId,
      guildId: target.guildId,
      projectId,
    });
    await this.persistRuntimeConfig(runtime, nextConfig);
    await interaction.editReply(`Bound this channel to project \`${projectId}\`.`);
  }

  private async handleProjectChangeCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    const threadError = this.validateCommandNotInThread(interaction);
    if (threadError) {
      await safeReply(interaction, threadError);
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return;
    }
    const projectId = findProjectIdByChannel(runtime.config, target.bindingChannelId);
    if (!projectId) {
      await interaction.editReply('This channel is not bound to any project.');
      return;
    }
    const project = await this.requireContext().getProjectForUser(runtime.ownerUserId, projectId);
    const projectRecord = asRecord(project);
    if (!projectRecord) {
      await interaction.editReply(`Unable to load bound project ${projectId}.`);
      return;
    }

    const workingDir = normalizeOptionalString(interaction.options.getString('working_dir'));
    const model = normalizeOptionalString(interaction.options.getString('model'));
    const executionMode = normalizeOptionalString(interaction.options.getString('execution_mode'));
    if (!workingDir && !model && !executionMode) {
      await interaction.editReply('No changes provided.');
      return;
    }

    const updateInput = buildProjectUpdateInput(projectRecord, {
      repoPath: workingDir,
      model,
      executionMode,
    });
    await this.requireContext().updateProjectForUser(runtime.ownerUserId, projectId, updateInput);

    const nextConfig = applyChannelProjectBinding(runtime.config, {
      channelId: target.bindingChannelId,
      guildId: target.guildId,
      projectId,
    });
    await this.persistRuntimeConfig(runtime, nextConfig);
    await interaction.editReply(`Updated and rebound project \`${projectId}\` for this channel.`);
  }

  private async handleSessionListCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const projectRef = normalizeOptionalString(interaction.options.getString('project'));
    const project = projectRef
      ? await this.resolveProjectByRef(runtime.ownerUserId, projectRef)
      : await this.resolveBoundProjectForInteraction(runtime, interaction);
    if (!project) {
      await interaction.editReply(projectRef ? `Project not found: ${projectRef}` : 'No bound project found.');
      return;
    }
    const projectId = readRequiredId(project, 'project');
    const sessions = asRecordArray(await this.requireContext().listSessionsForProject(runtime.ownerUserId, projectId));
    if (sessions.length === 0) {
      await interaction.editReply(`No sessions found for project \`${projectId}\`.`);
      return;
    }
    const lines = sessions
      .map((session) => {
        const id = normalizeOptionalString(session.id) ?? 'unknown';
        const title = normalizeOptionalString(session.title) ?? 'untitled';
        const status = normalizeOptionalString(session.status) ?? 'unknown';
        return `- \`${id}\` ${title} | status=${status}`;
      })
      .join('\n');
    await interaction.editReply(`Sessions for project \`${projectId}\`:\n${lines}`);
  }

  private async handleSessionCreateCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return;
    }
    const title = normalizeOptionalString(interaction.options.getString('title')) ?? buildDiscordSessionTitle(target.bindingChannelId, target.bindingThreadId);
    const projectRef = normalizeOptionalString(interaction.options.getString('project'));
    const project = projectRef
      ? await this.resolveProjectByRef(runtime.ownerUserId, projectRef)
      : await this.resolveBoundProjectForInteraction(runtime, interaction);
    if (!project) {
      await interaction.editReply(projectRef ? `Project not found: ${projectRef}` : 'No bound project found.');
      return;
    }
    const projectId = readRequiredId(project, 'project');

    const workingDir = normalizeOptionalString(interaction.options.getString('working_dir'));
    const backend = normalizeOptionalString(interaction.options.getString('backend'))?.toLowerCase() ?? null;
    const model = normalizeOptionalString(interaction.options.getString('model'));
    const executionMode = normalizeOptionalString(interaction.options.getString('execution_mode'));
    const createSessionInput = buildSessionCreateInputFromProject(project, {
      title,
      workingDir,
      backend,
      model,
      executionMode,
    });
    const createdSession = await this.requireContext().createSessionForProject(runtime.ownerUserId, projectId, {
      ...createSessionInput,
    });
    const sessionId = readRequiredId(createdSession, 'session');

    const nextConfig = bindSessionToTarget(runtime.config, {
      channelId: target.bindingChannelId,
      threadId: target.bindingThreadId,
      guildId: target.guildId,
      projectId,
      sessionId,
      updateChannelProject: !target.bindingThreadId,
    });
    await this.persistRuntimeConfig(runtime, nextConfig);
    await interaction.editReply(`Created and bound session \`${sessionId}\` to this ${target.bindingThreadId ? 'thread' : 'channel'}.`);
  }

  private async handleSessionBindCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return;
    }
    const sessionRef = normalizeOptionalString(interaction.options.getString('session'));
    if (!sessionRef) {
      await interaction.editReply('Please provide a session id (or exact title).');
      return;
    }
    const projectRef = normalizeOptionalString(interaction.options.getString('project'));
    const project = projectRef
      ? await this.resolveProjectByRef(runtime.ownerUserId, projectRef)
      : await this.resolveBoundProjectForInteraction(runtime, interaction);
    if (!project) {
      await interaction.editReply(projectRef ? `Project not found: ${projectRef}` : 'No bound project found.');
      return;
    }
    const projectId = readRequiredId(project, 'project');
    const session = await this.resolveSessionByRef(runtime.ownerUserId, projectId, sessionRef);
    if (!session) {
      await interaction.editReply(`Session not found in project \`${projectId}\`: ${sessionRef}`);
      return;
    }
    const sessionId = readRequiredId(session, 'session');

    const nextConfig = bindSessionToTarget(runtime.config, {
      channelId: target.bindingChannelId,
      threadId: target.bindingThreadId,
      guildId: target.guildId,
      projectId,
      sessionId,
      updateChannelProject: !target.bindingThreadId,
    });
    await this.persistRuntimeConfig(runtime, nextConfig);
    await interaction.editReply(`Bound this ${target.bindingThreadId ? 'thread' : 'channel'} to session \`${sessionId}\`.`);
  }

  private async handleSessionInfoCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return;
    }
    const projectRef = normalizeOptionalString(interaction.options.getString('project'));
    const sessionRef = normalizeOptionalString(interaction.options.getString('session'));
    const project = projectRef
      ? await this.resolveProjectByRef(runtime.ownerUserId, projectRef)
      : await this.resolveBoundProjectForInteraction(runtime, interaction);
    if (!project) {
      await interaction.editReply(projectRef ? `Project not found: ${projectRef}` : 'No bound project found.');
      return;
    }
    const projectId = readRequiredId(project, 'project');
    const boundSessionId = findSessionIdByTarget(runtime.config, target.bindingChannelId, target.bindingThreadId);
    const session = sessionRef
      ? await this.resolveSessionByRef(runtime.ownerUserId, projectId, sessionRef)
      : boundSessionId
        ? await this.resolveSessionByRef(runtime.ownerUserId, projectId, boundSessionId)
        : null;
    if (!session) {
      await interaction.editReply(sessionRef ? `Session not found: ${sessionRef}` : 'No bound session found for this target.');
      return;
    }
    const sessionId = readRequiredId(session, 'session');
    const history = await this.requireContext().getSessionHistoryForUser(runtime.ownerUserId, sessionId);
    const historyRecord = asRecord(history) ?? {};
    const sessionRecord = asRecord(historyRecord.session) ?? session;
    const sessionRuntime = readSessionRuntimeMetaForDisplay(sessionRecord.meta);
    const messages = asRecordArray(historyRecord.messages);
    const turns = asRecordArray(historyRecord.turns);
    const info =
      `id: ${normalizeOptionalString(sessionRecord.id) ?? sessionId}\n` +
      `title: ${normalizeOptionalString(sessionRecord.title) ?? 'untitled'}\n` +
      `status: ${normalizeOptionalString(sessionRecord.status) ?? 'unknown'}\n` +
      `projectId: ${normalizeOptionalString(sessionRecord.projectId) ?? projectId}\n` +
      `backend: ${sessionRuntime.backend}\n` +
      `workspace: ${sessionRuntime.workspace}\n` +
      `backendConfig: ${JSON.stringify(sessionRuntime.backendConfig)}\n` +
      `messages: ${messages.length}\n` +
      `turns: ${turns.length}`;
    await interaction.editReply(`Session info:\n\`\`\`\n${info}\n\`\`\``);
  }

  private async handleSessionHistoryCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return;
    }

    const projectRef = normalizeOptionalString(interaction.options.getString('project'));
    const sessionRef = normalizeOptionalString(interaction.options.getString('session'));
    const requestedLimit = interaction.options.getInteger('limit');
    const limit = Math.max(1, Math.min(requestedLimit ?? 6, 50));

    const project = projectRef
      ? await this.resolveProjectByRef(runtime.ownerUserId, projectRef)
      : await this.resolveBoundProjectForInteraction(runtime, interaction);
    if (!project) {
      await interaction.editReply(projectRef ? `Project not found: ${projectRef}` : 'No bound project found.');
      return;
    }
    const projectId = readRequiredId(project, 'project');
    const boundSessionId = findSessionIdByTarget(runtime.config, target.bindingChannelId, target.bindingThreadId);
    const session = sessionRef
      ? await this.resolveSessionByRef(runtime.ownerUserId, projectId, sessionRef)
      : boundSessionId
        ? await this.resolveSessionByRef(runtime.ownerUserId, projectId, boundSessionId)
        : null;
    if (!session) {
      await interaction.editReply(
        sessionRef ? `Session not found: ${sessionRef}` : 'No bound session found for this target.',
      );
      return;
    }

    const sessionId = readRequiredId(session, 'session');
    const history = await this.requireContext().getSessionHistoryForUser(runtime.ownerUserId, sessionId);
    const historyRecord = asRecord(history) ?? {};
    const messages = asRecordArray(historyRecord.messages);
    const rendered = renderSessionHistoryLines(messages, limit);
    if (rendered.length === 0) {
      await interaction.editReply(`No messages found for session \`${sessionId}\`.`);
      return;
    }
    await interaction.editReply(limitDiscordMessageLength(`Session history (\`${sessionId}\`, last ${rendered.length}):\n${rendered.join('\n')}`));
  }

  private async handleSessionChangeCommand(runtime: DiscordRuntime, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const target = resolveBindingTargetFromInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.editReply('Unable to resolve channel binding target.');
      return;
    }

    const projectRef = normalizeOptionalString(interaction.options.getString('project'));
    const sessionRef = normalizeOptionalString(interaction.options.getString('session'));
    const title = normalizeOptionalString(interaction.options.getString('title'));
    const model = normalizeOptionalString(interaction.options.getString('model'));
    const executionMode = normalizeOptionalString(interaction.options.getString('execution_mode'));
    if (!title && !model && !executionMode) {
      await interaction.editReply('No changes provided.');
      return;
    }

    const project = projectRef
      ? await this.resolveProjectByRef(runtime.ownerUserId, projectRef)
      : await this.resolveBoundProjectForInteraction(runtime, interaction);
    if (!project) {
      await interaction.editReply(projectRef ? `Project not found: ${projectRef}` : 'No bound project found.');
      return;
    }
    const projectId = readRequiredId(project, 'project');

    const boundSessionId = findSessionIdByTarget(runtime.config, target.bindingChannelId, target.bindingThreadId);
    const session = sessionRef
      ? await this.resolveSessionByRef(runtime.ownerUserId, projectId, sessionRef)
      : boundSessionId
        ? await this.resolveSessionByRef(runtime.ownerUserId, projectId, boundSessionId)
        : null;
    if (!session) {
      await interaction.editReply(
        sessionRef ? `Session not found: ${sessionRef}` : 'No bound session found for this target.',
      );
      return;
    }

    const sessionId = readRequiredId(session, 'session');
    const history = await this.requireContext().getSessionHistoryForUser(runtime.ownerUserId, sessionId);
    const historyRecord = asRecord(history) ?? {};
    const sessionRecord = asRecord(historyRecord.session) ?? session;
    const updateInput = buildSessionUpdateInput(sessionRecord, {
      title,
      model,
      executionMode,
    });
    await this.requireContext().updateSessionForUser(runtime.ownerUserId, sessionId, updateInput);
    await interaction.editReply(`Updated session \`${sessionId}\`.`);
  }

  private async handleCommandAutocomplete(
    runtime: DiscordRuntime,
    interaction: AutocompleteInteraction,
  ): Promise<void> {
    if (interaction.commandName === DISCORD_PROJECT_COMMAND) {
      await this.handleProjectAutocomplete(runtime, interaction);
      return;
    }
    if (interaction.commandName === DISCORD_SESSION_COMMAND) {
      await this.handleSessionAutocomplete(runtime, interaction);
      return;
    }
    if (interaction.commandName === DISCORD_FS_COMMAND) {
      await this.handleFsAutocomplete(runtime, interaction);
      return;
    }
    await interaction.respond([]);
  }

  private async handleProjectAutocomplete(
    runtime: DiscordRuntime,
    interaction: AutocompleteInteraction,
  ): Promise<void> {
    if (interaction.commandName !== DISCORD_PROJECT_COMMAND) {
      await interaction.respond([]);
      return;
    }
    const subcommand = interaction.options.getSubcommand(false);
    if (subcommand !== 'create') {
      if (subcommand === 'change') {
        const focusedChange = interaction.options.getFocused(true);
        if (focusedChange.name === 'working_dir') {
          const prefix = String(focusedChange.value ?? '');
          const suggestions = await this.requireContext().suggestWorkspaceDirectories({
            prefix,
            limit: 25,
          });
          await interaction.respond(
            suggestions.slice(0, 25).map((item) => ({
              name: item,
              value: item,
            })),
          );
          return;
        }
      }
      await interaction.respond([]);
      return;
    }

    const focused = interaction.options.getFocused(true);
    const focusedRawValue = String(focused.value ?? '');
    const focusedValue = focusedRawValue.toLowerCase();
    const selectedBackend = normalizeOptionalString(interaction.options.getString('backend'))?.toLowerCase() ?? null;

    if (focused.name === 'working_dir') {
      const suggestions = await this.requireContext().suggestWorkspaceDirectories({
        prefix: focusedRawValue,
        limit: 25,
      });
      await interaction.respond(
        suggestions.slice(0, 25).map((item) => ({
          name: item,
          value: item,
        })),
      );
      return;
    }

    if (focused.name === 'backend') {
      const suggestions = ['codex', 'claude', 'mock']
        .filter((item) => item.includes(focusedValue))
        .slice(0, 25)
        .map((item) => ({ name: item, value: item }));
      await interaction.respond(suggestions);
      return;
    }

    if (focused.name === 'model') {
      const uniqueModels = await this.getModelAutocompleteOptions(selectedBackend);
      const suggestions = uniqueModels
        .filter((item) => item.toLowerCase().includes(focusedValue))
        .slice(0, 25)
        .map((item) => ({ name: item, value: item }));
      await interaction.respond(suggestions);
      return;
    }

    if (focused.name === 'execution_mode') {
      const candidates = resolveExecutionModesForBackend(selectedBackend);
      const suggestions = candidates
        .filter((item) => item.includes(focusedValue))
        .slice(0, 25)
        .map((item) => ({ name: item, value: item }));
      await interaction.respond(suggestions);
      return;
    }

    await interaction.respond([]);
  }

  private async handleSessionAutocomplete(
    runtime: DiscordRuntime,
    interaction: AutocompleteInteraction,
  ): Promise<void> {
    if (interaction.commandName !== DISCORD_SESSION_COMMAND) {
      await interaction.respond([]);
      return;
    }

    const focused = interaction.options.getFocused(true);
    const focusedRawValue = String(focused.value ?? '');
    const focusedValue = focusedRawValue.toLowerCase();
    const subcommand = interaction.options.getSubcommand(false);

    if (focused.name === 'working_dir') {
      const suggestions = await this.requireContext().suggestWorkspaceDirectories({
        prefix: focusedRawValue,
        limit: 25,
      });
      await interaction.respond(
        suggestions.slice(0, 25).map((item) => ({
          name: item,
          value: item,
        })),
      );
      return;
    }

    if (focused.name === 'backend') {
      const suggestions = ['codex', 'claude', 'mock']
        .filter((item) => item.includes(focusedValue))
        .slice(0, 25)
        .map((item) => ({ name: item, value: item }));
      await interaction.respond(suggestions);
      return;
    }

    if (focused.name === 'model') {
      const selectedBackend = normalizeOptionalString(interaction.options.getString('backend'))?.toLowerCase() ?? null;
      const uniqueModels = await this.getModelAutocompleteOptions(selectedBackend);
      const suggestions = uniqueModels
        .filter((item) => item.toLowerCase().includes(focusedValue))
        .slice(0, 25)
        .map((item) => ({ name: item, value: item }));
      await interaction.respond(suggestions);
      return;
    }

    if (focused.name === 'execution_mode') {
      const selectedBackend = normalizeOptionalString(interaction.options.getString('backend'))?.toLowerCase() ?? null;
      const candidates = resolveExecutionModesForBackend(selectedBackend);
      const suggestions = candidates
        .filter((item) => item.includes(focusedValue))
        .slice(0, 25)
        .map((item) => ({ name: item, value: item }));
      await interaction.respond(suggestions);
      return;
    }

    if (focused.name === 'project') {
      const projects = asRecordArray(await this.requireContext().listProjectsForUser(runtime.ownerUserId));
      const suggestions = projects
        .map((project) => ({
          id: normalizeOptionalString(project.id) ?? '',
          name: normalizeOptionalString(project.name) ?? '',
        }))
        .filter((item) => item.id.length > 0)
        .map((item) => ({
          name: item.name.length > 0 ? `${item.name} (${item.id})` : item.id,
          value: item.id,
        }))
        .filter(
          (item) =>
            item.name.toLowerCase().includes(focusedValue) || item.value.toLowerCase().includes(focusedValue),
        )
        .slice(0, 25);
      await interaction.respond(suggestions);
      return;
    }

    if (focused.name === 'session' && (subcommand === 'bind' || subcommand === 'info' || subcommand === 'history' || subcommand === 'change')) {
      const projectRef = normalizeOptionalString(interaction.options.getString('project'));
      const project = projectRef
        ? await this.resolveProjectByRef(runtime.ownerUserId, projectRef)
        : await this.resolveBoundProjectForInteraction(
            runtime,
            interaction as unknown as ChatInputCommandInteraction,
          );
      if (!project) {
        await interaction.respond([]);
        return;
      }
      const projectId = readRequiredId(project, 'project');
      const sessions = asRecordArray(await this.requireContext().listSessionsForProject(runtime.ownerUserId, projectId));
      const suggestions = sessions
        .map((session) => ({
          id: normalizeOptionalString(session.id) ?? '',
          title: normalizeOptionalString(session.title) ?? '',
        }))
        .filter((item) => item.id.length > 0)
        .map((item) => ({
          name: item.title.length > 0 ? `${item.title} (${item.id})` : item.id,
          value: item.id,
        }))
        .filter(
          (item) =>
            item.name.toLowerCase().includes(focusedValue) || item.value.toLowerCase().includes(focusedValue),
        )
        .slice(0, 25);
      await interaction.respond(suggestions);
      return;
    }

    await interaction.respond([]);
  }

  private async handleFsAutocomplete(runtime: DiscordRuntime, interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName !== DISCORD_FS_COMMAND) {
      await interaction.respond([]);
      return;
    }
    const subcommand = interaction.options.getSubcommand(false);
    if (subcommand !== 'get' && subcommand !== 'ls' && subcommand !== 'tree') {
      await interaction.respond([]);
      return;
    }
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'path') {
      await interaction.respond([]);
      return;
    }
    const target = resolveBindingTargetFromAutocompleteInteraction(interaction);
    if (!target.bindingChannelId) {
      await interaction.respond([]);
      return;
    }
    const sessionId = findSessionIdByTarget(runtime.config, target.bindingChannelId, target.bindingThreadId);
    if (!sessionId) {
      await interaction.respond([]);
      return;
    }

    const sessionHistory = await this.requireContext().getSessionHistoryForUser(runtime.ownerUserId, sessionId);
    const historyRecord = asRecord(sessionHistory) ?? {};
    const sessionRecord = asRecord(historyRecord.session);
    if (!sessionRecord) {
      await interaction.respond([]);
      return;
    }
    const prefix = String(focused.value ?? '');
    const workspace = await this.resolveSessionWorkspaceForFs(runtime, sessionRecord);
    if (!workspace && !isExplicitAbsolutePathInput(prefix)) {
      await interaction.respond([]);
      return;
    }
    const directoriesOnly = subcommand === 'ls' || subcommand === 'tree';
    const suggestions = await this.suggestFsPathsForWorkspace(workspace, prefix, {
      directoriesOnly,
    });
    await interaction.respond(
      suggestions
        .filter((item) => item.length > 0 && item.length <= 100)
        .slice(0, 25)
        .map((item) => ({
          name: item,
          value: item,
        })),
    );
  }

  private async suggestFsPathsForWorkspace(
    workspace: string | null,
    prefixRaw: string,
    options?: { directoriesOnly?: boolean },
  ): Promise<string[]> {
    const workspaceAbs = workspace ? path.resolve(workspace.trim()) : null;
    const prefix = prefixRaw.trim();
    const isAbsolutePrefix = isExplicitAbsolutePathInput(prefix);
    const hasTrailingSeparator = /[\\/]$/.test(prefixRaw);

    let scanRootCandidate: string;
    let namePrefix = '';
    let absoluteInputCandidate: string | null = null;
    let candidateDisplayPath: string | null = null;
    if (isAbsolutePrefix || !workspaceAbs) {
      const absoluteInput = path.resolve(expandHomeToken(prefix || '/'));
      absoluteInputCandidate = absoluteInput;
      candidateDisplayPath = absoluteInput.split(path.sep).join('/');
      if (prefix.length === 0 || hasTrailingSeparator) {
        scanRootCandidate = absoluteInput;
      } else {
        scanRootCandidate = path.dirname(absoluteInput);
        namePrefix = path.basename(absoluteInput).toLowerCase();
      }
    } else {
      scanRootCandidate = workspaceAbs;
      if (prefix.length > 0) {
        const absoluteInput = path.resolve(workspaceAbs, prefix);
        absoluteInputCandidate = absoluteInput;
        const candidateRelative = path.relative(workspaceAbs, absoluteInput).split(path.sep).join('/');
        candidateDisplayPath = candidateRelative && !candidateRelative.startsWith('..') ? candidateRelative : null;
        if (hasTrailingSeparator) {
          scanRootCandidate = absoluteInput;
        } else {
          scanRootCandidate = path.dirname(absoluteInput);
          namePrefix = path.basename(absoluteInput).toLowerCase();
        }
      }
      const safeScanRoot = resolveFsPathWithinWorkspace(workspaceAbs, scanRootCandidate);
      if (!safeScanRoot) {
        return [];
      }
      scanRootCandidate = safeScanRoot;
    }
    const entries = await this.requireContext()
      .listWorkspaceTree({
        path: scanRootCandidate,
        limit: 200,
        includeHidden: true,
      })
      .catch(() => [] as Array<{ name: string; path: string; isDirectory: boolean }>);

    const suggestions = entries
      .filter((entry) => entry.name.toLowerCase().startsWith(namePrefix))
      .filter((entry) => !options?.directoriesOnly || entry.isDirectory)
      .map((entry) => {
        if (isAbsolutePrefix || !workspaceAbs) {
          const absolute = path.resolve(entry.path).split(path.sep).join('/');
          if (!absolute.startsWith('/')) {
            return null;
          }
          return entry.isDirectory ? `${absolute}/` : absolute;
        }
        const relative = path.relative(workspaceAbs, entry.path).split(path.sep).join('/');
        if (!relative || relative.startsWith('..')) {
          return null;
        }
        return entry.isDirectory ? `${relative}/` : relative;
      })
      .filter((entry): entry is string => !!entry)
      .slice(0, 25);

    if (hasTrailingSeparator || !absoluteInputCandidate || !candidateDisplayPath) {
      return suggestions;
    }

    const candidateDirectory = candidateDisplayPath.endsWith('/') ? candidateDisplayPath : `${candidateDisplayPath}/`;
    if (!suggestions.includes(candidateDirectory)) {
      return suggestions;
    }

    const childEntries = await this.requireContext()
      .listWorkspaceTree({
        path: absoluteInputCandidate,
        limit: 200,
        includeHidden: true,
      })
      .catch(() => [] as Array<{ name: string; path: string; isDirectory: boolean }>);
    const childSuggestions = childEntries
      .filter((entry) => !options?.directoriesOnly || entry.isDirectory)
      .map((entry) => {
        if (isAbsolutePrefix || !workspaceAbs) {
          const absolute = path.resolve(entry.path).split(path.sep).join('/');
          if (!absolute.startsWith('/')) {
            return null;
          }
          return entry.isDirectory ? `${absolute}/` : absolute;
        }
        const relative = path.relative(workspaceAbs, entry.path).split(path.sep).join('/');
        if (!relative || relative.startsWith('..')) {
          return null;
        }
        return entry.isDirectory ? `${relative}/` : relative;
      })
      .filter((entry): entry is string => !!entry);

    const merged = new Set<string>(suggestions);
    for (const item of childSuggestions) {
      merged.add(item);
    }
    return [...merged].slice(0, 25);
  }

  private async resolveSessionByRef(
    userId: string,
    projectId: string,
    sessionRef: string,
  ): Promise<Record<string, unknown> | null> {
    const normalizedRef = sessionRef.trim();
    if (!normalizedRef) {
      return null;
    }
    const byId = await this.readSessionForOwner(userId, normalizedRef);
    if (byId && byId.projectId === projectId) {
      const history = await this.requireContext().getSessionHistoryForUser(userId, byId.sessionId);
      const root = asRecord(history);
      const session = asRecord(root?.session);
      if (session) {
        return session;
      }
      return { id: byId.sessionId, projectId: byId.projectId };
    }
    const sessions = asRecordArray(await this.requireContext().listSessionsForProject(userId, projectId));
    const byTitle = sessions.find((session) => normalizeOptionalString(session.title) === normalizedRef) ?? null;
    return byTitle;
  }

  private async resolveProjectByRef(userId: string, projectRef: string): Promise<Record<string, unknown> | null> {
    const byId = await this.tryGetProjectById(userId, projectRef);
    if (byId) {
      return byId;
    }
    const projects = asRecordArray(await this.requireContext().listProjectsForUser(userId));
    const byName = projects.find((project) => normalizeOptionalString(project.name) === projectRef) ?? null;
    return byName;
  }

  private async tryGetProjectById(userId: string, projectId: string): Promise<Record<string, unknown> | null> {
    try {
      const project = await this.requireContext().getProjectForUser(userId, projectId);
      return asRecord(project);
    } catch {
      return null;
    }
  }

  private async getModelAutocompleteOptions(backend: string | null): Promise<string[]> {
    const cacheKey = backend ?? '__all__';
    const cached = this.modelAutocompleteCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.models;
    }

    const models = await withTimeout(
      this.requireContext().listModels({ backend }),
      AUTOCOMPLETE_MODEL_TIMEOUT_MS,
      'model autocomplete timeout',
    ).catch(() => [] as Awaited<ReturnType<ChannelPluginContext['listModels']>>);
    const uniqueModels = [...new Set(models.map((item) => item.model).filter((item) => item.trim().length > 0))];
    this.modelAutocompleteCache.set(cacheKey, {
      expiresAt: now + AUTOCOMPLETE_MODEL_CACHE_TTL_MS,
      models: uniqueModels,
    });
    return uniqueModels;
  }

  private validateCommandNotInThread(interaction: ChatInputCommandInteraction): string | null {
    const channelType = interaction.channel?.type;
    if (
      channelType === ChannelType.PublicThread ||
      channelType === ChannelType.PrivateThread ||
      channelType === ChannelType.AnnouncementThread
    ) {
      return 'This command is not allowed in threads.';
    }
    return null;
  }

  private async handleMessage(runtime: DiscordRuntime, message: Message): Promise<void> {
    if (runtime.stopped) {
      return;
    }

    if (!isSupportedDiscordInboundMessageType(message.type)) {
      return;
    }

    if (message.author?.bot && (runtime.config.message?.ignoreBotMessages ?? true)) {
      return;
    }

    if (!runtime.config.trigger?.allowDM && message.channel.type === ChannelType.DM) {
      return;
    }

    if (!isAllowedByList(message.author?.id ?? '', runtime.config.trigger?.allowedUsers)) {
      return;
    }

    if (message.guildId && !isAllowedByList(message.guildId, runtime.config.trigger?.allowedGuilds)) {
      return;
    }

    if (message.guildId && !isAllowedByList(message.channelId ?? '', runtime.config.trigger?.allowedChannels)) {
      return;
    }

    if (runtime.config.trigger?.requireMention) {
      const botUserId = runtime.client.user?.id;
      if (!botUserId || !message.mentions.users.has(botUserId)) {
        return;
      }
    }

    const inputText = (message.content ?? '').trim();
    const attachments = extractInboundAttachmentsFromMessage(message);
    if (!inputText && attachments.length === 0) {
      return;
    }

    const { bindingChannelId, bindingThreadId, channelName } = resolveBindingTargetFromMessage(message);
    await this.enqueueInboundTurn(runtime, {
      content: inputText,
      providerMessageId: message.id,
      actionChannelId: message.channelId,
      bindingChannelId,
      bindingThreadId,
      channelName,
      guildId: message.guildId ?? null,
      sourceMessage: message,
      attachments,
    });
  }

  private async handleRawMessageCreate(runtime: DiscordRuntime, payload: Record<string, unknown>): Promise<void> {
    if (runtime.stopped) {
      return;
    }

    const messageId = typeof payload.id === 'string' ? payload.id : '';

    const channelId = typeof payload.channel_id === 'string' ? payload.channel_id : '';
    if (!channelId) {
      return;
    }

    const guildId = typeof payload.guild_id === 'string' ? payload.guild_id : null;
    const messageType = typeof payload.type === 'number' ? payload.type : MessageType.Default;
    const content = typeof payload.content === 'string' ? payload.content : '';
    const author = (payload.author ?? null) as Record<string, unknown> | null;
    const authorId = author && typeof author.id === 'string' ? author.id : '';
    const authorIsBot = author && typeof author.bot === 'boolean' ? author.bot : false;

    if (!isSupportedDiscordInboundMessageType(messageType)) {
      return;
    }

    if (authorIsBot && (runtime.config.message?.ignoreBotMessages ?? true)) {
      return;
    }

    if (!runtime.config.trigger?.allowDM && !guildId) {
      return;
    }

    if (!isAllowedByList(authorId, runtime.config.trigger?.allowedUsers)) {
      return;
    }

    if (guildId && !isAllowedByList(guildId, runtime.config.trigger?.allowedGuilds)) {
      return;
    }

    if (guildId && !isAllowedByList(channelId, runtime.config.trigger?.allowedChannels)) {
      return;
    }

    if (runtime.config.trigger?.requireMention) {
      const botUserId = runtime.client.user?.id;
      const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
      const mentioned = mentions.some((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return false;
        }
        const mentionId = (entry as Record<string, unknown>).id;
        return typeof mentionId === 'string' && mentionId === botUserId;
      });
      if (!botUserId || !mentioned) {
        return;
      }
    }

    const inputText = content.trim();
    const attachments = extractInboundAttachmentsFromRawPayload(payload);
    if (!inputText && attachments.length === 0) {
      return;
    }

    try {
      const channel = await runtime.client.channels.fetch(channelId);
      if (!channel?.isSendable()) {
        return;
      }

      const { bindingChannelId, bindingThreadId, channelName } = resolveBindingTargetFromChannel(channel);
      await this.enqueueInboundTurn(runtime, {
        content: inputText,
        providerMessageId: messageId || null,
        actionChannelId: channelId,
        bindingChannelId,
        bindingThreadId,
        channelName,
        guildId,
        sourceMessage: null,
        attachments,
      });
    } catch (error: unknown) {
      throw error;
    }
  }

  private async applyTriggerMessageAction(
    runtime: DiscordRuntime,
    channelId: string,
    messageId: string,
    effect: {
      action:
        | 'watching'
        | 'active'
        | 'approval_pending'
        | 'final_success'
        | 'final_cancel'
        | 'final_error';
      onlyIfTracked: boolean;
      skipOutboundText: boolean;
    },
  ): Promise<void> {
    const key = `${channelId}:${messageId}`;
    const current = runtime.triggerMessageActions.get(key);
    if (effect.onlyIfTracked && !current) {
      return;
    }
    const currentEffect = runtime.triggerMessageEffects.get(key);
    if (currentEffect === effect.action) {
      return;
    }
    if (currentEffect && isFinalDiscordAction(currentEffect) && !isFinalDiscordAction(effect.action)) {
      return;
    }

    try {
      const channel = await runtime.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) {
        return;
      }
      const targetMessage = await channel.messages.fetch(messageId);
      const botUserId = runtime.client.user?.id;
      if (!botUserId) {
        return;
      }
      const refreshed = await targetMessage.fetch().catch(() => targetMessage);
      const desired = resolveDesiredActionEmojis(effect.action);
      const desiredKeys = new Set(desired.map((emoji) => normalizeEmojiName(emoji)));
      const existingByKey = new Map<string, { users: { remove: (userId: string) => Promise<unknown> } }>();

      for (const reaction of refreshed.reactions.cache.values()) {
        const emojiName = reaction.emoji.name ?? '';
        if (!isManagedActionEmoji(emojiName)) {
          continue;
        }
        existingByKey.set(normalizeEmojiName(emojiName), reaction);
      }

      // Add missing actions first.
      for (const emoji of desired) {
        const normalized = normalizeEmojiName(emoji);
        if (existingByKey.has(normalized)) {
          continue;
        }
        await targetMessage.react(emoji).catch(() => undefined);
      }

      // Then remove actions that are no longer needed.
      for (const [normalized, reaction] of existingByKey.entries()) {
        if (desiredKeys.has(normalized)) {
          continue;
        }
        await reaction.users.remove(botUserId).catch(() => undefined);
      }

    } catch {
      // ignore reaction failures; chat flow should continue.
    }
    runtime.triggerMessageActions.set(key, resolveActionTrackingState(effect.action));
    runtime.triggerMessageEffects.set(key, effect.action);
    await this.syncTypingIndicatorForAction(runtime, key, channelId, effect.action);
  }

  private async syncTypingIndicatorForAction(
    runtime: DiscordRuntime,
    messageKey: string,
    channelId: string,
    action: 'watching' | 'active' | 'approval_pending' | 'final_success' | 'final_cancel' | 'final_error',
  ): Promise<void> {
    const isFinal = action === 'final_success' || action === 'final_cancel' || action === 'final_error';
    const previousChannelId = runtime.typingByMessageKey.get(messageKey) ?? null;
    if (isFinal) {
      runtime.typingByMessageKey.delete(messageKey);
      if (previousChannelId) {
        this.stopTypingHeartbeatIfIdle(runtime, previousChannelId);
      }
      return;
    }

    runtime.typingByMessageKey.set(messageKey, channelId);
    if (previousChannelId && previousChannelId !== channelId) {
      this.stopTypingHeartbeatIfIdle(runtime, previousChannelId);
    }
    await this.ensureTypingHeartbeat(runtime, channelId);
  }

  private async ensureTypingHeartbeat(runtime: DiscordRuntime, channelId: string): Promise<void> {
    if (runtime.stopped) {
      return;
    }
    await this.sendTypingPulse(runtime, channelId);
    if (runtime.typingIntervals.has(channelId)) {
      return;
    }
    const interval = setInterval(() => {
      void this.sendTypingPulse(runtime, channelId);
    }, DISCORD_TYPING_HEARTBEAT_MS);
    runtime.typingIntervals.set(channelId, interval);
  }

  private stopTypingHeartbeatIfIdle(runtime: DiscordRuntime, channelId: string): void {
    for (const activeChannelId of runtime.typingByMessageKey.values()) {
      if (activeChannelId === channelId) {
        return;
      }
    }
    const interval = runtime.typingIntervals.get(channelId);
    if (!interval) {
      return;
    }
    clearInterval(interval);
    runtime.typingIntervals.delete(channelId);
  }

  private async sendTypingPulse(runtime: DiscordRuntime, channelId: string): Promise<void> {
    if (runtime.stopped) {
      this.stopTypingHeartbeatIfIdle(runtime, channelId);
      return;
    }
    let active = false;
    for (const activeChannelId of runtime.typingByMessageKey.values()) {
      if (activeChannelId === channelId) {
        active = true;
        break;
      }
    }
    if (!active) {
      this.stopTypingHeartbeatIfIdle(runtime, channelId);
      return;
    }

    try {
      const channel = await runtime.client.channels.fetch(channelId);
      if (!channel || !('sendTyping' in channel) || typeof channel.sendTyping !== 'function') {
        return;
      }
      await channel.sendTyping();
    } catch {
      // ignore typing indicator failures; chat flow should continue.
    }
  }

  private async sendDiscordOutboundChunk(
    runtime: DiscordRuntime,
    channel: { send: (options: Record<string, unknown>) => Promise<{ id: string }> },
    content: string,
    triggerMessageId: string | null,
    context: PluginDispatchContext,
  ): Promise<{ id: string }> {
    const base: Record<string, unknown> = {
      content,
      allowedMentions: buildAllowedMentions(runtime.config.message?.allowEveryoneMention ?? false),
    };
    if (!shouldUseDiscordReplySendStyle(runtime.config, context, triggerMessageId)) {
      return channel.send(base);
    }
    try {
      return await channel.send({
        ...base,
        reply: {
          messageReference: triggerMessageId,
          failIfNotExists: false,
        },
      });
    } catch {
      return channel.send(base);
    }
  }

  private async enqueueInboundTurn(
    runtime: DiscordRuntime,
    input: {
      content: string;
      providerMessageId: string | null;
      actionChannelId: string;
      bindingChannelId: string;
      bindingThreadId: string | null;
      channelName: string;
      guildId: string | null;
      sourceMessage: Message | null;
      attachments: DiscordInboundAttachment[];
    },
  ): Promise<void> {
    const resolved = await this.ensureBindingForInbound(runtime, {
      channelId: input.bindingChannelId,
      threadId: input.bindingThreadId,
      channelName: input.channelName,
      guildId: input.guildId,
    });
    const attachmentUpload = await this.uploadInboundAttachmentsToSessionWorkspace(
      runtime,
      resolved.sessionId,
      input.attachments,
    );
    if (attachmentUpload.failedCount > 0) {
      await this.sendAttachmentUploadResultHint(runtime, input.actionChannelId, attachmentUpload);
      return;
    }
    if ((input.content ?? '').trim().length === 0) {
      if (attachmentUpload.mentions.length > 0) {
        await this.sendAttachmentSavedHint(runtime, input.actionChannelId, attachmentUpload.mentions);
      } else if (input.attachments.length > 0) {
        await this.sendAttachmentUploadFailedHint(runtime, input.actionChannelId);
      }
      return;
    }
    const messageContent =
      attachmentUpload.mentions.length > 0
        ? `${attachmentUpload.mentions.join(' ')} ${input.content}`
        : input.content;
    const inboundContent = normalizeInboundContent(
      await this.injectThreadStarterContextIfNeeded({
        runtime,
        content: messageContent,
        sourceMessage: input.sourceMessage,
        threadId: input.bindingThreadId,
        isNewBinding: resolved.isNewBinding,
      }),
      runtime.config.message?.maxInboundLength,
    );
    const unifiedIdentifier = buildDiscordUnifiedIdentifier(runtime.integrationId, input.providerMessageId);

    const activeTurn = await this.readSteerableTurnForSession(runtime.ownerUserId, resolved.sessionId);
    if (activeTurn) {
      if (input.providerMessageId) {
        await this.applyTriggerMessageAction(runtime, input.actionChannelId, input.providerMessageId, {
          action: 'watching',
          onlyIfTracked: false,
          skipOutboundText: true,
        });
      }
      try {
        await this.requireContext().steerTurnForUser(runtime.ownerUserId, activeTurn.turnId, {
          content: inboundContent,
        });
        if (input.providerMessageId) {
          runtime.steerTriggerByTurnId.set(activeTurn.turnId, {
            channelId: input.actionChannelId,
            messageId: input.providerMessageId,
          });
        }
        return;
      } catch {
        if (input.providerMessageId) {
          await this.applyTriggerMessageAction(runtime, input.actionChannelId, input.providerMessageId, {
            action: 'final_error',
            onlyIfTracked: true,
            skipOutboundText: true,
          });
        }
        // Fall through to normal inbound creation if steer raced with terminal state.
      }
    }

    if (input.providerMessageId) {
      void this.applyTriggerMessageAction(runtime, input.actionChannelId, input.providerMessageId, {
        action: 'watching',
        onlyIfTracked: false,
        skipOutboundText: false,
      });
    }

    const created = await this.requireContext().ingestInbound({
      unifiedIdentifier,
      triggerProvider: this.provider,
      triggerIntegrationId: runtime.integrationId,
      providerMessageId: input.providerMessageId ?? undefined,
      projectId: resolved.projectId,
      sessionId: resolved.sessionId,
      content: inboundContent,
      metadata: {
        sourceBinding: {
          provider: this.provider,
          integrationId: runtime.integrationId,
          guid: null,
          channel: input.bindingChannelId,
          thread: input.bindingThreadId,
        },
      },
    });
    if (!created.turnId) {
      throw new Error('Failed to enqueue inbound turn');
    }
  }

  private async uploadInboundAttachmentsToSessionWorkspace(
    runtime: DiscordRuntime,
    sessionId: string,
    attachments: DiscordInboundAttachment[],
  ): Promise<{ mentions: string[]; failedCount: number; successMentions: string[]; failedFiles: string[] }> {
    if (attachments.length === 0) {
      return { mentions: [], failedCount: 0, successMentions: [], failedFiles: [] };
    }
    const workspace = await this.resolveSessionWorkspaceForAttachmentUpload(runtime, sessionId);
    if (!workspace) {
      return {
        mentions: [],
        failedCount: attachments.length,
        successMentions: [],
        failedFiles: attachments.map((item) => item.fileName),
      };
    }

    const mentions: string[] = [];
    const successMentions: string[] = [];
    const failedFiles: string[] = [];
    let failedCount = 0;
    for (const attachment of attachments) {
      if (
        typeof attachment.contentLength === 'number' &&
        Number.isFinite(attachment.contentLength) &&
        attachment.contentLength > WORKSPACE_UPLOAD_MAX_SIZE_BYTES
      ) {
        this.logger.warn(
          `Discord attachment skipped for integration ${runtime.integrationId}, session ${sessionId}: file too large (${attachment.contentLength} bytes)`,
        );
        failedCount += 1;
        failedFiles.push(attachment.fileName);
        continue;
      }
      try {
        const download = await this.downloadAttachment(attachment);
        const multipart = createWorkspaceUploadMultipartBody({
          workspacePath: workspace,
          fileName: attachment.fileName,
          contentType: attachment.contentType ?? 'application/octet-stream',
          content: download.content,
        });
        const uploaded = await this.requireContext().uploadWorkspaceFile({
          body: multipart.body,
          contentType: multipart.contentType,
          contentLength: multipart.contentLength,
        });
        const mentionTarget = normalizeOptionalString(uploaded.relativePath) ?? path.basename(uploaded.path);
        if (mentionTarget) {
          const mention = `@${mentionTarget}`;
          mentions.push(mention);
          successMentions.push(mention);
        }
      } catch (error: unknown) {
        failedCount += 1;
        failedFiles.push(attachment.fileName);
        const message = error instanceof Error ? error.message : 'unknown upload error';
        this.logger.warn(
          `Discord attachment upload failed for integration ${runtime.integrationId}, session ${sessionId}: ${message}`,
        );
      }
    }
    return { mentions, failedCount, successMentions, failedFiles };
  }

  private async resolveSessionWorkspaceForAttachmentUpload(
    runtime: DiscordRuntime,
    sessionId: string,
  ): Promise<string | null> {
    const sessionHistory = await this.requireContext().getSessionHistoryForUser(runtime.ownerUserId, sessionId);
    const historyRecord = asRecord(sessionHistory) ?? {};
    const sessionRecord = asRecord(historyRecord.session);
    if (!sessionRecord) {
      return null;
    }
    return this.resolveSessionWorkspaceForFs(runtime, sessionRecord);
  }

  private async downloadAttachment(
    attachment: DiscordInboundAttachment,
  ): Promise<{ content: Buffer; mimeType: string }> {
    const response = await fetch(attachment.url, {
      method: 'GET',
      dispatcher: this.proxyDispatcher ?? undefined,
    } as RequestInit & { dispatcher?: Dispatcher });
    if (!response.ok) {
      throw new Error(`download failed: ${response.status}`);
    }
    const headerLength = normalizeContentLengthHeader(response.headers.get('content-length'));
    if (headerLength !== null && headerLength > WORKSPACE_UPLOAD_MAX_SIZE_BYTES) {
      throw new Error(`download exceeds upload limit: ${headerLength} bytes`);
    }
    const content = await readResponseBodyWithLimit(response, WORKSPACE_UPLOAD_MAX_SIZE_BYTES);
    const mimeType = response.headers.get('content-type')?.trim() || attachment.contentType || 'application/octet-stream';
    return {
      content,
      mimeType,
    };
  }

  private async sendAttachmentSavedHint(
    runtime: DiscordRuntime,
    channelId: string,
    attachmentMentions: string[],
  ): Promise<void> {
    try {
      const channel = await runtime.client.channels.fetch(channelId);
      if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
        return;
      }
      const lines = attachmentMentions.map((mention) => {
        const savedPath = mention.slice(1);
        return `Saved to \`${savedPath}\`, use \`${mention}\` to reference the file in message.`;
      });
      await channel.send({
        content: limitDiscordMessageLength(lines.join('\n')),
        allowedMentions: { parse: [] },
      });
    } catch {
      // ignore hint-send failures; upload has already completed.
    }
  }

  private async sendAttachmentUploadFailedHint(runtime: DiscordRuntime, channelId: string): Promise<void> {
    try {
      const channel = await runtime.client.channels.fetch(channelId);
      if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
        return;
      }
      await channel.send({
        content:
          'Failed to save attachment. Check network and file size (max 20MB), then retry.',
        allowedMentions: { parse: [] },
      });
    } catch {
      // ignore hint-send failures; upload has already failed.
    }
  }

  private async sendAttachmentUploadResultHint(
    runtime: DiscordRuntime,
    channelId: string,
    result: { successMentions: string[]; failedFiles: string[]; failedCount: number },
  ): Promise<void> {
    try {
      const channel = await runtime.client.channels.fetch(channelId);
      if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
        return;
      }
      const lines: string[] = [];
      if (result.successMentions.length > 0) {
        lines.push('Saved:');
        for (const mention of result.successMentions) {
          const savedPath = mention.slice(1);
          lines.push(`- \`${savedPath}\` (reference: \`${mention}\`)`);
        }
      }
      if (result.failedFiles.length > 0) {
        lines.push('Failed:');
        for (const fileName of result.failedFiles) {
          lines.push(`- \`${fileName}\``);
        }
        lines.push('Turn not started because one or more attachments failed to upload.');
      }
      await channel.send({
        content: limitDiscordMessageLength(lines.join('\n') || 'Attachment upload failed.'),
        allowedMentions: { parse: [] },
      });
    } catch {
      // ignore hint-send failures; upload has already failed.
    }
  }

  private async readSteerableTurnForSession(
    userId: string,
    sessionId: string,
  ): Promise<{ turnId: string; status: string } | null> {
    try {
      const history = await this.requireContext().getSessionHistoryForUser(userId, sessionId);
      const root = asRecord(history);
      const activeTurnId = normalizeOptionalString(root?.activeTurnId);
      const activeTurnStatus = normalizeOptionalString(root?.activeTurnStatus);
      if (!activeTurnId || !activeTurnStatus) {
        return null;
      }
      if (activeTurnStatus !== 'queued' && activeTurnStatus !== 'running') {
        return null;
      }
      return {
        turnId: activeTurnId,
        status: activeTurnStatus,
      };
    } catch {
      return null;
    }
  }

  private async ensureBindingForInbound(
    runtime: DiscordRuntime,
    input: {
      channelId: string;
      threadId: string | null;
      channelName: string;
      guildId: string | null;
    },
  ): Promise<{ projectId: string; sessionId: string; isNewBinding: boolean }> {
    const existingSessionId = findSessionIdByTarget(runtime.config, input.channelId, input.threadId);
    if (existingSessionId) {
      const existingSession = await this.readSessionForOwner(runtime.ownerUserId, existingSessionId);
      if (existingSession) {
        return {
          projectId: existingSession.projectId,
          sessionId: existingSession.sessionId,
          isNewBinding: false,
        };
      }
    }

    let projectId = findProjectIdByChannel(runtime.config, input.channelId) ?? null;
    if (projectId) {
      const exists = await this.projectExistsForOwner(runtime.ownerUserId, projectId);
      if (!exists) {
        projectId = null;
      }
    }

    if (!projectId) {
      const createdProject = await this.requireContext().createProjectForUser(runtime.ownerUserId, {
        name: buildDiscordProjectName(input.channelName, input.channelId),
      });
      projectId = readRequiredId(createdProject, 'project');
    }

    const createdSession = await this.requireContext().createSessionForProject(runtime.ownerUserId, projectId, {
      title: buildDiscordSessionTitle(input.channelName, input.threadId),
    });
    const sessionId = readRequiredId(createdSession, 'session');

    const nextConfig = upsertDiscordBindings(runtime.config, {
      channelId: input.channelId,
      threadId: input.threadId,
      guildId: input.guildId,
      projectId,
      sessionId,
    });
    await this.persistRuntimeConfig(runtime, nextConfig);

    return {
      projectId,
      sessionId,
      isNewBinding: true,
    };
  }

  private async injectThreadStarterContextIfNeeded(input: {
    runtime: DiscordRuntime;
    content: string;
    sourceMessage: Message | null;
    threadId: string | null;
    isNewBinding: boolean;
  }): Promise<string> {
    if (!input.isNewBinding || !input.threadId || !input.sourceMessage) {
      return input.content;
    }
    const starterContent = await this.readThreadStarterContent(input.runtime, input.sourceMessage);
    if (!starterContent) {
      return input.content;
    }
    return buildThreadStarterInjectedInboundContent(starterContent, input.content);
  }

  private async readThreadStarterContent(runtime: DiscordRuntime, message: Message): Promise<string | null> {
    const channel = message.channel as unknown as Record<string, unknown>;
    const isThread = typeof channel.isThread === 'function' ? (channel.isThread as () => boolean)() : false;
    if (!isThread) {
      return null;
    }
    const threadChannelId = normalizeOptionalString((channel as Record<string, unknown>).id) ?? message.channelId;
    const parentChannelId = normalizeOptionalString((channel as Record<string, unknown>).parentId);
    const fetchStarterMessage =
      typeof channel.fetchStarterMessage === 'function'
        ? (channel.fetchStarterMessage as () => Promise<unknown>)
        : null;
    const starter = fetchStarterMessage ? await fetchStarterMessage().catch(() => null) : null;
    const starterRecord = asRecord(starter);
    const directStarterContent = normalizeOptionalString(starterRecord?.content);
    if (directStarterContent) {
      return trimToLength(directStarterContent, THREAD_STARTER_CONTEXT_MAX_LENGTH);
    }

    const parentMessageCandidateIds: string[] = [];
    if (threadChannelId) {
      parentMessageCandidateIds.push(threadChannelId);
    }
    const reference = asRecord(starterRecord?.reference);
    const referenceMessageId =
      normalizeOptionalString(reference?.messageId) ?? normalizeOptionalString(reference?.message_id);
    if (referenceMessageId) {
      parentMessageCandidateIds.push(referenceMessageId);
    }
    if (!parentChannelId || parentMessageCandidateIds.length === 0) {
      return null;
    }

    const parentChannel = await runtime.client.channels.fetch(parentChannelId).catch(() => null);
    if (!parentChannel || !('messages' in parentChannel)) {
      return null;
    }
    for (const candidateId of [...new Set(parentMessageCandidateIds)]) {
      const referenced = await parentChannel.messages.fetch(candidateId).catch(() => null);
      const referencedRecord = asRecord(referenced);
      const referencedContent = normalizeOptionalString(referencedRecord?.content);
      if (referencedContent) {
        return trimToLength(referencedContent, THREAD_STARTER_CONTEXT_MAX_LENGTH);
      }
    }
    return null;
  }

  private async persistRuntimeConfig(runtime: DiscordRuntime, nextConfig: DiscordPluginConfig): Promise<void> {
    await this.requireContext().updateIntegrationPluginConfigForUser(
      runtime.ownerUserId,
      runtime.integrationId,
      nextConfig as Record<string, unknown>,
    );
    runtime.config = nextConfig;
  }

  private async readSessionForOwner(
    userId: string,
    sessionId: string,
  ): Promise<{ sessionId: string; projectId: string } | null> {
    try {
      const history = await this.requireContext().getSessionHistoryForUser(userId, sessionId);
      const root = asRecord(history);
      const session = asRecord(root?.session);
      const resolvedSessionId = session ? normalizeOptionalString(session.id) : null;
      const projectId = session ? normalizeOptionalString(session.projectId) : null;
      if (!resolvedSessionId || !projectId) {
        return null;
      }
      return {
        sessionId: resolvedSessionId,
        projectId,
      };
    } catch {
      return null;
    }
  }

  private async projectExistsForOwner(userId: string, projectId: string): Promise<boolean> {
    try {
      await this.requireContext().getProjectForUser(userId, projectId);
      return true;
    } catch {
      return false;
    }
  }

  private isMessageHandledOrInFlight(runtime: DiscordRuntime, messageId: string): boolean {
    if (!messageId) {
      return false;
    }
    if (runtime.processingMessageIds.has(messageId)) {
      return true;
    }
    return this.wasMessageProcessed(runtime, messageId);
  }

  private tryBeginMessageProcessing(runtime: DiscordRuntime, messageId: string): boolean {
    if (!messageId) {
      return true;
    }
    if (this.isMessageHandledOrInFlight(runtime, messageId)) {
      return false;
    }
    runtime.processingMessageIds.add(messageId);
    return true;
  }

  private finishMessageProcessing(runtime: DiscordRuntime, messageId: string): void {
    if (!messageId) {
      return;
    }
    runtime.processingMessageIds.delete(messageId);
  }

  private wasMessageProcessed(runtime: DiscordRuntime, messageId: string): boolean {
    this.compactProcessedMessageIds(runtime);
    return runtime.processedMessageIds.has(messageId);
  }

  private markMessageProcessed(runtime: DiscordRuntime, messageId: string): void {
    if (!messageId) {
      return;
    }
    runtime.processedMessageIds.set(messageId, Date.now());
    this.compactProcessedMessageIds(runtime);
  }

  private compactProcessedMessageIds(runtime: DiscordRuntime): void {
    const now = Date.now();
    for (const [messageId, processedAt] of runtime.processedMessageIds) {
      if (now - processedAt > PROCESSED_MESSAGE_TTL_MS) {
        runtime.processedMessageIds.delete(messageId);
      }
    }
    if (runtime.processedMessageIds.size <= PROCESSED_MESSAGE_MAX) {
      return;
    }
    const overflow = runtime.processedMessageIds.size - PROCESSED_MESSAGE_MAX;
    let removed = 0;
    for (const messageId of runtime.processedMessageIds.keys()) {
      runtime.processedMessageIds.delete(messageId);
      removed += 1;
      if (removed >= overflow) {
        break;
      }
    }
  }

  private requireContext(): ChannelPluginContext {
    if (!this.context) {
      throw new Error('Discord plugin has not been booted');
    }
    return this.context;
  }
}

function readBotToken(credentials: unknown): string | null {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    return null;
  }
  const value = (credentials as Record<string, unknown>).botToken;
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readDiscordPluginConfig(config: unknown): DiscordPluginConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {};
  }
  return config as DiscordPluginConfig;
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function normalizeMaxInboundLength(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return 2000;
  }
  const normalized = Math.floor(input);
  if (normalized <= 0) {
    return 2000;
  }
  return Math.min(normalized, 10_000);
}

function normalizeInboundContent(input: string, maxInboundLengthRaw: unknown): string {
  const maxInboundLength = normalizeMaxInboundLength(maxInboundLengthRaw);
  return input.length > maxInboundLength ? input.slice(0, maxInboundLength) : input;
}

function buildThreadStarterInjectedInboundContent(starterContent: string, userContent: string): string {
  return [
    'Thread starter context:',
    '```',
    starterContent,
    '```',
    '',
    'User message:',
    userContent.trim(),
  ].join('\n');
}

function trimToLength(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength - 1)}…`;
}

function normalizeJsonRecordForDisplay(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return record ?? {};
}

function isAllowedByList(id: string, rawList: unknown): boolean {
  const list = normalizeStringList(rawList);
  if (list.length === 0) {
    return true;
  }
  return list.includes(id);
}

function resolveBindingTargetFromInteraction(interaction: ChatInputCommandInteraction): {
  bindingChannelId: string;
  bindingThreadId: string | null;
  guildId: string | null;
} {
  const channel = interaction.channel;
  if (!channel) {
    return { bindingChannelId: '', bindingThreadId: null, guildId: interaction.guildId ?? null };
  }
  const channelRecord = channel as unknown as Record<string, unknown>;
  const channelId = normalizeOptionalString(channelRecord.id) ?? '';
  const parentId = normalizeOptionalString(channelRecord.parentId);
  const type = channelRecord.type;
  const isThread =
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread;
  return {
    bindingChannelId: isThread ? (parentId ?? channelId) : channelId,
    bindingThreadId: isThread ? channelId : null,
    guildId: interaction.guildId ?? null,
  };
}

function resolveBindingTargetFromAutocompleteInteraction(interaction: AutocompleteInteraction): {
  bindingChannelId: string;
  bindingThreadId: string | null;
} {
  const fallbackChannelId = normalizeOptionalString((interaction as unknown as Record<string, unknown>).channelId) ?? '';
  const channel = interaction.channel;
  if (!channel) {
    return { bindingChannelId: fallbackChannelId, bindingThreadId: null };
  }
  const channelRecord = channel as unknown as Record<string, unknown>;
  const channelId = normalizeOptionalString(channelRecord.id) ?? '';
  const parentId = normalizeOptionalString(channelRecord.parentId);
  const type = channelRecord.type;
  const isThread =
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread;
  return {
    bindingChannelId: isThread ? (parentId ?? channelId) : channelId,
    bindingThreadId: isThread ? channelId : null,
  };
}

function buildDiscordCommandDefinitions(): ApplicationCommandDataResolvable[] {
  return [
    ...buildDiscordProjectCommandDefinitions(),
    ...buildDiscordSessionCommandDefinitions(),
    ...buildDiscordCancelCommandDefinitions(),
    ...buildDiscordFsCommandDefinitions(),
  ];
}

function buildDiscordProjectCommandDefinitions(): ApplicationCommandDataResolvable[] {
  return [
    {
      name: DISCORD_PROJECT_COMMAND,
      description: 'Project operations',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'list',
          description: 'List all projects',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'info',
          description: 'Get project details',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'project',
              description: 'Project id (or exact project name). Omit to use current binding',
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'create',
          description: 'Create project and bind this channel',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'name',
              description: 'Project name',
              required: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'working_dir',
              description: 'Project working directory',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'backend',
              description: 'Backend (for example codex, claude)',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'model',
              description: 'Default model',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'execution_mode',
              description: 'Default execution mode',
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'bind',
          description: 'Bind this channel to existing project',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'project',
              description: 'Project id (or exact project name)',
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'change',
          description: 'Change bound project settings and rebind this channel',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'working_dir',
              description: 'Project working directory',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'model',
              description: 'Default model',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'execution_mode',
              description: 'Default execution mode',
              required: false,
              choices: EXECUTION_MODE_CHOICES.map((value) => ({
                name: value,
                value,
              })),
            },
          ],
        },
      ],
    },
  ];
}

function buildDiscordSessionCommandDefinitions(): ApplicationCommandDataResolvable[] {
  return [
    {
      name: DISCORD_SESSION_COMMAND,
      description: 'Session operations',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'list',
          description: 'List sessions by project',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'project',
              description: 'Project id (or exact project name). Omit to use current binding',
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'create',
          description: 'Create a new session and bind this target',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'title',
              description: 'Session title',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'project',
              description: 'Base project id (or exact project name). Omit to use current binding',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'working_dir',
              description: 'Override working directory',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'backend',
              description: 'Override backend (for example codex, claude)',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'model',
              description: 'Override model (inherits from project when omitted)',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'execution_mode',
              description: 'Override execution mode (inherits from project when omitted)',
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'bind',
          description: 'Bind this target to an existing session',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'project',
              description: 'Project id (or exact project name). Omit to use current binding',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'session',
              description: 'Session id (or exact session title)',
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'info',
          description: 'Get session details',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'project',
              description: 'Project id (or exact project name). Omit to use current binding',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'session',
              description: 'Session id (or exact session title). Omit to use current binding',
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'history',
          description: 'Show recent messages for a session',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'project',
              description: 'Project id (or exact project name). Omit to use current binding',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'session',
              description: 'Session id (or exact session title). Omit to use current binding',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.Integer,
              name: 'limit',
              description: 'How many recent messages to show (default 6)',
              required: false,
              min_value: 1,
              max_value: 50,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'change',
          description: 'Update session title/model/execution mode',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'project',
              description: 'Project id (or exact project name). Omit to use current binding',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'session',
              description: 'Session id (or exact session title). Omit to use current binding',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'title',
              description: 'Updated session title',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'model',
              description: 'Updated default model',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'execution_mode',
              description: 'Updated execution mode',
              required: false,
              autocomplete: true,
            },
          ],
        },
      ],
    },
  ];
}

function buildDiscordCancelCommandDefinitions(): ApplicationCommandDataResolvable[] {
  return [
    {
      name: DISCORD_CANCEL_COMMAND,
      description: 'Cancel the active turn for current bound session',
    },
  ];
}

function buildDiscordFsCommandDefinitions(): ApplicationCommandDataResolvable[] {
  return [
    {
      name: DISCORD_FS_COMMAND,
      description: 'Workspace file operations',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'get',
          description: 'Send a file from current session workspace',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'path',
              description: 'File path relative to session workspace',
              required: true,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'ls',
          description: 'List directory entries',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'path',
              description: 'Directory path (default: current workspace root)',
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'tree',
          description: 'Show directory tree (depth 2)',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'path',
              description: 'Directory path (default: current workspace root)',
              required: false,
              autocomplete: true,
            },
          ],
        },
      ],
    },
  ];
}

function buildAllowedMentions(allowEveryoneMention: boolean): { parse: Array<'users' | 'roles' | 'everyone'> } {
  if (allowEveryoneMention) {
    return {
      parse: ['users', 'roles', 'everyone'],
    };
  }
  return {
    parse: ['users'],
  };
}

function hasSameRuntimeIdentity(integration: BotIntegration, botToken: string, config: DiscordPluginConfig): boolean {
  const nextToken = readBotToken(integration.credentialsEncrypted);
  if (nextToken !== botToken) {
    return false;
  }
  const nextConfig = readDiscordPluginConfig(integration.pluginConfig);
  return JSON.stringify(nextConfig) === JSON.stringify(config);
}

function configureProxyFromEnvironment(logger: Logger): Dispatcher | null {
  if (proxyConfigured) {
    return sharedProxyDispatcher;
  }
  proxyConfigured = true;
  const proxyUrl =
    readProxyEnv('HTTPS_PROXY') ??
    readProxyEnv('https_proxy') ??
    readProxyEnv('HTTP_PROXY') ??
    readProxyEnv('http_proxy') ??
    readProxyEnv('ALL_PROXY') ??
    readProxyEnv('all_proxy');
  if (!proxyUrl) {
    return null;
  }

  try {
    const dispatcher = new ProxyAgent(proxyUrl);
    sharedProxyDispatcher = dispatcher;

    http.globalAgent = new HttpProxyAgent(proxyUrl);
    https.globalAgent = new HttpsProxyAgent(proxyUrl);
    patchHttpsRequestForWebSocketProxy(proxyUrl);
    logger.log(`Discord proxy enabled via environment: ${redactProxyUrl(proxyUrl)}`);
    return dispatcher;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown proxy setup error';
    logger.warn(`Failed to configure Discord proxy, continuing without explicit proxy: ${message}`);
    sharedProxyDispatcher = null;
    return null;
  }
}

function patchHttpsRequestForWebSocketProxy(proxyUrl: string): void {
  if (httpsWebSocketProxyPatched) {
    return;
  }
  httpsWebSocketProxyPatched = true;

  const wsProxyAgent = new HttpsProxyAgent(proxyUrl);
  const originalRequest = https.request.bind(https);
  const patchedRequest: typeof https.request = ((...args: unknown[]) => {
    if (args.length === 0) {
      return originalRequest({});
    }

    // ws library sets createConnection directly for wss. Force proxy agent for upgrade handshakes.
    if (args.length === 1 && isRequestOptions(args[0]) && isWebSocketUpgrade(args[0])) {
      const options = { ...args[0], agent: wsProxyAgent };
      delete (options as Record<string, unknown>).createConnection;
      return originalRequest(options);
    }

    if (args.length >= 2 && isRequestOptions(args[1]) && isWebSocketUpgrade(args[1])) {
      const options = { ...args[1], agent: wsProxyAgent };
      delete (options as Record<string, unknown>).createConnection;
      return originalRequest(args[0] as Parameters<typeof https.request>[0], options, args[2] as Parameters<typeof https.request>[2]);
    }

    return originalRequest(...(args as Parameters<typeof https.request>));
  }) as typeof https.request;

  (https as unknown as { request: typeof https.request }).request = patchedRequest;
}

function isRequestOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof URL);
}

function isWebSocketUpgrade(options: Record<string, unknown>): boolean {
  const headersValue = options.headers;
  if (!headersValue || typeof headersValue !== 'object' || Array.isArray(headersValue)) {
    return false;
  }
  const headers = headersValue as Record<string, unknown>;
  const upgrade = headers.Upgrade ?? headers.upgrade;
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
}

function readProxyEnv(key: string): string | null {
  const value = process.env[key];
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveBindingTargetFromMessage(message: Message): {
  bindingChannelId: string;
  bindingThreadId: string | null;
  channelName: string;
} {
  const channel = message.channel;
  const channelRecord = channel as unknown as Record<string, unknown>;
  const type = channelRecord.type;
  const isThread =
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread;
  const bindingThreadId = isThread ? message.channelId : null;
  const parentId = normalizeOptionalString(channelRecord.parentId);
  const bindingChannelId = bindingThreadId ? (parentId ?? message.channelId) : message.channelId;
  const channelName = normalizeOptionalString(channelRecord.name) ?? bindingChannelId;
  return {
    bindingChannelId,
    bindingThreadId,
    channelName,
  };
}

function extractInboundAttachmentsFromMessage(message: Message): DiscordInboundAttachment[] {
  const attachments: DiscordInboundAttachment[] = [];
  for (const attachment of message.attachments.values()) {
    const url = normalizeOptionalString(attachment.url);
    if (!url) {
      continue;
    }
    const fileName = normalizeOptionalString(attachment.name) ?? `attachment-${attachment.id}`;
    attachments.push({
      url,
      fileName,
      contentType: normalizeOptionalString(attachment.contentType),
      contentLength: typeof attachment.size === 'number' ? attachment.size : null,
    });
  }
  return attachments;
}

function extractInboundAttachmentsFromRawPayload(payload: Record<string, unknown>): DiscordInboundAttachment[] {
  const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  return rawAttachments
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => !!entry)
    .map((entry, index) => {
      const url = normalizeOptionalString(entry.url);
      const fileName = normalizeOptionalString(entry.filename) ?? `attachment-${index + 1}`;
      const contentType = normalizeOptionalString(entry.content_type);
      const contentLength = typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : null;
      return url
        ? {
            url,
            fileName,
            contentType,
            contentLength,
          }
        : null;
    })
    .filter((entry): entry is DiscordInboundAttachment => !!entry);
}

function createWorkspaceUploadMultipartBody(input: {
  workspacePath: string;
  fileName: string;
  contentType: string;
  content: Buffer;
}): {
  body: NodeJS.ReadableStream;
  contentType: string;
  contentLength: string;
} {
  const boundary = `----aw-discord-upload-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const safeFileName = sanitizeMultipartFileName(input.fileName);
  const partA = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="workspacePath"\r\n\r\n` +
      `${input.workspacePath}\r\n`,
    'utf8',
  );
  const partB = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
      `Content-Type: ${input.contentType || 'application/octet-stream'}\r\n\r\n`,
    'utf8',
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const contentLength = String(partA.length + partB.length + input.content.length + closing.length);
  return {
    body: Readable.from([partA, partB, input.content, closing]),
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength,
  };
}

function sanitizeMultipartFileName(fileName: string): string {
  const base = path.basename(fileName.trim() || 'attachment.bin');
  return base.replace(/[\r\n"]/g, '_');
}

function normalizeContentLengthHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

async function readResponseBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    return Buffer.alloc(0);
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`download exceeds upload limit: ${total} bytes`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}


function resolveBindingTargetFromChannel(channel: unknown): {
  bindingChannelId: string;
  bindingThreadId: string | null;
  channelName: string;
} {
  const channelRecord = asRecord(channel);
  if (!channelRecord) {
    return {
      bindingChannelId: '',
      bindingThreadId: null,
      channelName: 'discord',
    };
  }
  const channelId = normalizeOptionalString(channelRecord.id) ?? '';
  const type = channelRecord.type;
  const isThread =
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread;
  const threadId = isThread ? channelId : null;
  const parentId = normalizeOptionalString(channelRecord.parentId);
  return {
    bindingChannelId: threadId ? (parentId ?? channelId) : channelId,
    bindingThreadId: threadId,
    channelName: normalizeOptionalString(channelRecord.name) ?? (channelId || 'discord'),
  };
}

function buildDiscordUnifiedIdentifier(integrationId: string, providerMessageId: string | null): string {
  if (!providerMessageId) {
    return `discord:${integrationId}:${Date.now()}`;
  }
  return `discord:${integrationId}:${providerMessageId}`;
}

function findProjectIdByChannel(config: DiscordPluginConfig, channelId: string): string | null {
  const bindings = asRecord(config.channelBindings) ?? {};
  const entry = asRecord(bindings[channelId]);
  if (!entry) {
    return null;
  }
  return normalizeOptionalString(entry.projectId);
}

function findSessionIdByTarget(config: DiscordPluginConfig, channelId: string, threadId: string | null): string | null {
  const bindings = asRecord(config.sessionBindings) ?? {};
  const expectedThread = normalizeOptionalString(threadId);
  for (const [sessionId, rawBinding] of Object.entries(bindings)) {
    const entries = Array.isArray(rawBinding) ? rawBinding : [rawBinding];
    const matched = entries
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .some((binding) => {
        const bindingChannel = normalizeOptionalString(binding.channel);
        const bindingThread = normalizeOptionalString(binding.thread);
        return bindingChannel === channelId && bindingThread === expectedThread;
      });
    if (matched) {
      return sessionId;
    }
  }
  return null;
}

function upsertDiscordBindings(
  config: DiscordPluginConfig,
  input: {
    channelId: string;
    threadId: string | null;
    guildId: string | null;
    projectId: string;
    sessionId: string;
  },
): DiscordPluginConfig {
  const currentChannelBindings = readChannelBindings(config.channelBindings);
  const currentSessionBindings = readSessionBindings(config.sessionBindings);
  const nextChannelBindings = {
    ...currentChannelBindings,
    [input.channelId]: {
      projectId: input.projectId,
      channel: input.channelId,
      guild: input.guildId,
    } satisfies DiscordChannelBinding,
  };
  const nextSessionBindings = rebindTargetInSessionBindings(currentSessionBindings, {
    sessionId: input.sessionId,
    channelId: input.channelId,
    threadId: input.threadId,
    guildId: input.guildId,
  });
  const sessionIds = new Set(normalizeStringList(config.sessionIds));
  sessionIds.add(input.sessionId);
  return {
    ...config,
    channelBindings: nextChannelBindings,
    sessionBindings: nextSessionBindings,
    sessionIds: [...sessionIds],
  };
}

function bindSessionToTarget(
  config: DiscordPluginConfig,
  input: {
    channelId: string;
    threadId: string | null;
    guildId: string | null;
    projectId: string;
    sessionId: string;
    updateChannelProject: boolean;
  },
): DiscordPluginConfig {
  const channelBindings = readChannelBindings(config.channelBindings);
  if (input.updateChannelProject) {
    channelBindings[input.channelId] = {
      projectId: input.projectId,
      channel: input.channelId,
      guild: input.guildId,
    };
  }

  const currentSessionBindings = readSessionBindings(config.sessionBindings);
  const nextSessionBindings = rebindTargetInSessionBindings(currentSessionBindings, {
    sessionId: input.sessionId,
    channelId: input.channelId,
    threadId: input.threadId,
    guildId: input.guildId,
  });

  return {
    ...config,
    channelBindings,
    sessionBindings: nextSessionBindings,
    sessionIds: Object.keys(nextSessionBindings),
  };
}

function applyChannelProjectBinding(
  config: DiscordPluginConfig,
  input: {
    channelId: string;
    guildId: string | null;
    projectId: string;
  },
): DiscordPluginConfig {
  const channelBindings = readChannelBindings(config.channelBindings);
  channelBindings[input.channelId] = {
    projectId: input.projectId,
    channel: input.channelId,
    guild: input.guildId,
  };

  const currentSessionBindings = readSessionBindings(config.sessionBindings);
  const nextSessionBindings: Record<string, DiscordSessionBinding[]> = {};
  for (const [sessionId, bindings] of Object.entries(currentSessionBindings)) {
    const filtered = bindings.filter((binding) => !(binding.channel === input.channelId && !binding.thread));
    if (filtered.length === 0) {
      continue;
    }
    nextSessionBindings[sessionId] = filtered;
  }

  return {
    ...config,
    channelBindings,
    sessionBindings: nextSessionBindings,
    sessionIds: Object.keys(nextSessionBindings),
  };
}

function rebindTargetInSessionBindings(
  currentSessionBindings: Record<string, DiscordSessionBinding[]>,
  input: {
    sessionId: string;
    channelId: string;
    threadId: string | null;
    guildId: string | null;
  },
): Record<string, DiscordSessionBinding[]> {
  const nextSessionBindings: Record<string, DiscordSessionBinding[]> = {};
  const expectedThread = normalizeOptionalString(input.threadId);
  for (const [existingSessionId, bindings] of Object.entries(currentSessionBindings)) {
    const filtered = bindings.filter(
      (binding) => !(binding.channel === input.channelId && normalizeOptionalString(binding.thread) === expectedThread),
    );
    if (filtered.length === 0) {
      continue;
    }
    nextSessionBindings[existingSessionId] = filtered;
  }

  const targets = nextSessionBindings[input.sessionId] ?? [];
  const alreadyBound = targets.some(
    (binding) => binding.channel === input.channelId && normalizeOptionalString(binding.thread) === expectedThread,
  );
  if (!alreadyBound) {
    targets.push({
      channel: input.channelId,
      thread: input.threadId,
      guid: input.guildId,
    });
  }
  nextSessionBindings[input.sessionId] = targets;
  return nextSessionBindings;
}

function buildProjectUpdateInput(
  project: Record<string, unknown>,
  input: {
    repoPath: string | null;
    model: string | null;
    executionMode: string | null;
  },
): {
  repoPath?: string | null;
  backendConfig?: Record<string, unknown>;
} {
  const update: {
    repoPath?: string | null;
    backendConfig?: Record<string, unknown>;
  } = {};

  if (input.repoPath) {
    update.repoPath = input.repoPath;
  }

  if (input.model || input.executionMode) {
    const existingBackendConfig = normalizeJsonRecordForDisplay(project.backendConfig);
    const model = input.model ?? normalizeOptionalString(existingBackendConfig.model);
    const executionMode = input.executionMode ?? normalizeOptionalString(existingBackendConfig.executionMode);
    if (!model || !executionMode) {
      throw new Error('Both model and execution mode must be provided (or already set on project).');
    }
    if (!EXECUTION_MODE_CHOICES.includes(executionMode as (typeof EXECUTION_MODE_CHOICES)[number])) {
      throw new Error(`Unsupported execution mode: ${executionMode}`);
    }
    update.backendConfig = {
      ...existingBackendConfig,
      model,
      executionMode,
    };
  }

  return update;
}

function buildSessionUpdateInput(
  session: Record<string, unknown>,
  input: {
    title: string | null;
    model: string | null;
    executionMode: string | null;
  },
): {
  title?: string;
  backendConfig?: Record<string, unknown>;
} {
  const update: {
    title?: string;
    backendConfig?: Record<string, unknown>;
  } = {};

  if (input.title) {
    update.title = input.title;
  }

  if (input.model || input.executionMode) {
    const runtime = readSessionRuntimeMetaForDisplay(session.meta);
    const existingBackendConfig = normalizeJsonRecordForDisplay(runtime.backendConfig);
    const model = input.model ?? normalizeOptionalString(existingBackendConfig.model);
    const executionMode = input.executionMode ?? normalizeOptionalString(existingBackendConfig.executionMode);
    if (!model || !executionMode) {
      throw new Error('Both model and execution mode must be provided (or already set on session).');
    }
    if (!EXECUTION_MODE_CHOICES.includes(executionMode as (typeof EXECUTION_MODE_CHOICES)[number])) {
      throw new Error(`Unsupported execution mode: ${executionMode}`);
    }
    update.backendConfig = {
      ...existingBackendConfig,
      model,
      executionMode,
    };
  }

  return update;
}

function buildSessionCreateInputFromProject(
  project: Record<string, unknown>,
  input: {
    title: string;
    workingDir: string | null;
    backend: string | null;
    model: string | null;
    executionMode: string | null;
  },
): {
  title: string;
  repoPath?: string;
  backend?: string;
  backendConfig?: Record<string, unknown>;
} {
  const projectBackend = normalizeOptionalString(project.backend) ?? 'codex';
  const projectBackendConfig = normalizeJsonRecordForDisplay(project.backendConfig);

  const backend = input.backend ?? projectBackend;
  const model = input.model ?? normalizeOptionalString(projectBackendConfig.model);
  const executionMode = input.executionMode ?? normalizeOptionalString(projectBackendConfig.executionMode);

  if (executionMode && !EXECUTION_MODE_CHOICES.includes(executionMode as (typeof EXECUTION_MODE_CHOICES)[number])) {
    throw new Error(`Unsupported execution_mode: ${executionMode}`);
  }

  if ((input.model && !executionMode) || (!input.model && input.executionMode)) {
    throw new Error('Please provide both model and execution_mode together.');
  }

  const next: {
    title: string;
    repoPath?: string;
    backend?: string;
    backendConfig?: Record<string, unknown>;
  } = {
    title: input.title,
  };
  if (input.workingDir) {
    next.repoPath = input.workingDir;
  }
  if (input.backend) {
    next.backend = backend;
  }
  if (input.model || input.executionMode || input.backend) {
    if (!model || !executionMode) {
      throw new Error(`Session runtime for backend \`${backend}\` requires model and execution_mode.`);
    }
    next.backendConfig = {
      ...projectBackendConfig,
      model,
      executionMode,
    };
  }
  return next;
}

function readSessionRuntimeMetaForDisplay(meta: unknown): {
  backend: string;
  workspace: string;
  backendConfig: Record<string, unknown>;
} {
  const root = asRecord(meta);
  const runtime = asRecord(root?.runtime);
  const backend = normalizeOptionalString(runtime?.backend) ?? 'unknown';
  const workspace = normalizeOptionalString(runtime?.cwd) ?? '(auto)';
  const backendConfig = normalizeJsonRecordForDisplay(runtime?.backendConfig);
  return { backend, workspace, backendConfig };
}

function resolveExecutionModesForBackend(backend: string | null): string[] {
  const normalized = (backend ?? '').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'mock') {
    return [...EXECUTION_MODE_CHOICES];
  }
  return [...EXECUTION_MODE_CHOICES];
}

function readChannelBindings(value: unknown): Record<string, DiscordChannelBinding> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const normalized: Record<string, DiscordChannelBinding> = {};
  for (const [key, raw] of Object.entries(record)) {
    const entry = asRecord(raw);
    if (!entry) {
      continue;
    }
    const projectId = normalizeOptionalString(entry.projectId);
    const channel = normalizeOptionalString(entry.channel);
    if (!projectId || !channel) {
      continue;
    }
    normalized[key] = {
      projectId,
      channel,
      guild: normalizeOptionalString(entry.guild),
    };
  }
  return normalized;
}

function readSessionBindings(value: unknown): Record<string, DiscordSessionBinding[]> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const normalized: Record<string, DiscordSessionBinding[]> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (Array.isArray(raw)) {
      const parsed = raw
        .map((item) => readSingleSessionBinding(item))
        .filter((item): item is DiscordSessionBinding => item !== null);
      if (parsed.length > 0) {
        normalized[key] = parsed;
      }
      continue;
    }
    const single = readSingleSessionBinding(raw);
    if (!single) {
      continue;
    }
    normalized[key] = [single];
  }
  return normalized;
}

function readSingleSessionBinding(raw: unknown): DiscordSessionBinding | null {
  const entry = asRecord(raw);
  if (!entry) {
    return null;
  }
  const channel = normalizeOptionalString(entry.channel);
  if (!channel) {
    return null;
  }
  return {
    channel,
    thread: normalizeOptionalString(entry.thread),
    guid: normalizeOptionalString(entry.guid),
  };
}

function buildDiscordProjectName(channelName: string, channelId: string): string {
  const slug = slugifyChannelName(channelName);
  const normalizedChannelId = normalizeOptionalString(channelId) ?? 'unknown';
  return limitProjectName(`discord-${slug}-${normalizedChannelId}`);
}

function slugifyChannelName(channelName: string): string {
  const normalized = (normalizeOptionalString(channelName) ?? 'channel').toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'channel';
}

function buildDiscordSessionTitle(channelName: string, threadId: string | null): string {
  const normalized = normalizeOptionalString(channelName) ?? 'Discord';
  if (threadId) {
    return limitSessionTitle(`Discord ${normalized} thread`);
  }
  return limitSessionTitle(`Discord ${normalized}`);
}

function limitProjectName(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return trimmed.slice(0, 120);
}

function limitSessionTitle(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length <= 200) {
    return trimmed;
  }
  return trimmed.slice(0, 200);
}

function readRequiredId(value: unknown, entity: string): string {
  const record = asRecord(value);
  const id = record ? normalizeOptionalString(record.id) : null;
  if (!id) {
    throw new Error(`Failed to read ${entity} id`);
  }
  return id;
}

function limitDiscordMessageLength(input: string): string {
  if (input.length <= DISCORD_MESSAGE_MAX_LENGTH) {
    return input;
  }
  return `${input.slice(0, DISCORD_MESSAGE_MAX_LENGTH - 1)}…`;
}

function splitDiscordMessageChunks(input: string): string[] {
  if (input.length <= DISCORD_MESSAGE_MAX_LENGTH) {
    return [input];
  }

  const chunks: string[] = [];
  let remaining = input;
  while (remaining.length > DISCORD_MESSAGE_MAX_LENGTH) {
    const window = remaining.slice(0, DISCORD_MESSAGE_MAX_LENGTH);

    // Prefer splitting at the latest line end within the limit.
    const newlineIndex = window.lastIndexOf('\n');
    if (newlineIndex > 0) {
      const splitAt = newlineIndex + 1;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
      continue;
    }

    // If no line-end split is available, split on whitespace.
    const whitespaceIndex = findLastWhitespaceIndex(window);
    if (whitespaceIndex > 0) {
      const splitAt = whitespaceIndex + 1;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
      continue;
    }

    // Fallback for long unbreakable content.
    chunks.push(window);
    remaining = remaining.slice(DISCORD_MESSAGE_MAX_LENGTH);
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function findLastWhitespaceIndex(input: string): number {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(input[index] ?? '')) {
      return index;
    }
  }
  return -1;
}

function buildDiscordOutboundText(message: BotMessage): string | null {
  const payload = asRecord(message.payloadRaw);
  if (!payload) {
    return null;
  }
  if (message.kind === 'turn_message') {
    const content = normalizeOptionalString(payload.content);
    if (!content) {
      return null;
    }
    return renderDiscordMessageMarkdown(content);
  }
  if (message.kind === 'approval_request') {
    const summary = normalizeOptionalString(payload.summary) ?? normalizeOptionalString(payload.title) ?? 'Approval needed';
    return `[Approval Required] ${summary}`;
  }
  if (message.kind === 'user_input_request') {
    const prompt = normalizeOptionalString(payload.prompt) ?? 'Additional input is required.';
    return `[Input Required] ${prompt}`;
  }
  if (message.kind === 'event') {
    const eventType = normalizeOptionalString(payload.type);
    if (eventType === 'user_message') {
      const content = normalizeOptionalString(payload.content);
      if (!content) {
        return null;
      }
      return formatDiscordMirroredUserMessage(content);
    }
  }
  return null;
}

function formatDiscordMirroredUserMessage(content: string): string {
  const normalized = content.trim();
  const fenced = normalized.replace(/```/g, '`' + '\u200b' + '`' + '\u200b' + '`');
  return `> **User:**\n\`\`\`\n${fenced}\n\`\`\``;
}

function renderSessionHistoryLines(messages: Record<string, unknown>[], limit: number): string[] {
  if (messages.length === 0) {
    return [];
  }
  const selected = messages.slice(-limit);
  return selected.map((message, index) => {
    const role = normalizeOptionalString(message.role) ?? normalizeOptionalString(message.kind) ?? 'message';
    const content = readSessionHistoryMessageContent(message);
    const lineNo = messages.length - selected.length + index + 1;
    return `${lineNo}. [${role}] ${content}`;
  });
}

function readSessionHistoryMessageContent(message: Record<string, unknown>): string {
  const direct = normalizeOptionalString(message.content);
  if (direct) {
    return collapseInlineWhitespace(direct, 160);
  }

  const payload = asRecord(message.payloadRaw);
  const payloadContent =
    normalizeOptionalString(payload?.content) ??
    normalizeOptionalString(payload?.summary) ??
    normalizeOptionalString(payload?.title) ??
    normalizeOptionalString(payload?.prompt);
  if (payloadContent) {
    return collapseInlineWhitespace(payloadContent, 160);
  }

  return '(no text)';
}

function collapseInlineWhitespace(input: string, maxLength: number): string {
  const singleLine = input.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function renderDiscordMessageMarkdown(content: string): string {
  if (!content.includes('<think>')) {
    return content;
  }
  const replaced = content.replace(/<think>([\s\S]*?)<\/think>/gi, (_full, inner: string) => {
    const normalized = inner.trim();
    if (!normalized) {
      return '';
    }
    const italicLines = normalized
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => `> _${line}_`)
      .join('\n');
    return italicLines.length > 0 ? `${italicLines}\n` : '';
  });
  return replaced
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd();
}

function extractDiscordApprovalRequest(message: BotMessage): DiscordApprovalRequest | null {
  const root = asRecord(message.payloadRaw);
  if (!root) {
    return null;
  }

  if (message.kind === 'approval_request') {
    const turnId = normalizeOptionalString(root.turnId);
    const approvalId = normalizeOptionalString(root.approvalId) ?? normalizeOptionalString(root.requestId);
    const kind = normalizeOptionalString(root.kind) ?? 'approval';
    const payload = asRecord(root.payload) ?? root;
    if (!turnId || !approvalId) {
      return null;
    }
    return { turnId, approvalId, kind, payload };
  }

  return null;
}

function readDiscordTriggerMessageId(message: BotMessage): string | null {
  const payload = asRecord(message.payloadRaw);
  if (!payload) {
    return null;
  }
  return normalizeOptionalString(payload.triggerMessageId);
}

function readDiscordTurnId(message: BotMessage): string | null {
  const payload = asRecord(message.payloadRaw);
  if (!payload) {
    return null;
  }
  return normalizeOptionalString(payload.turnId);
}

function describeDiscordReactionEffect(message: BotMessage): {
  action:
    | 'watching'
    | 'active'
    | 'approval_pending'
    | 'final_success'
    | 'final_cancel'
    | 'final_error';
  onlyIfTracked: boolean;
  skipOutboundText: boolean;
} | null {
  const payload = asRecord(message.payloadRaw);
  if (!payload) {
    return null;
  }

  if (message.kind === 'turn_message') {
    return null;
  }

  if (message.kind !== 'event') {
    return null;
  }

  const eventType = normalizeOptionalString(payload.type);
  if (!eventType) {
    return null;
  }
  if (eventType === 'turn.completed' || eventType === 'turn.cancelled' || eventType === 'turn.failed') {
    if (eventType === 'turn.cancelled') {
      return {
        action: 'final_cancel',
        onlyIfTracked: true,
        skipOutboundText: true,
      };
    }
    if (eventType === 'turn.failed') {
      return {
        action: 'final_error',
        onlyIfTracked: true,
        skipOutboundText: true,
      };
    }
    return {
      action: 'final_success',
      onlyIfTracked: true,
      skipOutboundText: true,
    };
  }

  if (eventType === 'turn.approval.requested') {
    return {
      action: 'approval_pending',
      onlyIfTracked: true,
      skipOutboundText: true,
    };
  }

  if (eventType === 'turn.approval.resolved') {
    return {
      action: 'active',
      onlyIfTracked: true,
      skipOutboundText: true,
    };
  }

  return {
    action: 'active',
    onlyIfTracked: true,
    skipOutboundText: true,
  };
}

function shouldUseDiscordReplySendStyle(
  config: DiscordPluginConfig,
  context: PluginDispatchContext,
  triggerMessageId: string | null,
): boolean {
  if (config.message?.sendStyle !== 'reply') {
    return false;
  }
  if (!triggerMessageId) {
    return false;
  }
  // Only reply on the source integration route where trigger message ids are expected to be valid.
  return context.isTriggeredByYou;
}

function shouldSkipUserMessageForSourceBinding(message: BotMessage, context: PluginDispatchContext): boolean {
  if (message.kind !== 'event') {
    return false;
  }
  const payload = asRecord(message.payloadRaw);
  if (!payload) {
    return false;
  }
  const eventType = normalizeOptionalString(payload.type);
  if (eventType !== 'user_message') {
    return false;
  }
  const sourceBinding = asRecord(payload.sourceBinding);
  if (!sourceBinding) {
    return false;
  }

  const sourceProvider = normalizeOptionalString(sourceBinding.provider);
  if (sourceProvider && sourceProvider !== 'discord') {
    return false;
  }
  const sourceIntegrationId = normalizeOptionalString(sourceBinding.integrationId);
  const bindingIntegrationId = normalizeOptionalString(context.bindingIntegrationId);
  if (sourceIntegrationId && bindingIntegrationId && sourceIntegrationId !== bindingIntegrationId) {
    return false;
  }

  const sourceChannel = normalizeOptionalString(sourceBinding.channel);
  const sourceThread = normalizeOptionalString(sourceBinding.thread);
  const bindingChannel = normalizeOptionalString(context.bindingChannel);
  const bindingThread = normalizeOptionalString(context.bindingThread);

  const sourceGuid = normalizeOptionalString(sourceBinding.guid);
  const bindingGuid = normalizeOptionalString(context.bindingGuid);
  if (sourceGuid && bindingGuid && sourceGuid === bindingGuid && !sourceChannel && !bindingChannel) {
    return true;
  }

  if (sourceChannel && bindingChannel && sourceChannel === bindingChannel && sourceThread === bindingThread) {
    return true;
  }
  return false;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  return new Error('Unknown error');
}

function formatApprovalPromptContent(kind: string, payload: Record<string, unknown>): string {
  const reason = readApprovalTextField(payload, 'reason') ?? 'Not provided by runtime';
  const command = readApprovalCommand(payload) ?? 'Not provided by runtime';
  const cwd = readApprovalTextField(payload, 'cwd') ?? 'Not provided by runtime';
  return [
    '**Approval Required**',
    `Kind: ${formatApprovalKind(kind)}`,
    `Purpose: ${reason}`,
    `Command: ${command}`,
    `CWD: ${cwd}`,
  ].join('\n');
}

function formatApprovalKind(kind: string): string {
  const normalized = kind.trim();
  if (!normalized) {
    return 'Approval';
  }
  if (normalized === 'command_execution') {
    return 'Command Execution';
  }
  return normalized
    .split(/[_\s-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function readApprovalTextField(payload: Record<string, unknown>, key: 'reason' | 'cwd'): string | null {
  const value = payload[key];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readApprovalCommand(payload: Record<string, unknown>): string | null {
  const command = payload.command;
  if (typeof command === 'string') {
    const trimmed = command.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(command)) {
    const joined = command
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
      .join(' ');
    return joined.length > 0 ? joined : null;
  }
  if (command && typeof command === 'object') {
    const record = command as Record<string, unknown>;
    if (Array.isArray(record.argv)) {
      const joined = record.argv
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
        .join(' ');
      if (joined.length > 0) {
        return joined;
      }
    }
    if (typeof record.command === 'string' && record.command.trim().length > 0) {
      return record.command.trim();
    }
  }
  return null;
}

function getDiscordApprovalActionOptions(kind: string, payload: Record<string, unknown>): DiscordApprovalActionOption[] {
  if (kind !== 'command_execution') {
    return [
      { key: 'accept', label: 'Approve', decision: 'accept' },
      { key: 'decline', label: 'Reject', decision: 'decline', secondary: true },
    ];
  }

  const options: DiscordApprovalActionOption[] = [];
  const available = normalizeAvailableDecisions(payload.availableDecisions);
  const allowed = new Set(available);

  if (allowed.size === 0 || allowed.has('accept')) {
    options.push({ key: 'accept', label: 'Approve', decision: 'accept' });
  }
  if (allowed.has('acceptForSession')) {
    options.push({ key: 'acceptForSession', label: 'Approve for Session', decision: 'acceptForSession' });
  }

  const execPolicy = readExecpolicyAmendment(payload.proposedExecpolicyAmendment);
  if (execPolicy.length > 0) {
    options.push({
      key: 'execpolicy',
      label: 'Approve + Remember Rule',
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: execPolicy,
        },
      },
    });
  }

  const networkPolicies = readNetworkPolicyAmendments(payload.proposedNetworkPolicyAmendments);
  networkPolicies.forEach((policy, index) => {
    options.push({
      key: `network-${index}`,
      label: `${policy.action === 'allow' ? 'Allow' : 'Deny'} ${policy.host}`,
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: policy,
        },
      },
    });
  });

  if (allowed.size === 0 || allowed.has('decline')) {
    options.push({ key: 'decline', label: 'Reject', decision: 'decline', secondary: true });
  }
  if (allowed.has('cancel')) {
    options.push({ key: 'cancel', label: 'Reject + Cancel Turn', decision: 'cancel', secondary: true });
  }

  return options;
}

function normalizeAvailableDecisions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [entry];
    }
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    if ('acceptWithExecpolicyAmendment' in entry) {
      return ['acceptWithExecpolicyAmendment'];
    }
    if ('applyNetworkPolicyAmendment' in entry) {
      return ['applyNetworkPolicyAmendment'];
    }
    return [];
  });
}

function readExecpolicyAmendment(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function readNetworkPolicyAmendments(value: unknown): Array<{ action: 'allow' | 'deny'; host: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const action = record.action;
    const host = record.host;
    if ((action === 'allow' || action === 'deny') && typeof host === 'string' && host.trim().length > 0) {
      return [{ action, host: host.trim() }];
    }
    return [];
  });
}

function isManagedActionEmoji(emojiName: string): boolean {
  const normalized = normalizeEmojiName(emojiName);
  return (
    normalized === normalizeEmojiName(DISCORD_ACTION_EYE) ||
    normalized === normalizeEmojiName(DISCORD_ACTION_FLASH) ||
    normalized === normalizeEmojiName(DISCORD_ACTION_CHECK) ||
    normalized === normalizeEmojiName(DISCORD_ACTION_CROSS) ||
    normalized === normalizeEmojiName(DISCORD_ACTION_ALERT)
  );
}

function resolveDesiredActionEmojis(
  action: 'watching' | 'active' | 'approval_pending' | 'final_success' | 'final_cancel' | 'final_error',
): string[] {
  if (action === 'watching') {
    return [DISCORD_ACTION_EYE];
  }
  if (action === 'active') {
    return [DISCORD_ACTION_FLASH];
  }
  if (action === 'approval_pending') {
    return [DISCORD_ACTION_FLASH, DISCORD_ACTION_ALERT];
  }
  if (action === 'final_cancel' || action === 'final_error') {
    return [DISCORD_ACTION_CROSS];
  }
  return [DISCORD_ACTION_CHECK];
}

function resolveActionTrackingState(
  action: 'watching' | 'active' | 'approval_pending' | 'final_success' | 'final_cancel' | 'final_error',
): 'watching' | 'active' | 'final' {
  if (action === 'watching') {
    return 'watching';
  }
  if (action === 'active' || action === 'approval_pending') {
    return 'active';
  }
  return 'final';
}

function isFinalDiscordAction(action: 'watching' | 'active' | 'approval_pending' | 'final_success' | 'final_cancel' | 'final_error'): boolean {
  return action === 'final_success' || action === 'final_cancel' || action === 'final_error';
}

function normalizeEmojiName(value: string): string {
  return value.replace(/\uFE0F/g, '');
}

function buildApprovalMenuId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function safeReply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(content);
    return;
  }
  await interaction.reply({
    content,
    ephemeral: true,
  });
}

async function safeMenuReply(interaction: StringSelectMenuInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({
      content,
    });
    return;
  }
  await interaction.reply({
    content,
    ephemeral: true,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => !!entry);
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveFsPathWithinWorkspace(workspace: string, inputPath: string): string | null {
  const normalizedWorkspace = workspace.trim();
  const normalizedInput = inputPath.trim();
  if (!normalizedWorkspace || !normalizedInput) {
    return null;
  }
  const absoluteWorkspace = path.resolve(normalizedWorkspace);
  const absolutePath = path.isAbsolute(normalizedInput)
    ? path.resolve(normalizedInput)
    : path.resolve(absoluteWorkspace, normalizedInput);
  const relative = path.relative(absoluteWorkspace, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return absolutePath;
}

function resolveFsPathForGet(workspace: string | null, inputPath: string): string | null {
  const normalizedInput = inputPath.trim();
  if (!normalizedInput) {
    return null;
  }
  if (isExplicitAbsolutePathInput(normalizedInput)) {
    return path.resolve(expandHomeToken(normalizedInput));
  }
  if (!workspace) {
    return null;
  }
  return resolveFsPathWithinWorkspace(workspace, normalizedInput);
}

function resolveFsPathForListing(workspace: string | null, inputPath: string | null): string | null {
  const normalizedInput = inputPath?.trim() ?? '';
  if (!normalizedInput) {
    if (workspace) {
      return path.resolve(workspace);
    }
    return null;
  }
  return resolveFsPathForGet(workspace, normalizedInput);
}

function renderFsTextReply(header: string, lines: string[]): string {
  if (lines.length === 0) {
    return `${header}\n\`\`\`\n(empty)\n\`\`\``;
  }
  const capped = lines.slice(0, 400);
  const hasMore = lines.length > capped.length;
  const body = hasMore ? [...capped, `... (${lines.length - capped.length} more)`] : capped;
  return `${header}\n\`\`\`\n${body.join('\n')}\n\`\`\``;
}

function isExplicitAbsolutePathInput(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return (
    path.isAbsolute(trimmed) ||
    trimmed === '~' ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\') ||
    trimmed === '$HOME' ||
    trimmed.startsWith('$HOME/') ||
    trimmed.startsWith('$HOME\\')
  );
}

function expandHomeToken(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return trimmed;
  }
  const homePath = process.env.HOME?.trim();
  if (!homePath) {
    return trimmed;
  }
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homePath, trimmed.slice(1));
  }
  if (trimmed === '$HOME' || trimmed.startsWith('$HOME/') || trimmed.startsWith('$HOME\\')) {
    return path.join(homePath, trimmed.slice('$HOME'.length));
  }
  return trimmed;
}

function sanitizeDiscordFileName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return 'file.bin';
  }
  // Keep attachment names portable for Discord.
  return trimmed.replace(/[^\w.\-()+@]/g, '_').slice(0, 120) || 'file.bin';
}

function isSupportedDiscordInboundMessageType(type: MessageType | number): boolean {
  return type === MessageType.Default || type === MessageType.Reply;
}

function redactProxyUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : '';
      parsed.password = parsed.password ? '***' : '';
    }
    return parsed.toString();
  } catch {
    return 'configured';
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
