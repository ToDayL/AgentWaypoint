import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard } from '../auth/auth.guard';
import { ProjectsModule } from '../projects/projects.module';
import { RunnerModule } from '../runner/runner.module';
import { SessionHistoryController } from './session-history.controller';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [AuthModule, ProjectsModule, RunnerModule],
  controllers: [SessionsController, SessionHistoryController],
  providers: [SessionsService, AuthGuard],
})
export class SessionsModule {}
