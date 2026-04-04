import { z } from 'zod';
import { ApprovalDecisionSchema } from '../turns/turns.schemas';

export const GatewayTokenBodySchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().trim().min(1),
  client_secret: z.string().trim().min(1),
  scope: z.string().trim().optional(),
});

export const GatewayPullQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GatewayClaimParamsSchema = z.object({
  messageId: z.string().trim().min(1),
});

export const GatewayClaimBodySchema = z.object({
  gatewayInstanceId: z.string().trim().min(1).max(120),
  leaseSeconds: z.coerce.number().int().min(5).max(300).optional(),
});

export const GatewayResultParamsSchema = z.object({
  messageId: z.string().trim().min(1),
});

export const GatewayResultBodySchema = z.object({
  status: z.enum(['sent', 'failed']),
  providerMessageId: z.string().trim().min(1).max(200).optional(),
  errorCode: z.string().trim().min(1).max(120).optional(),
  errorMessage: z.string().trim().min(1).max(2000).optional(),
});

export const GatewayInboundBodySchema = z.object({
  unifiedIdentifier: z.string().trim().min(1).max(300),
  triggerProvider: z.string().trim().min(1).max(120).optional(),
  triggerIntegrationId: z.string().trim().min(1).max(120).optional(),
  providerMessageId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  content: z.string().trim().min(1).max(10000),
  metadata: z.record(z.unknown()).optional(),
  occurredAt: z.string().datetime().optional(),
});

export const GatewayDeliveryBodySchema = z.object({
  messageId: z.string().trim().min(1),
  status: z.enum(['sent', 'failed']),
  providerMessageId: z.string().trim().min(1).max(200).optional(),
  errorCode: z.string().trim().min(1).max(120).optional(),
  errorMessage: z.string().trim().min(1).max(2000).optional(),
});

export const GatewayActiveIntegrationsQuerySchema = z.object({
  updatedAfter: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const GatewayHeartbeatBodySchema = z.object({
  gatewayInstanceId: z.string().trim().min(1).max(120),
  status: z.enum(['ok', 'degraded']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const GatewayApprovalBodySchema = z.object({
  turnId: z.string().trim().min(1),
  approvalId: z.string().trim().min(1),
  decision: ApprovalDecisionSchema,
});

export type GatewayTokenBody = z.infer<typeof GatewayTokenBodySchema>;
export type GatewayPullQuery = z.infer<typeof GatewayPullQuerySchema>;
export type GatewayClaimBody = z.infer<typeof GatewayClaimBodySchema>;
export type GatewayResultBody = z.infer<typeof GatewayResultBodySchema>;
export type GatewayInboundBody = z.infer<typeof GatewayInboundBodySchema>;
export type GatewayDeliveryBody = z.infer<typeof GatewayDeliveryBodySchema>;
export type GatewayActiveIntegrationsQuery = z.infer<typeof GatewayActiveIntegrationsQuerySchema>;
export type GatewayHeartbeatBody = z.infer<typeof GatewayHeartbeatBodySchema>;
export type GatewayApprovalBody = z.infer<typeof GatewayApprovalBodySchema>;
