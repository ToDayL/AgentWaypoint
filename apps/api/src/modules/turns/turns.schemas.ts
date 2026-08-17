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

export const SteerTurnBodySchema = z.object({
  content: z.string().trim().min(1).max(10000),
});

export const ApprovalDecisionSchema = z.union([
  z.enum(['approve', 'reject', 'accept', 'acceptForSession', 'decline', 'cancel']),
  z
    .object({
      acceptWithExecpolicyAmendment: z.object({
        execpolicy_amendment: z.array(z.string().trim().min(1)).min(1),
      }),
    })
    .strict(),
  z
    .object({
      applyNetworkPolicyAmendment: z.object({
        network_policy_amendment: z.object({
          action: z.enum(['allow', 'deny']),
          host: z.string().trim().min(1),
        }),
      }),
    })
    .strict(),
]);

export const ResolveTurnApprovalBodySchema = z.object({
  approvalId: z.string().trim().min(1),
  decision: ApprovalDecisionSchema,
});

export const ApprovalTimerActionSchema = z.object({
  approvalId: z.string().trim().min(1),
  action: z.enum(['pause', 'resume']),
});

export const StreamTurnQuerySchema = z.object({
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const CommandOutputQuerySchema = z.object({
  detailRef: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^(call|item|tool|event):.+$/, 'Invalid command detail reference'),
});

export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>;
export type TurnIdParams = z.infer<typeof TurnIdParamsSchema>;
export type CreateTurnBody = z.infer<typeof CreateTurnBodySchema>;
export type SteerTurnBody = z.infer<typeof SteerTurnBodySchema>;
export type ResolveTurnApprovalBody = z.infer<typeof ResolveTurnApprovalBodySchema>;
export type ApprovalTimerAction = z.infer<typeof ApprovalTimerActionSchema>;
export type StreamTurnQuery = z.infer<typeof StreamTurnQuerySchema>;
export type CommandOutputQuery = z.infer<typeof CommandOutputQuerySchema>;
