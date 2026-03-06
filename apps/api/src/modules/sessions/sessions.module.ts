import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard } from '../auth/auth.guard';
import { ProjectsModule } from '../projects/projects.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [SessionsController],
  providers: [SessionsService, AuthGuard],
})
export class SessionsModule {}
