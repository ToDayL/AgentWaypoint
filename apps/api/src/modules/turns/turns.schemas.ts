import { z } from 'zod';

export const SessionIdParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const TurnIdParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const CreateTurnBodySchema = z.object({
  content: z.string().trim().min(1).max(10000),
});

export const ResolveTurnApprovalBodySchema = z.object({
  approvalId: z.string().trim().min(1),
  decision: z.enum(['approve', 'reject']),
});

export const StreamTurnQuerySchema = z.object({
  since: z.coerce.number().int().min(0).optional(),
});

export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>;
export type TurnIdParams = z.infer<typeof TurnIdParamsSchema>;
export type CreateTurnBody = z.infer<typeof CreateTurnBodySchema>;
export type ResolveTurnApprovalBody = z.infer<typeof ResolveTurnApprovalBodySchema>;
export type StreamTurnQuery = z.infer<typeof StreamTurnQuerySchema>;
