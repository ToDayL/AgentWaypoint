import { z } from 'zod';

const BackendConfigSchema = z.record(z.unknown());
const CodexBackendConfigSchema = z.object({
  model: z.string().trim().min(1).max(120),
  sandbox: z.string().trim().min(1).max(120),
  approvalPolicy: z.string().trim().min(1).max(120),
});

export const ProjectIdParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const CreateProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  repoPath: z.string().trim().min(1).max(512).optional(),
  backend: z.string().trim().min(1).max(40).optional(),
  backendConfig: BackendConfigSchema.optional(),
}).superRefine((input, ctx) => {
  const backend = (input.backend ?? 'codex').trim().toLowerCase();
  if (backend === 'codex' && typeof input.backendConfig !== 'undefined') {
    const parsed = CodexBackendConfigSchema.safeParse(input.backendConfig);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'codex backendConfig requires model, sandbox, approvalPolicy',
        path: ['backendConfig'],
      });
    }
  }
});

export const UpdateProjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    repoPath: z.string().trim().min(1).max(512).optional().nullable(),
    backend: z.string().trim().min(1).max(40).optional(),
    backendConfig: BackendConfigSchema.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one field is required',
  })
  .superRefine((input, ctx) => {
    if (typeof input.backendConfig !== 'undefined') {
      const parsedConfig = CodexBackendConfigSchema.safeParse(input.backendConfig);
      if (!parsedConfig.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'backendConfig requires model, sandbox, approvalPolicy',
          path: ['backendConfig'],
        });
      }
    }
    if (typeof input.backend === 'string' && input.backend.trim().toLowerCase() === 'codex') {
      const parsed = CodexBackendConfigSchema.safeParse(input.backendConfig);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'updating backend to codex requires backendConfig with model, sandbox, approvalPolicy',
          path: ['backendConfig'],
        });
      }
    }
  });

export type ProjectIdParams = z.infer<typeof ProjectIdParamsSchema>;
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;
export type UpdateProjectBody = z.infer<typeof UpdateProjectBodySchema>;
