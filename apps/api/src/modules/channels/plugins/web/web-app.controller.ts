import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { parseWithZod } from '../../../../common/validation/zod';
import { AuthGuard } from '../../../auth/auth.guard';
import { CurrentUserDecorator } from '../../../auth/current-user.decorator';
import { CurrentUser } from '../../../auth/auth.types';
import { WebPlugin } from './web.plugin';
import {
  CreateSessionBodySchema,
  CreateTurnBodySchema,
  ForkSessionBodySchema,
  ProjectIdOnlyParamsSchema,
  ProjectIdParamsSchema,
  ApprovalTimerActionSchema,
  CommandOutputQuerySchema,
  ResolveTurnApprovalBodySchema,
  SessionIdParamsSchema,
  SkillsQuerySchema,
  SteerTurnBodySchema,
  StreamTurnQuerySchema,
  TurnIdParamsSchema,
  WebPluginCreateProjectBodySchema,
  WorkspaceFileContentQuerySchema,
  WorkspaceFileQuerySchema,
  WorkspaceSuggestionQuerySchema,
  WorkspaceTreeQuerySchema,
  WebPluginModelsQuerySchema,
  WebPluginUpdateProjectBodySchema,
  UpdateSessionBodySchema,
} from './web-app.schemas';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

type RequestLike = {
  raw: {
    on: (event: 'close', handler: () => void) => void;
  };
};

type ReplyLike = {
  raw: {
    destroyed?: boolean;
    writableEnded?: boolean;
    setHeader: (name: string, value: string) => void;
    write: (chunk: string) => void;
    end: (payload?: string | Buffer) => void;
    flushHeaders?: () => void;
    once: (event: 'close' | 'error', handler: () => void) => void;
  };
};

type UploadRequestLike = {
  raw: NodeJS.ReadableStream;
  headers: Record<string, string | string[] | undefined>;
};

@Controller('/api/channels/plugins/web/app')
@UseGuards(AuthGuard)
export class WebPluginAppController {
  private readonly logger = new Logger(WebPluginAppController.name);

  constructor(@Inject(WebPlugin) private readonly webPlugin: WebPlugin) {}

  @Get('models')
  async listModels(@Query() query: unknown) {
    const input = parseWithZod(WebPluginModelsQuerySchema, query);
    return {
      data: await this.webPlugin.listModels({
        backend: input.backend ?? null,
      }),
    };
  }

  @Get('skills')
  async listSkills(@Query() query: unknown) {
    const input = parseWithZod(SkillsQuerySchema, query);
    return {
      data: await this.webPlugin.listSkills({
        cwd: input.cwd ?? null,
        backend: input.backend ?? null,
      }),
    };
  }

  @Get('fs/suggestions')
  async getWorkspaceSuggestions(@Query() query: unknown) {
    const input = parseWithZod(WorkspaceSuggestionQuerySchema, query);
    return {
      data: await this.webPlugin.suggestWorkspaceDirectories({
        prefix: input.prefix ?? '',
        limit: input.limit,
      }),
    };
  }

  @Get('fs/tree')
  async getWorkspaceTree(@Query() query: unknown) {
    const input = parseWithZod(WorkspaceTreeQuerySchema, query);
    try {
      return {
        data: await this.webPlugin.listWorkspaceTree({
          path: input.path,
          limit: input.limit,
          includeHidden: input.includeHidden,
        }),
      };
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Failed to read workspace tree');
    }
  }

  @Get('fs/file')
  async getWorkspaceFile(@Query() query: unknown) {
    const input = parseWithZod(WorkspaceFileQuerySchema, query);
    try {
      return await this.webPlugin.readWorkspaceFile({
        path: input.path,
        maxBytes: input.maxBytes,
      });
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Failed to read workspace file');
    }
  }

  @Get('fs/file-content')
  async getWorkspaceFileContent(@Query() query: unknown, @Res() reply: ReplyLike) {
    const input = parseWithZod(WorkspaceFileContentQuerySchema, query);
    try {
      const response = await this.webPlugin.readWorkspaceFileContent({ path: input.path });
      reply.raw.setHeader('Content-Type', response.mimeType);
      reply.raw.setHeader('Cache-Control', 'no-store');
      reply.raw.setHeader('X-AgentWaypoint-File-Path', encodeURIComponent(response.path));
      reply.raw.end(response.content);
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Failed to read workspace file content');
    }
  }

  @Post('fs/upload')
  async uploadWorkspaceFile(@Req() request: UploadRequestLike) {
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
      return await this.webPlugin.uploadWorkspaceFile({
        body: request.raw,
        contentType,
        contentLength,
      });
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Failed to upload workspace file');
    }
  }

  @Get('projects')
  async listProjects(@CurrentUserDecorator() user: CurrentUser) {
    return this.webPlugin.listProjectsForUser(user.id);
  }

  @Post('projects')
  async createProject(@CurrentUserDecorator() user: CurrentUser, @Body() body: unknown) {
    const input = parseWithZod(WebPluginCreateProjectBodySchema, body);
    return this.webPlugin.createProjectForUser(user.id, input);
  }

  @Get('projects/:id')
  async getProject(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(ProjectIdParamsSchema, params);
    return this.webPlugin.getProjectForUser(user.id, id);
  }

  @Patch('projects/:id')
  async updateProject(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithZod(ProjectIdParamsSchema, params);
    const input = parseWithZod(WebPluginUpdateProjectBodySchema, body);
    return this.webPlugin.updateProjectForUser(user.id, id, input);
  }

  @Delete('projects/:id')
  async deleteProject(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(ProjectIdParamsSchema, params);
    await this.webPlugin.deleteProjectForUser(user.id, id);
    return { deleted: true as const };
  }

  @Get('projects/:projectId/sessions')
  async listSessions(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { projectId } = parseWithZod(ProjectIdOnlyParamsSchema, params);
    return this.webPlugin.listSessionsForProject(user.id, projectId);
  }

  @Post('projects/:projectId/sessions')
  async createSession(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown, @Body() body: unknown) {
    const { projectId } = parseWithZod(ProjectIdOnlyParamsSchema, params);
    const input = parseWithZod(CreateSessionBodySchema, body);
    return this.webPlugin.createSessionForProject(user.id, projectId, input);
  }

  @Get('sessions/:id/history')
  async getSessionHistory(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(SessionIdParamsSchema, params);
    return this.webPlugin.getSessionHistoryForUser(user.id, id);
  }

  @Patch('sessions/:id')
  async updateSession(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithZod(SessionIdParamsSchema, params);
    const input = parseWithZod(UpdateSessionBodySchema, body);
    return this.webPlugin.updateSessionForUser(user.id, id, input);
  }

  @Delete('sessions/:id')
  async deleteSession(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(SessionIdParamsSchema, params);
    await this.webPlugin.deleteSessionForUser(user.id, id);
    return { deleted: true as const };
  }

  @Post('sessions/:id/fork')
  async forkSession(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithZod(SessionIdParamsSchema, params);
    const input = parseWithZod(ForkSessionBodySchema, body);
    return this.webPlugin.forkSessionForUser(user.id, id, input);
  }

  @Post('sessions/:id/compact')
  async compactSession(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(SessionIdParamsSchema, params);
    return this.webPlugin.compactSessionForUser(user.id, id);
  }

  @Post('sessions/:id/turns')
  async createTurn(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithZod(SessionIdParamsSchema, params);
    const input = parseWithZod(CreateTurnBodySchema, body);
    return this.webPlugin.createTurnForSession(user.id, id, input);
  }

  @Get('turns/:id')
  async getTurn(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(TurnIdParamsSchema, params);
    return this.webPlugin.getTurnStatusForUser(user.id, id);
  }

  @Post('turns/:id/cancel')
  async cancelTurn(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(TurnIdParamsSchema, params);
    return this.webPlugin.cancelTurnForUser(user.id, id);
  }

  @Post('turns/:id/steer')
  async steerTurn(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithZod(TurnIdParamsSchema, params);
    const input = parseWithZod(SteerTurnBodySchema, body);
    return this.webPlugin.steerTurnForUser(user.id, id, input);
  }

  @Post('turns/:id/approval')
  async resolveApproval(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithZod(TurnIdParamsSchema, params);
    const input = parseWithZod(ResolveTurnApprovalBodySchema, body);
    return this.webPlugin.resolveTurnApprovalForUser(user.id, id, input);
  }

  @Post('turns/:id/approval/timer')
  async controlApprovalTimer(
    @CurrentUserDecorator() user: CurrentUser,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWithZod(TurnIdParamsSchema, params);
    const input = parseWithZod(ApprovalTimerActionSchema, body) as {
      approvalId: string;
      action: 'pause' | 'resume';
    };
    return this.webPlugin.controlApprovalTimerForUser(user.id, id, input);
  }

  @Get('turns/:id/events')
  async getTurnEvents(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown, @Query() query: unknown) {
    const { id } = parseWithZod(TurnIdParamsSchema, params);
    const queryInput = parseWithZod(StreamTurnQuerySchema, query);
    const turn = await this.webPlugin.getTurnForUser(user.id, id);
    const cursor = queryInput.since ?? 0;
    const limit = queryInput.limit ?? 500;
    const persistedEvents = await this.webPlugin.getEventsForTurn(user.id, id, cursor, limit);
    const dispatchedEvents = this.webPlugin.getDispatchedEventsForSessionTurn(turn.sessionId, id, cursor);
    return mergeBySeq(persistedEvents, dispatchedEvents).slice(0, limit);
  }

  @Get('turns/:id/diff')
  @Header('Cache-Control', 'private, no-store')
  async getLatestTurnDiff(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(TurnIdParamsSchema, params);
    return this.webPlugin.getLatestDiffForTurn(user.id, id);
  }

  @Get('turns/:id/command-output')
  @Header('Cache-Control', 'private, no-store')
  async getTurnCommandOutput(
    @CurrentUserDecorator() user: CurrentUser,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { id } = parseWithZod(TurnIdParamsSchema, params);
    const input = parseWithZod(CommandOutputQuerySchema, query);
    return this.webPlugin.getCommandOutputForTurn(user.id, id, input);
  }

  @Get('turns/:id/stream')
  async streamTurn(
    @CurrentUserDecorator() user: CurrentUser,
    @Param() params: unknown,
    @Query() query: unknown,
    @Headers('last-event-id') lastEventIdHeader: string | undefined,
    @Req() request: RequestLike,
    @Res() reply: ReplyLike,
  ): Promise<void> {
    const { id } = parseWithZod(TurnIdParamsSchema, params);
    const queryInput = parseWithZod(StreamTurnQuerySchema, query);
    const turn = await this.webPlugin.getTurnForUser(user.id, id);

    const headerSeq = Number.parseInt(lastEventIdHeader ?? '', 10);
    let cursor = Math.max(queryInput.since ?? 0, Number.isFinite(headerSeq) ? headerSeq : 0);

    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    // Prevent common reverse proxies (notably nginx) from batching SSE
    // frames, which would make approval prompts arrive after auto-approval.
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();
    reply.raw.write('retry: 2000\n\n');

    let closed = false;
    let inFlight = false;
    let terminalIdlePolls = 0;

    const writeEvent = (event: {
      seq: number;
      type: string;
      payload: unknown;
      turnId: string;
      createdAt: Date;
    }): void => {
      const payload = {
        turnId: event.turnId,
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt.toISOString(),
      };
      reply.raw.write(`id: ${event.seq}\n`);
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const writeStreamError = (error: unknown): void => {
      if (closed) {
        return;
      }
      const payload = {
        turnId: id,
        cursor,
        code: 'STREAM_POLL_FAILED',
        message: 'Turn stream interrupted. The client will reconnect automatically.',
      };
      this.logger.error(
        `Web turn stream poll failed for turn ${id} at cursor ${cursor}: ${formatErrorMessage(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      reply.raw.write('event: stream.error\n');
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const cleanupStream = (): boolean => {
      if (closed) {
        return false;
      }
      closed = true;
      clearInterval(heartbeatTimer);
      clearInterval(pollTimer);
      return true;
    };

    const closeStream = (): void => {
      if (!cleanupStream()) {
        return;
      }
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
      }
    };

    const heartbeatTimer = setInterval(() => {
      if (closed) {
        return;
      }
      reply.raw.write(`: keepalive ${Date.now()}\n\n`);
    }, 15000);

    const poll = async (): Promise<void> => {
      if (closed || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const persistedEvents = await this.webPlugin.getEventsForTurn(user.id, id, cursor, queryInput.limit);
        const dispatchedEvents = this.webPlugin.getDispatchedEventsForSessionTurn(turn.sessionId, id, cursor);
        const events = mergeBySeq(persistedEvents, dispatchedEvents);
        for (const event of events) {
          cursor = event.seq;
          writeEvent(event);
        }

        const latestTurn = await this.webPlugin.getTurnForUser(user.id, id);
        if (events.length === 0 && TERMINAL_STATUSES.has(latestTurn.status)) {
          terminalIdlePolls += 1;
        } else {
          terminalIdlePolls = 0;
        }

        if (terminalIdlePolls >= 2) {
          reply.raw.write('event: stream.end\n');
          reply.raw.write(
            `data: ${JSON.stringify({ turnId: id, status: latestTurn.status, cursor })}\n\n`,
          );
          closeStream();
        }
      } catch (error: unknown) {
        writeStreamError(error);
        closeStream();
      } finally {
        inFlight = false;
      }
    };

    const pollTimer = setInterval(() => {
      void poll();
    }, 300);
    void poll();

    void request;
    reply.raw.once('close', cleanupStream);
    reply.raw.once('error', cleanupStream);
  }
}

function mergeBySeq(
  primary: Array<{ seq: number; type: string; payload: unknown; turnId: string; createdAt: Date }>,
  secondary: Array<{ seq: number; type: string; payload: unknown; turnId: string; createdAt: Date }>,
): Array<{ seq: number; type: string; payload: unknown; turnId: string; createdAt: Date }> {
  const bySeq = new Map<number, { seq: number; type: string; payload: unknown; turnId: string; createdAt: Date }>();
  for (const event of secondary) {
    bySeq.set(event.seq, event);
  }
  for (const event of primary) {
    bySeq.set(event.seq, event);
  }
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown stream error';
}
