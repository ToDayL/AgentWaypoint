import { z } from 'zod';

export const ProjectIdOnlyParamsSchema = z.object({
  projectId: z.string().trim().min(1),
});

export const SessionIdParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const BackendConfigSchema = z.record(z.unknown());
const ExecutionModeSchema = z.enum(['read-only', 'safe-write', 'auto-review', 'yolo']);
const EffortSchema = z.string().trim().min(1).max(40);

function validateBackendConfig(
  backendConfig: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const model = backendConfig.model;
  const executionMode = backendConfig.executionMode;
  const effort = backendConfig.effort;
  const hasModel = typeof model === 'string' && model.trim().length > 0;
  const parsedMode = ExecutionModeSchema.safeParse(executionMode);
  const parsedEffort = typeof effort === 'undefined' ? null : EffortSchema.safeParse(effort);
  if (!hasModel || !parsedMode.success || (parsedEffort !== null && !parsedEffort.success)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backendConfig requires model, executionMode, and an optional non-empty effort string',
      path: ['backendConfig'],
    });
  }
}

export const CreateSessionBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    backend: z.string().trim().min(1).max(40).optional(),
    repoPath: z.string().trim().min(1).max(512).optional(),
    backendConfig: BackendConfigSchema.optional(),
    autoApprove: z.boolean().optional(),
    autoApproveTimeoutSeconds: z.number().int().min(0).max(3600).optional(),
  })
  .superRefine((input, ctx) => {
    if (typeof input.backendConfig === 'undefined') {
      return;
    }
    validateBackendConfig(input.backendConfig, ctx);
  });

export const ForkSessionBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export const UpdateSessionBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    backendConfig: BackendConfigSchema.optional(),
    autoApprove: z.boolean().optional(),
    autoApproveTimeoutSeconds: z.number().int().min(0).max(3600).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (typeof input.backendConfig !== 'undefined') {
      validateBackendConfig(input.backendConfig, ctx);
    }

    if (Object.keys(input).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one field is required',
      });
    }
  });

export type ProjectIdOnlyParams = z.infer<typeof ProjectIdOnlyParamsSchema>;
export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>;
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;
export type ForkSessionBody = z.infer<typeof ForkSessionBodySchema>;
export type UpdateSessionBody = z.infer<typeof UpdateSessionBodySchema>;
