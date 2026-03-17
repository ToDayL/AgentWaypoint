import { z } from 'zod';

export const WorkspaceSuggestionQuerySchema = z.object({
  prefix: z.string().trim().max(1024).default(''),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const WorkspaceTreeQuerySchema = z.object({
  path: z.string().trim().min(1).max(4096),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export type WorkspaceSuggestionQuery = z.infer<typeof WorkspaceSuggestionQuerySchema>;
export type WorkspaceTreeQuery = z.infer<typeof WorkspaceTreeQuerySchema>;
