import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateAppSettingsBody } from './settings.schemas';

const APP_CONFIG_KEY = 'global';

@Injectable()
export class SettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getAppSettings() {
    return this.prisma.appConfig.upsert({
      where: { key: APP_CONFIG_KEY },
      update: {},
      create: {
        key: APP_CONFIG_KEY,
        turnSteerEnabled: getInitialTurnSteerEnabled(),
      },
    });
  }

  async updateAppSettings(input: UpdateAppSettingsBody) {
    return this.prisma.appConfig.upsert({
      where: { key: APP_CONFIG_KEY },
      update: {
        turnSteerEnabled: input.turnSteerEnabled,
      },
      create: {
        key: APP_CONFIG_KEY,
        turnSteerEnabled: input.turnSteerEnabled,
      },
    });
  }
}

function getInitialTurnSteerEnabled(): boolean {
  return (process.env.TURN_STEER_ENABLED ?? 'false').trim().toLowerCase() === 'true';
}
