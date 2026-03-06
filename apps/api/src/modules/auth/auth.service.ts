import { Inject, Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getOrCreateUserByEmail(email: string): Promise<User> {
    return this.prisma.user.upsert({
      where: { email },
      update: {},
      create: { email },
    });
  }
}
