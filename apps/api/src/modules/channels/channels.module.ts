import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard } from '../auth/auth.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectsModule } from '../projects/projects.module';
import { QueueSignalModule } from '../queue-signal/queue-signal.module';
import { RunnerModule } from '../runner/runner.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TurnsModule } from '../turns/turns.module';
import { ChannelsGatewayService } from './channels-gateway.service';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { DiscordPlugin } from './plugins/discord/discord.plugin';
import { WebPluginAppController } from './plugins/web/web-app.controller';
import { WebPlugin } from './plugins/web/web.plugin';

@Module({
  imports: [PrismaModule, AuthModule, TurnsModule, ProjectsModule, SessionsModule, RunnerModule, QueueSignalModule],
  controllers: [ChannelsController, WebPluginAppController],
  providers: [ChannelsService, ChannelsGatewayService, WebPlugin, DiscordPlugin, AuthGuard],
  exports: [ChannelsService],
})
export class ChannelsModule {}
