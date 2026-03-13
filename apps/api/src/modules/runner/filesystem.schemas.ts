import { z } from 'zod';

export const WorkspaceSuggestionQuerySchema = z.object({
  prefix: z.string().trim().max(1024).default(''),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type WorkspaceSuggestionQuery = z.infer<typeof WorkspaceSuggestionQuerySchema>;
