import { z } from 'zod';

export const ProjectIdParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const CreateProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  repoPath: z.string().trim().min(1).max(512).optional(),
  defaultModel: z.string().trim().min(1).max(120).optional(),
  defaultSandbox: z.string().trim().min(1).max(120).optional(),
  defaultApprovalPolicy: z.string().trim().min(1).max(120).optional(),
});

export const UpdateProjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    repoPath: z.string().trim().min(1).max(512).optional().nullable(),
    defaultModel: z.string().trim().min(1).max(120).optional().nullable(),
    defaultSandbox: z.string().trim().min(1).max(120).optional().nullable(),
    defaultApprovalPolicy: z.string().trim().min(1).max(120).optional().nullable(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one field is required',
  });

export type ProjectIdParams = z.infer<typeof ProjectIdParamsSchema>;
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;
export type UpdateProjectBody = z.infer<typeof UpdateProjectBodySchema>;
