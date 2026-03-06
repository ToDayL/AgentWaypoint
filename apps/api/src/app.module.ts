import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SessionsModule } from './modules/sessions/sessions.module';

@Module({
  imports: [PrismaModule, AuthModule, HealthModule, ProjectsModule, SessionsModule],
})
export class AppModule {}
