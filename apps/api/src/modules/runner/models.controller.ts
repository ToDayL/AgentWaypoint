import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { RUNNER_ADAPTER, RunnerAdapter } from './runner.types';

@Controller('/api/models')
@UseGuards(AuthGuard)
export class ModelsController {
  constructor(@Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter) {}

  @Get()
  async listModels(@Query('backend') backend?: string) {
    return {
      data: await this.runnerAdapter.listModels({ backend }),
    };
  }
}
