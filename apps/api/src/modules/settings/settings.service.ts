import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateAppSettingsBody } from './settings.schemas';

@Injectable()
export class SettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getAppSettings(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        turnSteerEnabled: true,
      },
    });
  }

  async updateAppSettings(userId: string, input: UpdateAppSettingsBody) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        turnSteerEnabled: input.turnSteerEnabled,
      },
      select: {
        turnSteerEnabled: true,
      },
    });
  }
}
