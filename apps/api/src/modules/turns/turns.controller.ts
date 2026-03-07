import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserDecorator } from '../auth/current-user.decorator';
import { CurrentUser } from '../auth/auth.types';
import {
  CreateTurnBodySchema,
  SessionIdParamsSchema,
  StreamTurnQuerySchema,
  TurnIdParamsSchema,
} from './turns.schemas';
import { TurnsService } from './turns.service';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

type RequestLike = {
  raw: {
    on: (event: 'close', handler: () => void) => void;
  };
};

type ReplyLike = {
  raw: {
    setHeader: (name: string, value: string) => void;
    write: (chunk: string) => void;
    end: () => void;
    flushHeaders?: () => void;
  };
};

@Controller('/api')
@UseGuards(AuthGuard)
export class TurnsController {
  constructor(@Inject(TurnsService) private readonly turnsService: TurnsService) {}

  @Post('/sessions/:id/turns')
  async createTurn(
    @CurrentUserDecorator() user: CurrentUser,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWithZod(SessionIdParamsSchema, params);
    const input = parseWithZod(CreateTurnBodySchema, body);
    return this.turnsService.createTurnForSession(user.id, id, input);
  }

  @Post('/turns/:id/cancel')
  async cancelTurn(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(TurnIdParamsSchema, params);
    return this.turnsService.cancelTurnForUser(user.id, id);
  }

  @Get('/turns/:id/stream')
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
    await this.turnsService.getTurnForUser(user.id, id);

    const headerSeq = Number.parseInt(lastEventIdHeader ?? '', 10);
    let cursor = Math.max(queryInput.since ?? 0, Number.isFinite(headerSeq) ? headerSeq : 0);

    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders?.();

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

    const closeStream = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeatTimer);
      clearInterval(pollTimer);
      reply.raw.end();
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
        const events = await this.turnsService.getEventsForTurn(user.id, id, cursor);
        for (const event of events) {
          cursor = event.seq;
          writeEvent(event);
        }

        const turn = await this.turnsService.getTurnForUser(user.id, id);
        if (events.length === 0 && TERMINAL_STATUSES.has(turn.status)) {
          terminalIdlePolls += 1;
        } else {
          terminalIdlePolls = 0;
        }

        if (terminalIdlePolls >= 2) {
          closeStream();
        }
      } finally {
        inFlight = false;
      }
    };

    const pollTimer = setInterval(() => {
      void poll();
    }, 300);
    void poll();

    request.raw.on('close', closeStream);
  }
}
