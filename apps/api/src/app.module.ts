import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { RunnerModule } from './modules/runner/runner.module';
import { SettingsModule } from './modules/settings/settings.module';
import { TurnsModule } from './modules/turns/turns.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    HealthModule,
    ProjectsModule,
    SessionsModule,
    RunnerModule,
    SettingsModule,
    TurnsModule,
  ],
})
export class AppModule {}
