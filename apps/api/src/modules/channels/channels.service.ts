import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, BotIntegration, BotMessage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TurnsService } from '../turns/turns.service';
import {
  BotIntegrationStatus,
  BotMessageKind,
  CreateIntegrationBody,
  ListMessagesQuery,
  SendMessageBody,
  UpdateIntegrationBody,
} from './channels.schemas';
import {
  GatewayActiveIntegrationsQuery,
  GatewayApprovalBody,
  GatewayClaimBody,
  GatewayDeliveryBody,
  GatewayHeartbeatBody,
  GatewayInboundBody,
  GatewayResultBody,
} from './gateway.schemas';
import { ResolveTurnApprovalBody } from '../turns/turns.schemas';
import { QueueSignalService } from '../queue-signal/queue-signal.service';

const BOT_MESSAGE_QUEUED_STATUS = 'queued';

export type SessionProviderBinding = {
  provider: string;
  integrationId: string;
  guid: string | null;
  channel: string | null;
  thread: string | null;
};

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnsService) private readonly turnsService: TurnsService,
    @Inject(QueueSignalService) private readonly queueSignalService: QueueSignalService,
  ) {}

  async createIntegration(userId: string, input: CreateIntegrationBody): Promise<BotIntegration> {
    return this.prisma.botIntegration.create({
      data: {
        ownerUserId: userId,
        provider: input.provider,
        name: input.name,
        status: 'active',
        credentialsEncrypted: toOptionalJson(input.credentialsEncrypted),
        pluginConfig: toOptionalJson(input.pluginConfig),
      },
    });
  }

  async listIntegrations(userId: string): Promise<BotIntegration[]> {
    return this.prisma.botIntegration.findMany({
      where: { ownerUserId: userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getIntegration(userId: string, integrationId: string): Promise<BotIntegration> {
    const integration = await this.prisma.botIntegration.findUnique({
      where: { id: integrationId },
    });
    if (!integration) {
      throw new NotFoundException({ message: 'Integration not found' });
    }
    ensureOwnedByUser(userId, integration.ownerUserId);
    return integration;
  }

  async updateIntegration(userId: string, integrationId: string, input: UpdateIntegrationBody): Promise<BotIntegration> {
    const integration = await this.getIntegration(userId, integrationId);

    return this.prisma.botIntegration.update({
      where: { id: integration.id },
      data: {
        name: input.name,
        status: input.status,
        credentialsEncrypted: toOptionalJson(input.credentialsEncrypted),
        pluginConfig: toOptionalJson(input.pluginConfig),
      },
    });
  }

  async deleteIntegration(userId: string, integrationId: string): Promise<void> {
    const integration = await this.getIntegration(userId, integrationId);
    await this.prisma.botIntegration.delete({
      where: { id: integration.id },
    });
  }

  async setIntegrationStatus(
    userId: string,
    integrationId: string,
    status: BotIntegrationStatus,
  ): Promise<BotIntegration> {
    const integration = await this.getIntegration(userId, integrationId);
    return this.prisma.botIntegration.update({
      where: { id: integration.id },
      data: { status },
    });
  }

  async sendMessage(userId: string, input: SendMessageBody, kind: BotMessageKind): Promise<BotMessage> {
    await this.ensureProjectSessionOwnership(userId, input.projectId, input.sessionId);
    const created = await this.prisma.botMessage.create({
      data: {
        projectId: input.projectId,
        sessionId: input.sessionId,
        kind,
        payloadRaw: toRequiredJson(input.payloadRaw),
        status: BOT_MESSAGE_QUEUED_STATUS,
      },
    });
    await this.queueSignalService.publishOutboundWake();
    return created;
  }

  async listMessages(userId: string, query: ListMessagesQuery): Promise<BotMessage[]> {
    if (query.projectId) {
      await this.ensureProjectOwnedByUser(userId, query.projectId);
    }
    if (query.sessionId) {
      await this.ensureSessionOwnedByUser(userId, query.sessionId);
    }

    return this.prisma.botMessage.findMany({
      where: {
        project: {
          ownerUserId: userId,
        },
        projectId: query.projectId,
        sessionId: query.sessionId,
        status: query.status,
        kind: query.kind,
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 50,
    });
  }

  async getMessage(userId: string, messageId: string): Promise<BotMessage> {
    const message = await this.prisma.botMessage.findUnique({
      where: { id: messageId },
      include: {
        project: {
          select: { ownerUserId: true },
        },
      },
    });
    if (!message) {
      throw new NotFoundException({ message: 'Message not found' });
    }
    ensureOwnedByUser(userId, message.project.ownerUserId);
    return message;
  }

  async listActiveIntegrationsForGateway(query: GatewayActiveIntegrationsQuery): Promise<BotIntegration[]> {
    return this.prisma.botIntegration.findMany({
      where: {
        status: 'active',
        updatedAt: query.updatedAfter
          ? {
            gt: new Date(query.updatedAfter),
          }
          : undefined,
      },
      orderBy: { updatedAt: 'asc' },
      take: query.limit ?? 200,
    });
  }

  async pullOutboundForGateway(limit: number): Promise<BotMessage[]> {
    const now = new Date();
    return this.prisma.botMessage.findMany({
      where: {
        OR: [
          {
            status: BOT_MESSAGE_QUEUED_STATUS,
          },
          {
            status: 'sending',
            leaseExpireAt: {
              lte: now,
            },
          },
        ],
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: limit,
    });
  }

  async resolveBindingsForMessage(message: Pick<BotMessage, 'projectId' | 'sessionId'>): Promise<SessionProviderBinding[]> {
    const project = await this.prisma.project.findUnique({
      where: { id: message.projectId },
      select: { ownerUserId: true },
    });
    if (!project) {
      return [];
    }

    const activeIntegrations = await this.prisma.botIntegration.findMany({
      where: {
        ownerUserId: project.ownerUserId,
        status: 'active',
      },
      select: {
        id: true,
        provider: true,
        pluginConfig: true,
      },
    });

    const bindings: SessionProviderBinding[] = [];
    for (const integration of activeIntegrations) {
      bindings.push(...resolveIntegrationBindingsForSession(integration, message.sessionId));
    }
    return bindings;
  }

  async claimOutboundForGateway(messageId: string, input: GatewayClaimBody): Promise<BotMessage> {
    const now = new Date();
    const leaseSeconds = input.leaseSeconds ?? 30;
    const leaseExpireAt = new Date(now.getTime() + leaseSeconds * 1000);

    return this.prisma.$transaction(async (tx) => {
      const message = await tx.botMessage.findUnique({
        where: { id: messageId },
      });
      if (!message) {
        throw new NotFoundException({ message: 'Message not found' });
      }

      const leaseExpired = message.leaseExpireAt ? message.leaseExpireAt.getTime() <= now.getTime() : false;
      const claimable = message.status === 'queued' || (message.status === 'sending' && leaseExpired);
      if (!claimable) {
        throw new ConflictException({ message: 'Message is not claimable' });
      }

      return tx.botMessage.update({
        where: { id: messageId },
        data: {
          status: 'sending',
          claimedBy: input.gatewayInstanceId,
          claimedAt: now,
          leaseExpireAt,
        },
      });
    });
  }

  async reportOutboundResultForGateway(messageId: string, input: GatewayResultBody): Promise<BotMessage> {
    const now = new Date();
    return this.prisma.botMessage.update({
      where: { id: messageId },
      data: {
        status: input.status,
        providerMessageId: input.providerMessageId,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        sentAt: input.status === 'sent' ? now : undefined,
        deliveredAt: null,
        claimedBy: null,
        claimedAt: null,
        leaseExpireAt: null,
      },
    });
  }

  async ingestInboundForGateway(input: GatewayInboundBody): Promise<{
    accepted: true;
    unifiedIdentifier: string;
    messageId: string;
    turnId: string;
  }> {
    await this.ensureGatewayResolvedSessionExists(input.projectId, input.sessionId);
    const created = await this.turnsService.createTurnForGateway(input.sessionId, {
      content: input.content,
      triggerIdentifier: input.unifiedIdentifier,
      triggerProvider: input.triggerProvider,
      triggerIntegrationId: input.triggerIntegrationId,
      triggerMessageId: input.providerMessageId ?? null,
    });
    return {
      accepted: true,
      unifiedIdentifier: input.unifiedIdentifier,
      messageId: created.messageId,
      turnId: created.turnId,
    };
  }

  async ingestInboundForUserPlugin(
    userId: string,
    input: {
      unifiedIdentifier: string;
      triggerProvider?: string;
      triggerIntegrationId?: string;
      providerMessageId?: string;
      projectId: string;
      sessionId: string;
      content: string;
    },
  ): Promise<{ accepted: true; unifiedIdentifier: string; messageId: string; turnId: string }> {
    await this.ensureProjectSessionOwnership(userId, input.projectId, input.sessionId);
    const created = await this.turnsService.createTurnForGateway(input.sessionId, {
      content: input.content,
      triggerIdentifier: input.unifiedIdentifier,
      triggerProvider: input.triggerProvider,
      triggerIntegrationId: input.triggerIntegrationId,
      triggerMessageId: input.providerMessageId ?? null,
    });
    return {
      accepted: true,
      unifiedIdentifier: input.unifiedIdentifier,
      messageId: created.messageId,
      turnId: created.turnId,
    };
  }

  async ingestDeliveryForGateway(input: GatewayDeliveryBody): Promise<BotMessage> {
    return this.reportOutboundResultForGateway(input.messageId, {
      status: input.status,
      providerMessageId: input.providerMessageId,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
  }

  async recordGatewayHeartbeat(input: GatewayHeartbeatBody): Promise<{ status: 'ok'; gatewayInstanceId: string; at: string }> {
    return {
      status: 'ok',
      gatewayInstanceId: input.gatewayInstanceId,
      at: new Date().toISOString(),
    };
  }

  async resolveApprovalForGateway(input: GatewayApprovalBody): Promise<{ turnId: string; status: string; accepted: true }> {
    return this.turnsService.resolveTurnApprovalForGateway(input.turnId, {
      approvalId: input.approvalId,
      decision: input.decision,
    });
  }

  async reportOutboundResultForUserPlugin(
    userId: string,
    messageId: string,
    input: GatewayResultBody,
  ): Promise<BotMessage> {
    await this.getMessage(userId, messageId);
    return this.reportOutboundResultForGateway(messageId, input);
  }

  async resolveApprovalForUserPlugin(
    userId: string,
    turnId: string,
    input: ResolveTurnApprovalBody,
  ) {
    return this.turnsService.resolveTurnApprovalForUser(userId, turnId, input);
  }

  private async ensureProjectOwnedByUser(userId: string, projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerUserId: true },
    });
    if (!project) {
      throw new NotFoundException({ message: 'Project not found' });
    }
    ensureOwnedByUser(userId, project.ownerUserId);
  }

  private async ensureSessionOwnedByUser(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        project: {
          select: { ownerUserId: true },
        },
      },
    });
    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }
    ensureOwnedByUser(userId, session.project.ownerUserId);
  }

  private async ensureProjectSessionOwnership(userId: string, projectId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        projectId: true,
        project: {
          select: { ownerUserId: true },
        },
      },
    });
    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }
    if (session.projectId !== projectId) {
      throw new ForbiddenException({ message: 'Session does not belong to project' });
    }
    ensureOwnedByUser(userId, session.project.ownerUserId);
  }

  private async ensureGatewayResolvedSessionExists(projectId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { projectId: true },
    });
    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }
    if (session.projectId !== projectId) {
      throw new ForbiddenException({ message: 'Session does not belong to project' });
    }
  }
}

function ensureOwnedByUser(userId: string, ownerUserId: string): void {
  if (ownerUserId !== userId) {
    throw new ForbiddenException({ message: 'Forbidden' });
  }
}

function toOptionalJson(input: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (typeof input === 'undefined') {
    return undefined;
  }
  if (input === null) {
    return Prisma.JsonNull;
  }
  return input as Prisma.InputJsonValue;
}

function toRequiredJson(input: unknown): Prisma.InputJsonValue | Prisma.JsonNullValueInput {
  if (input === null) {
    return Prisma.JsonNull;
  }
  return input as Prisma.InputJsonValue;
}

function isIntegrationBoundToSession(config: Prisma.JsonValue | null, sessionId: string): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return false;
  }
  const record = config as Record<string, unknown>;
  if (record.bindAllSessions === true) {
    return true;
  }
  const sessionIds = record.sessionIds;
  if (!Array.isArray(sessionIds)) {
    return false;
  }
  return sessionIds.some((entry) => typeof entry === 'string' && entry === sessionId);
}

function resolveIntegrationBindingsForSession(
  integration: Pick<BotIntegration, 'id' | 'provider' | 'pluginConfig'>,
  sessionId: string,
): SessionProviderBinding[] {
  const config = integration.pluginConfig;
  const fallback = extractBindingTarget(config);
  const fromSessionMap = extractBindingTargetForSession(config, sessionId);
  if (fromSessionMap) {
    return [
      {
        provider: integration.provider,
        integrationId: integration.id,
        guid: fromSessionMap.guid,
        channel: fromSessionMap.channel,
        thread: fromSessionMap.thread,
      },
    ];
  }

  if (!isIntegrationBoundToSession(config, sessionId)) {
    return [];
  }

  return [
    {
      provider: integration.provider,
      integrationId: integration.id,
      guid: fallback.guid,
      channel: fallback.channel,
      thread: fallback.thread,
    },
  ];
}

function extractBindingTarget(config: Prisma.JsonValue | null): { guid: string | null; channel: string | null; thread: string | null } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { guid: null, channel: null, thread: null };
  }
  const raw = config as Record<string, unknown>;
  const candidate =
    asRecord(raw.binding) ??
    asRecord(raw.defaultBinding) ??
    asRecord(raw.target) ??
    raw;

  return {
    guid: asOptionalString(candidate.guid ?? candidate.groupId ?? candidate.chatId),
    channel: asOptionalString(candidate.channel ?? candidate.channelId),
    thread: asOptionalString(candidate.thread ?? candidate.threadId),
  };
}

function extractBindingTargetForSession(
  config: Prisma.JsonValue | null,
  sessionId: string,
): { guid: string | null; channel: string | null; thread: string | null } | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return null;
  }
  const raw = config as Record<string, unknown>;
  const sessionBindings =
    asRecord(raw.sessionBindings) ??
    asRecord(raw.bindingsBySession) ??
    asRecord(raw.sessionBindingMap);
  if (!sessionBindings) {
    return null;
  }
  const entry = asRecord(sessionBindings[sessionId]);
  if (!entry) {
    return null;
  }
  return {
    guid: asOptionalString(entry.guid ?? entry.groupId ?? entry.chatId),
    channel: asOptionalString(entry.channel ?? entry.channelId),
    thread: asOptionalString(entry.thread ?? entry.threadId),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
