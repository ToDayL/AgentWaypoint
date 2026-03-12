import { z } from 'zod';

export const ProjectIdOnlyParamsSchema = z.object({
  projectId: z.string().trim().min(1),
});

export const SessionIdParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const CreateSessionBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  cwdOverride: z.string().trim().min(1).max(512).optional(),
  modelOverride: z.string().trim().min(1).max(120).optional(),
  sandboxOverride: z.string().trim().min(1).max(120).optional(),
  approvalPolicyOverride: z.string().trim().min(1).max(120).optional(),
});

export const ForkSessionBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export type ProjectIdOnlyParams = z.infer<typeof ProjectIdOnlyParamsSchema>;
export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>;
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;
export type ForkSessionBody = z.infer<typeof ForkSessionBodySchema>;
