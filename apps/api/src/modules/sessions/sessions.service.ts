import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { CreateSessionBody } from './sessions.schemas';

@Injectable()
export class SessionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProjectsService) private readonly projectsService: ProjectsService,
  ) {}

  async listForProject(userId: string, projectId: string) {
    await this.projectsService.getByIdForUser(userId, projectId);

    return this.prisma.session.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async createForProject(userId: string, projectId: string, input: CreateSessionBody) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ownerUserId: userId,
      },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundException({ message: 'Project not found' });
    }

    return this.prisma.session.create({
      data: {
        projectId,
        title: input.title,
        status: 'active',
      },
    });
  }
}
