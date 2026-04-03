import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserDecorator } from '../auth/current-user.decorator';
import { CurrentUser } from '../auth/auth.types';
import { ChannelsService } from './channels.service';
import {
  BotIntegrationIdParamsSchema,
  CreateIntegrationBodySchema,
  ListMessagesQuerySchema,
  MessageIdParamsSchema,
  SendMessageBodySchema,
  UpdateIntegrationBodySchema,
} from './channels.schemas';

@Controller('/api/channels')
@UseGuards(AuthGuard)
export class ChannelsController {
  constructor(@Inject(ChannelsService) private readonly channelsService: ChannelsService) {}

  @Post('integrations')
  async createIntegration(@CurrentUserDecorator() user: CurrentUser, @Body() body: unknown) {
    const input = parseWithZod(CreateIntegrationBodySchema, body);
    return this.channelsService.createIntegration(user.id, input);
  }

  @Get('integrations')
  async listIntegrations(@CurrentUserDecorator() user: CurrentUser) {
    return this.channelsService.listIntegrations(user.id);
  }

  @Get('integrations/:botIntegrationId')
  async getIntegration(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { botIntegrationId } = parseWithZod(BotIntegrationIdParamsSchema, params);
    return this.channelsService.getIntegration(user.id, botIntegrationId);
  }

  @Patch('integrations/:botIntegrationId')
  async updateIntegration(
    @CurrentUserDecorator() user: CurrentUser,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { botIntegrationId } = parseWithZod(BotIntegrationIdParamsSchema, params);
    const input = parseWithZod(UpdateIntegrationBodySchema, body);
    return this.channelsService.updateIntegration(user.id, botIntegrationId, input);
  }

  @Post('integrations/:botIntegrationId/activate')
  async activateIntegration(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { botIntegrationId } = parseWithZod(BotIntegrationIdParamsSchema, params);
    return this.channelsService.setIntegrationStatus(user.id, botIntegrationId, 'active');
  }

  @Post('integrations/:botIntegrationId/pause')
  async pauseIntegration(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { botIntegrationId } = parseWithZod(BotIntegrationIdParamsSchema, params);
    return this.channelsService.setIntegrationStatus(user.id, botIntegrationId, 'paused');
  }

  @Post('integrations/:botIntegrationId/disable')
  async disableIntegration(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { botIntegrationId } = parseWithZod(BotIntegrationIdParamsSchema, params);
    return this.channelsService.setIntegrationStatus(user.id, botIntegrationId, 'disabled');
  }

  @Delete('integrations/:botIntegrationId')
  @HttpCode(204)
  async deleteIntegration(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { botIntegrationId } = parseWithZod(BotIntegrationIdParamsSchema, params);
    await this.channelsService.deleteIntegration(user.id, botIntegrationId);
  }

  @Post('messages/send')
  async sendMessage(@CurrentUserDecorator() user: CurrentUser, @Body() body: unknown) {
    const input = parseWithZod(SendMessageBodySchema, body);
    return this.channelsService.sendMessage(user.id, input, 'turn_message');
  }

  @Post('messages/send-approval')
  async sendApproval(@CurrentUserDecorator() user: CurrentUser, @Body() body: unknown) {
    const input = parseWithZod(SendMessageBodySchema, body);
    return this.channelsService.sendMessage(user.id, input, 'approval_request');
  }

  @Get('messages')
  async listMessages(@CurrentUserDecorator() user: CurrentUser, @Query() query: unknown) {
    const input = parseWithZod(ListMessagesQuerySchema, query);
    return this.channelsService.listMessages(user.id, input);
  }

  @Get('messages/:messageId')
  async getMessage(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { messageId } = parseWithZod(MessageIdParamsSchema, params);
    return this.channelsService.getMessage(user.id, messageId);
  }
}
