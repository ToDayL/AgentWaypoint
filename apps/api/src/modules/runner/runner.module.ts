import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmbeddedRunnerService } from './embedded/embedded-runner.service';
import { FilesystemController } from './filesystem.controller';
import { HttpRunnerAdapter } from './http-runner.adapter';
import { InProcessRunnerAdapter } from './in-process-runner.adapter';
import { ModelsController } from './models.controller';
import { MockRunnerAdapter } from './mock-runner.adapter';
import { PrismaModule } from '../prisma/prisma.module';
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
    EmbeddedRunnerService,
    InProcessRunnerAdapter,
    MockRunnerAdapter,
    HttpRunnerAdapter,
    {
      provide: RUNNER_ADAPTER,
      inject: [InProcessRunnerAdapter, MockRunnerAdapter, HttpRunnerAdapter],
      useFactory: (
        inProcessRunnerAdapter: InProcessRunnerAdapter,
        mockRunnerAdapter: MockRunnerAdapter,
        httpRunnerAdapter: HttpRunnerAdapter,
      ) => {
        const mode = (process.env.RUNNER_MODE ?? 'embedded').trim().toLowerCase();
        if (mode === 'http') {
          return httpRunnerAdapter;
        }
        if (mode === 'mock') {
          return mockRunnerAdapter;
        }
        return inProcessRunnerAdapter;
      },
    },
    RunnerModeLogger,
  ],
  exports: [RUNNER_ADAPTER],
})
export class RunnerModule {}
