import { z } from 'zod';

export const ProjectIdParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const CreateProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  repoPath: z.string().trim().min(1).max(512).optional(),
});

export type ProjectIdParams = z.infer<typeof ProjectIdParamsSchema>;
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;
