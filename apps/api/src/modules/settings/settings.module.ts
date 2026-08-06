import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RunnerModule } from '../runner/runner.module';
import { SettingsController } from './settings.controller';
import { CC_SWITCH_CLIENT, LocalCcSwitchClient } from './cc-switch.client';
import { SettingsService } from './settings.service';

@Module({
  imports: [PrismaModule, AuthModule, RunnerModule],
  controllers: [SettingsController],
  providers: [
    LocalCcSwitchClient,
    { provide: CC_SWITCH_CLIENT, useExisting: LocalCcSwitchClient },
    SettingsService,
  ],
  exports: [SettingsService],
})
export class SettingsModule {}
