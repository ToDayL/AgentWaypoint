import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserDecorator } from '../auth/current-user.decorator';
import type { CurrentUser } from '../auth/auth.types';
import { TerminalsService } from './terminals.service';
import { TerminalsGateway, dimensions } from './terminals.gateway';
import { TerminalNetwork } from './terminal-network';

const createBody = z.object({
  requestId: z.string().uuid(),
  ...dimensions,
  preferredId: z.string().uuid().optional(),
});
const idSchema = z.string().uuid();

@Controller('/api')
@UseGuards(AuthGuard)
export class TerminalsController {
  constructor(
    @Inject(TerminalsService) private readonly terminals: TerminalsService,
    @Inject(TerminalsGateway) private readonly gateway: TerminalsGateway,
    @Inject(TerminalNetwork) private readonly network: TerminalNetwork,
  ) {}

  @Get('/terminals/capabilities')
  capabilities(@Req() request: IncomingMessage) {
    this.network.check(request.headers, false);
    return this.terminals.capabilities();
  }

  @Get('/sessions/:sessionId/terminals')
  list(
    @CurrentUserDecorator() user: CurrentUser,
    @Param('sessionId') sessionId: string,
    @Req() request: IncomingMessage,
  ) {
    this.network.check(request.headers, false);
    return this.terminals.list(user.id, sessionId);
  }

  @Post('/sessions/:sessionId/terminals')
  create(
    @CurrentUserDecorator() user: CurrentUser,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Req() request: IncomingMessage,
  ) {
    this.network.check(request.headers);
    return this.terminals.create(user.id, sessionId, parseWithZod(createBody, body));
  }

  @Post('/sessions/:sessionId/terminals/ensure')
  ensure(
    @CurrentUserDecorator() user: CurrentUser,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Req() request: IncomingMessage,
  ) {
    this.network.check(request.headers);
    return this.terminals.create(user.id, sessionId, parseWithZod(createBody, body), true);
  }

  @Post('/terminals/:id/attach')
  attach(
    @CurrentUserDecorator() user: CurrentUser,
    @Param('id') id: string,
    @Req() request: IncomingMessage,
  ) {
    return this.gateway.ticket(user.id, parseWithZod(idSchema, id), request);
  }

  @Patch('/terminals/:id')
  rename(
    @CurrentUserDecorator() user: CurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: IncomingMessage,
  ) {
    this.network.check(request.headers);
    const { title } = parseWithZod(z.object({ title: z.string().trim().min(1).max(80) }), body);
    return this.terminals.rename(user.id, parseWithZod(idSchema, id), title);
  }

  @Delete('/terminals/:id')
  @HttpCode(204)
  async close(
    @CurrentUserDecorator() user: CurrentUser,
    @Param('id') id: string,
    @Req() request: IncomingMessage,
  ) {
    this.network.check(request.headers);
    await this.terminals.close(user.id, parseWithZod(idSchema, id));
  }
}
