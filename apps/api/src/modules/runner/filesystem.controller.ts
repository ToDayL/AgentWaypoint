import { BadRequestException, Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceFileQuerySchema, WorkspaceSuggestionQuerySchema, WorkspaceTreeQuerySchema } from './filesystem.schemas';
import { RUNNER_ADAPTER, RunnerAdapter } from './runner.types';

@Controller('/api/fs')
@UseGuards(AuthGuard)
export class FilesystemController {
  constructor(@Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter) {}

  @Get('/suggestions')
  async getWorkspaceSuggestions(@Query() query: unknown) {
    const input = parseWithZod(WorkspaceSuggestionQuerySchema, query);
    return {
      data: await this.runnerAdapter.suggestWorkspaceDirectories({
        prefix: input.prefix ?? '',
        limit: input.limit,
      }),
    };
  }

  @Get('/tree')
  async getWorkspaceTree(@Query() query: unknown) {
    const input = parseWithZod(WorkspaceTreeQuerySchema, query);
    try {
      return {
        data: await this.runnerAdapter.listWorkspaceTree({
          path: input.path,
          limit: input.limit,
        }),
      };
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Failed to read workspace tree');
    }
  }

  @Get('/file')
  async getWorkspaceFile(@Query() query: unknown) {
    const input = parseWithZod(WorkspaceFileQuerySchema, query);
    try {
      return await this.runnerAdapter.readWorkspaceFile({
        path: input.path,
        maxBytes: input.maxBytes,
      });
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Failed to read workspace file');
    }
  }
}
