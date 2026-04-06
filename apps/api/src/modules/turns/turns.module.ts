import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard } from '../auth/auth.guard';
import { QueueSignalModule } from '../queue-signal/queue-signal.module';
import { RunnerModule } from '../runner/runner.module';
import { SettingsModule } from '../settings/settings.module';
import { RunnerEventsController } from './runner-events.controller';
import { TurnsController } from './turns.controller';
import { TurnsService } from './turns.service';

@Module({
  imports: [AuthModule, RunnerModule, SettingsModule, QueueSignalModule],
  controllers: [TurnsController, RunnerEventsController],
  providers: [TurnsService, AuthGuard],
  exports: [TurnsService],
})
export class TurnsModule {}
