import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesystemController } from './filesystem.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { HttpRunnerAdapter } from './http-runner.adapter';
import { ModelsController } from './models.controller';
import { MockRunnerAdapter } from './mock-runner.adapter';
import { RUNNER_ADAPTER } from './runner.types';
import { SkillsController } from './skills.controller';

@Injectable()
class RunnerModeLogger implements OnModuleInit {
  private readonly logger = new Logger(RunnerModeLogger.name);

  constructor(@Inject(RUNNER_ADAPTER) private readonly runnerAdapter: unknown) {}

  onModuleInit(): void {
    const adapterName =
      typeof this.runnerAdapter === 'object' &&
      this.runnerAdapter !== null &&
      'constructor' in this.runnerAdapter
        ? (this.runnerAdapter as { constructor: { name: string } }).constructor.name
        : 'UnknownRunnerAdapter';
    this.logger.log(`Using runner adapter: ${adapterName}`);
  }
}

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ModelsController, SkillsController, FilesystemController],
  providers: [
    MockRunnerAdapter,
    HttpRunnerAdapter,
    {
      provide: RUNNER_ADAPTER,
      inject: [MockRunnerAdapter, HttpRunnerAdapter],
      useFactory: (mockRunnerAdapter: MockRunnerAdapter, httpRunnerAdapter: HttpRunnerAdapter) => {
        const mode = (process.env.RUNNER_MODE ?? 'mock').trim().toLowerCase();
        return mode === 'http' ? httpRunnerAdapter : mockRunnerAdapter;
      },
    },
    RunnerModeLogger,
  ],
  exports: [RUNNER_ADAPTER],
})
export class RunnerModule {}
