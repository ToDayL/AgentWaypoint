import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MockRunnerAdapter } from './mock-runner.adapter';
import { RUNNER_ADAPTER } from './runner.types';

@Module({
  imports: [PrismaModule],
  providers: [
    MockRunnerAdapter,
    {
      provide: RUNNER_ADAPTER,
      useExisting: MockRunnerAdapter,
    },
  ],
  exports: [RUNNER_ADAPTER],
})
export class RunnerModule {}
