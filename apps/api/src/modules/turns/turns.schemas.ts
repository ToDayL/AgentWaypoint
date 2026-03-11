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

const ApprovalDecisionSchema = z.union([
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

export const StreamTurnQuerySchema = z.object({
  since: z.coerce.number().int().min(0).optional(),
});

export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>;
export type TurnIdParams = z.infer<typeof TurnIdParamsSchema>;
export type CreateTurnBody = z.infer<typeof CreateTurnBodySchema>;
export type ResolveTurnApprovalBody = z.infer<typeof ResolveTurnApprovalBodySchema>;
export type StreamTurnQuery = z.infer<typeof StreamTurnQuerySchema>;
