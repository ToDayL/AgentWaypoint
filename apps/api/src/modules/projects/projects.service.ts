import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectBody } from './projects.schemas';

@Injectable()
export class ProjectsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listForUser(userId: string) {
    return this.prisma.project.findMany({
      where: { ownerUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createForUser(userId: string, input: CreateProjectBody) {
    return this.prisma.project.create({
      data: {
        ownerUserId: userId,
        name: input.name,
        repoPath: input.repoPath,
      },
    });
  }

  async getByIdForUser(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ownerUserId: userId,
      },
    });

    if (!project) {
      throw new NotFoundException({ message: 'Project not found' });
    }

    return project;
  }
}
