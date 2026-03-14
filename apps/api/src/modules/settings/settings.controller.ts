import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserDecorator } from '../auth/current-user.decorator';
import { CurrentUser } from '../auth/auth.types';
import { SettingsService } from './settings.service';
import { AdminCreateUserBodySchema, AdminUpdateUserBodySchema, UpdateAppSettingsBodySchema } from './settings.schemas';

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

  @Get('/account/rate-limits')
  async getAccountRateLimits() {
    return this.settingsService.getAccountRateLimits();
  }

  @Get('/users')
  async listUsers(@CurrentUserDecorator() user: CurrentUser) {
    assertAdmin(user);
    return this.settingsService.listUsersForAdmin();
  }

  @Post('/users')
  async createUser(@CurrentUserDecorator() user: CurrentUser, @Body() body: unknown) {
    assertAdmin(user);
    const input = parseWithZod(AdminCreateUserBodySchema, body);
    return this.settingsService.createUserForAdmin({
      ...input,
      role: input.role ?? 'user',
      isActive: input.isActive ?? true,
    });
  }

  @Patch('/users/:id')
  async updateUser(@CurrentUserDecorator() user: CurrentUser, @Param('id') id: string, @Body() body: unknown) {
    assertAdmin(user);
    const input = parseWithZod(AdminUpdateUserBodySchema, body);
    return this.settingsService.updateUserForAdmin(user.id, id, input);
  }
}

function assertAdmin(user: CurrentUser): void {
  if (user.role !== 'admin') {
    throw new ForbiddenException({ message: 'Admin role required' });
  }
}
