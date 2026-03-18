import { BadRequestException, Controller, Get, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import {
  WorkspaceFileContentQuerySchema,
  WorkspaceFileQuerySchema,
  WorkspaceSuggestionQuerySchema,
  WorkspaceTreeQuerySchema,
} from './filesystem.schemas';
import { RUNNER_ADAPTER, RunnerAdapter } from './runner.types';

type ReplyLike = {
  raw: {
    setHeader: (name: string, value: string) => void;
    end: (payload?: string | Buffer) => void;
  };
};

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

  @Get('/file-content')
  async getWorkspaceFileContent(@Query() query: unknown, @Res() reply: ReplyLike) {
    const input = parseWithZod(WorkspaceFileContentQuerySchema, query);
    try {
      const response = await this.runnerAdapter.readWorkspaceFileContent({ path: input.path });
      reply.raw.setHeader('Content-Type', response.mimeType);
      reply.raw.setHeader('Cache-Control', 'no-store');
      reply.raw.setHeader('X-AgentWaypoint-File-Path', encodeURIComponent(response.path));
      reply.raw.end(response.content);
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Failed to read workspace file content');
    }
  }

  @Post('/upload')
  async uploadWorkspaceFile(
    @Req() request: { raw: NodeJS.ReadableStream; headers: Record<string, string | string[] | undefined> },
  ) {
    const contentType = Array.isArray(request.headers['content-type'])
      ? request.headers['content-type'][0] ?? ''
      : request.headers['content-type'] ?? '';
    const contentLength = Array.isArray(request.headers['content-length'])
      ? request.headers['content-length'][0] ?? null
      : request.headers['content-length'] ?? null;

    if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('multipart/form-data')) {
      throw new BadRequestException('content-type must be multipart/form-data');
    }

    try {
      return await this.runnerAdapter.uploadWorkspaceFile({
        body: request.raw,
        contentType,
        contentLength,
      });
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Failed to upload workspace file');
    }
  }
}
