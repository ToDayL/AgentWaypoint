import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard } from '../auth/auth.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectsModule } from '../projects/projects.module';
import { RunnerModule } from '../runner/runner.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TurnsModule } from '../turns/turns.module';
import { ChannelsGatewayService } from './channels-gateway.service';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { WebPluginAppController } from './plugins/web/web-app.controller';
import { WebPlugin } from './plugins/web/web.plugin';

@Module({
  imports: [PrismaModule, AuthModule, TurnsModule, ProjectsModule, SessionsModule, RunnerModule],
  controllers: [ChannelsController, WebPluginAppController],
  providers: [ChannelsService, ChannelsGatewayService, WebPlugin, AuthGuard],
  exports: [ChannelsService],
})
export class ChannelsModule {}
