import { z } from 'zod';

export const WorkspaceSuggestionQuerySchema = z.object({
  prefix: z.string().trim().max(1024).default(''),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const WorkspaceTreeQuerySchema = z.object({
  path: z.string().trim().min(1).max(4096),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const WorkspaceFileQuerySchema = z.object({
  path: z.string().trim().min(1).max(4096),
  maxBytes: z.coerce.number().int().min(1024).max(1024 * 1024).optional(),
});

export const WorkspaceFileContentQuerySchema = z.object({
  path: z.string().trim().min(1).max(4096),
});

export const SkillsQuerySchema = z.object({
  cwd: z.string().trim().min(1).max(4096).optional(),
});

export type WorkspaceSuggestionQuery = z.infer<typeof WorkspaceSuggestionQuerySchema>;
export type WorkspaceTreeQuery = z.infer<typeof WorkspaceTreeQuerySchema>;
export type WorkspaceFileQuery = z.infer<typeof WorkspaceFileQuerySchema>;
export type WorkspaceFileContentQuery = z.infer<typeof WorkspaceFileContentQuerySchema>;
export type SkillsQuery = z.infer<typeof SkillsQuerySchema>;
