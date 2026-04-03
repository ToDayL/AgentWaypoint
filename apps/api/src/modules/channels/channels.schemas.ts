import { z } from 'zod';

export const BotIntegrationStatusSchema = z.enum([
  'draft',
  'authorizing',
  'active',
  'paused',
  'error',
  'disabled',
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

export const CreateIntegrationBodySchema = z.object({
  provider: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  credentialsEncrypted: z.record(z.unknown()).optional(),
  pluginConfig: z.record(z.unknown()).optional(),
});

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
