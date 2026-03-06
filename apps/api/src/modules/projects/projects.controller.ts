import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserDecorator } from '../auth/current-user.decorator';
import { CurrentUser } from '../auth/auth.types';
import { CreateProjectBodySchema, ProjectIdParamsSchema } from './projects.schemas';
import { ProjectsService } from './projects.service';

@Controller('/api/projects')
@UseGuards(AuthGuard)
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projectsService: ProjectsService) {}

  @Get()
  async listProjects(@CurrentUserDecorator() user: CurrentUser) {
    return this.projectsService.listForUser(user.id);
  }

  @Post()
  async createProject(@CurrentUserDecorator() user: CurrentUser, @Body() body: unknown) {
    const input = parseWithZod(CreateProjectBodySchema, body);
    return this.projectsService.createForUser(user.id, input);
  }

  @Get(':id')
  async getProject(@CurrentUserDecorator() user: CurrentUser, @Param() params: unknown) {
    const { id } = parseWithZod(ProjectIdParamsSchema, params);
    return this.projectsService.getByIdForUser(user.id, id);
  }
}
