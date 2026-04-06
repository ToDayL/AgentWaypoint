import { z } from 'zod';

export const BotIntegrationStatusSchema = z.enum([
  'active',
  'paused',
  'error',
]);

export const BotMessageKindSchema = z.enum([
  'turn_message',
  'approval_request',
  'user_input_request',
  'event',
]);

export const BotMessageStatusSchema = z.enum([
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
]);

export const BotIntegrationIdParamsSchema = z.object({
  botIntegrationId: z.string().trim().min(1),
});

export const MessageIdParamsSchema = z.object({
  messageId: z.string().trim().min(1),
});

const DiscordIdListSchema = z.array(z.string().trim().min(1).max(120)).max(500);

const DiscordCredentialsSchema = z.object({
  botToken: z.string().trim().min(1).max(4096),
});

const DiscordPluginConfigSchema = z.object({
  trigger: z.object({
    requireMention: z.boolean(),
    allowedUsers: DiscordIdListSchema,
    allowedGuilds: DiscordIdListSchema,
    allowedChannels: DiscordIdListSchema.optional(),
    allowDM: z.boolean().optional(),
  }),
  message: z.object({
    sendStyle: z.enum(['reply', 'new_message']).optional(),
    allowEveryoneMention: z.boolean().optional(),
    ignoreBotMessages: z.boolean().optional(),
    maxInboundLength: z.coerce.number().int().min(1).max(10000).optional(),
  }),
});

const GenericCreateIntegrationBodySchema = z
  .object({
    provider: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(120),
    credentialsEncrypted: z.record(z.unknown()).optional(),
    pluginConfig: z.record(z.unknown()).optional(),
  })
  .refine((input) => input.provider !== 'discord', {
    message: 'Discord integrations must use the Discord payload schema',
  });

const DiscordCreateIntegrationBodySchema = z.object({
  provider: z.literal('discord'),
  name: z.string().trim().min(1).max(120),
  credentialsEncrypted: DiscordCredentialsSchema,
  pluginConfig: DiscordPluginConfigSchema,
});

export const CreateIntegrationBodySchema = z.union([
  GenericCreateIntegrationBodySchema,
  DiscordCreateIntegrationBodySchema,
]);

export const UpdateIntegrationBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    credentialsEncrypted: z.record(z.unknown()).optional(),
    pluginConfig: z.record(z.unknown()).optional(),
    status: BotIntegrationStatusSchema.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one field is required',
  });

export const SendMessageBodySchema = z.object({
  projectId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  payloadRaw: z.unknown(),
});

export const ListMessagesQuerySchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  status: BotMessageStatusSchema.optional(),
  kind: BotMessageKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type BotIntegrationStatus = z.infer<typeof BotIntegrationStatusSchema>;
export type BotMessageKind = z.infer<typeof BotMessageKindSchema>;
export type CreateIntegrationBody = z.infer<typeof CreateIntegrationBodySchema>;
export type UpdateIntegrationBody = z.infer<typeof UpdateIntegrationBodySchema>;
export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;
