import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserDecorator } from '../auth/current-user.decorator';
import { CurrentUser } from '../auth/auth.types';
import { SessionIdParamsSchema } from './sessions.schemas';
import { SessionsService } from './sessions.service';

@Controller('/api/sessions')
@UseGuards(AuthGuard)
export class SessionHistoryController {
  constructor(@Inject(SessionsService) private readonly sessionsService: SessionsService) {}

  @Get('/:id/history')
  async getSessionHistory(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(SessionIdParamsSchema, params);
    return this.sessionsService.getHistoryForSession(user.id, id);
  }
}
