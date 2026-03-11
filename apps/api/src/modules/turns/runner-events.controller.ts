import { Body, Controller, Headers, Inject, Param, Post, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { parseWithZod } from '../../common/validation/zod';
import { TurnsService } from './turns.service';

const RunnerEventParamsSchema = z.object({
  turnId: z.string().trim().min(1),
});

const RunnerEventBodySchema = z.object({
  type: z.enum([
    'turn.started',
    'assistant.delta',
    'turn.approval.requested',
    'turn.approval.resolved',
    'turn.completed',
    'turn.failed',
    'turn.cancelled',
  ]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

@Controller('/internal/runner/turns')
export class RunnerEventsController {
  constructor(@Inject(TurnsService) private readonly turnsService: TurnsService) {}

  @Post(':turnId/events')
  async ingestEvent(
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('authorization') authorizationHeader: string | undefined,
  ) {
    this.assertAuthorized(authorizationHeader);
    const { turnId } = parseWithZod(RunnerEventParamsSchema, params);
    const input = parseWithZod(RunnerEventBodySchema, body);
    await this.turnsService.ingestRunnerEvent(turnId, input.type, input.payload ?? {});
    return { accepted: true };
  }

  private assertAuthorized(authorizationHeader: string | undefined): void {
    const sharedToken = process.env.RUNNER_AUTH_TOKEN?.trim();
    if (!sharedToken) {
      return;
    }
    if (authorizationHeader !== `Bearer ${sharedToken}`) {
      throw new UnauthorizedException({ message: 'Missing or invalid runner authorization token' });
    }
  }
}
