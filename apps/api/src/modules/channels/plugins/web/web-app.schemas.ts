import { z } from 'zod';
import { SkillsQuerySchema } from '../../../runner/filesystem.schemas';
import {
  WorkspaceFileContentQuerySchema,
  WorkspaceFileQuerySchema,
  WorkspaceSuggestionQuerySchema,
  WorkspaceTreeQuerySchema,
} from '../../../runner/filesystem.schemas';
import {
  CreateSessionBodySchema,
  ForkSessionBodySchema,
  ProjectIdOnlyParamsSchema,
  SessionIdParamsSchema,
} from '../../../sessions/sessions.schemas';
import {
  CreateTurnBodySchema,
  ResolveTurnApprovalBodySchema,
  StreamTurnQuerySchema,
  SteerTurnBodySchema,
  TurnIdParamsSchema,
} from '../../../turns/turns.schemas';
import { ProjectIdParamsSchema } from '../../../projects/projects.schemas';

export const WebPluginCreateProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  repoPath: z.string().trim().min(1).max(512).optional(),
});

export const WebPluginUpdateProjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    repoPath: z.string().trim().min(1).max(512).optional().nullable(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one field is required',
  });

export const WebPluginModelsQuerySchema = z.object({
  backend: z.string().trim().min(1).optional(),
});

export {
  SkillsQuerySchema,
  WorkspaceSuggestionQuerySchema,
  WorkspaceTreeQuerySchema,
  WorkspaceFileQuerySchema,
  WorkspaceFileContentQuerySchema,
  ProjectIdOnlyParamsSchema,
  ProjectIdParamsSchema,
  SessionIdParamsSchema,
  CreateSessionBodySchema,
  ForkSessionBodySchema,
  TurnIdParamsSchema,
  CreateTurnBodySchema,
  SteerTurnBodySchema,
  ResolveTurnApprovalBodySchema,
  StreamTurnQuerySchema,
};
