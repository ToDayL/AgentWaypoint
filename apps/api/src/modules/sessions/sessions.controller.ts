import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserDecorator } from '../auth/current-user.decorator';
import { CurrentUser } from '../auth/auth.types';
import { CreateSessionBodySchema, ProjectIdOnlyParamsSchema } from './sessions.schemas';
import { SessionsService } from './sessions.service';

@Controller('/api/projects/:projectId/sessions')
@UseGuards(AuthGuard)
export class SessionsController {
  constructor(@Inject(SessionsService) private readonly sessionsService: SessionsService) {}

  @Get()
  async listSessions(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { projectId } = parseWithZod(ProjectIdOnlyParamsSchema, params);
    return this.sessionsService.listForProject(user.id, projectId);
  }

  @Post()
  async createSession(
    @CurrentUserDecorator() user: CurrentUser,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { projectId } = parseWithZod(ProjectIdOnlyParamsSchema, params);
    const input = parseWithZod(CreateSessionBodySchema, body);
    return this.sessionsService.createForProject(user.id, projectId, input);
  }
}
