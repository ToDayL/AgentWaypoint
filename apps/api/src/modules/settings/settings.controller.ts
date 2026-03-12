import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { SettingsService } from './settings.service';
import { UpdateAppSettingsBodySchema } from './settings.schemas';

@Controller('/api/settings')
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settingsService: SettingsService) {}

  @Get()
  async getSettings() {
    return this.settingsService.getAppSettings();
  }

  @Post()
  async updateSettings(@Body() body: unknown) {
    const input = parseWithZod(UpdateAppSettingsBodySchema, body);
    return this.settingsService.updateAppSettings(input);
  }
}
