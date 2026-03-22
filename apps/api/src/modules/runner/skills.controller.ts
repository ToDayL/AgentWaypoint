import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { SkillsQuerySchema } from './filesystem.schemas';
import { RUNNER_ADAPTER, RunnerAdapter } from './runner.types';

@Controller('/api/skills')
@UseGuards(AuthGuard)
export class SkillsController {
  constructor(@Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter) {}

  @Get()
  async listSkills(@Query() query: unknown) {
    const input = parseWithZod(SkillsQuerySchema, query);
    return {
      data: await this.runnerAdapter.listSkills({
        cwd: input.cwd ?? null,
        backend: input.backend ?? null,
      }),
    };
  }
}
