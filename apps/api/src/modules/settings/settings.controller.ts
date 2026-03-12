import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserDecorator } from '../auth/current-user.decorator';
import { CurrentUser } from '../auth/auth.types';
import { SettingsService } from './settings.service';
import { UpdateAppSettingsBodySchema } from './settings.schemas';

@Controller('/api/settings')
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settingsService: SettingsService) {}

  @Get()
  async getSettings(@CurrentUserDecorator() user: CurrentUser) {
    return this.settingsService.getAppSettings(user.id);
  }

  @Post()
  async updateSettings(@CurrentUserDecorator() user: CurrentUser, @Body() body: unknown) {
    const input = parseWithZod(UpdateAppSettingsBodySchema, body);
    return this.settingsService.updateAppSettings(user.id, input);
  }
}
