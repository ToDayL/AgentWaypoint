import { z } from 'zod';

export const ProjectIdOnlyParamsSchema = z.object({
  projectId: z.string().trim().min(1),
});

export const CreateSessionBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export type ProjectIdOnlyParams = z.infer<typeof ProjectIdOnlyParamsSchema>;
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;
