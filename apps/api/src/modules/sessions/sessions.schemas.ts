import { z } from 'zod';

export const ProjectIdOnlyParamsSchema = z.object({
  projectId: z.string().trim().min(1),
});

export const SessionIdParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const BackendConfigSchema = z.record(z.unknown());
const ExecutionModeSchema = z.enum(['read-only', 'safe-write', 'yolo']);

export const CreateSessionBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    backend: z.string().trim().min(1).max(40).optional(),
    repoPath: z.string().trim().min(1).max(512).optional(),
    backendConfig: BackendConfigSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (typeof input.backendConfig === 'undefined') {
      return;
    }
    const model = input.backendConfig.model;
    const executionMode = input.backendConfig.executionMode;
    const hasModel = typeof model === 'string' && model.trim().length > 0;
    const parsedMode = ExecutionModeSchema.safeParse(executionMode);
    if (!hasModel || !parsedMode.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backendConfig requires model and executionMode',
        path: ['backendConfig'],
      });
    }
  });

export const ForkSessionBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export type ProjectIdOnlyParams = z.infer<typeof ProjectIdOnlyParamsSchema>;
export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>;
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;
export type ForkSessionBody = z.infer<typeof ForkSessionBodySchema>;
