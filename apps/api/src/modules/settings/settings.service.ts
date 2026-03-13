import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from '../auth/auth.service';
import { AdminCreateUserBody, AdminUpdateUserBody, UpdateAppSettingsBody } from './settings.schemas';

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

  async listUsersForAdmin() {
    return this.prisma.user.findMany({
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        authPolicy: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async createUserForAdmin(input: AdminCreateUserBody) {
    const normalizedEmail = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({ message: 'User already exists' });
    }

    const passwordHash = await hashPassword(input.password);
    return this.prisma.user.create({
      data: {
        email: normalizedEmail,
        displayName: input.displayName?.trim() || null,
        role: input.role ?? 'user',
        isActive: input.isActive ?? true,
        authPolicy: 'password_or_webauthn',
        passwordHash,
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        authPolicy: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async updateUserForAdmin(adminUserId: string, userId: string, input: AdminUpdateUserBody) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isActive: true },
    });
    if (!user) {
      throw new NotFoundException({ message: 'User not found' });
    }
    if (user.id === adminUserId) {
      if (input.role && input.role !== 'admin') {
        throw new ForbiddenException({ message: 'Cannot remove your own admin role' });
      }
      if (typeof input.isActive === 'boolean' && !input.isActive) {
        throw new ForbiddenException({ message: 'Cannot deactivate your own account' });
      }
    }

    const data: {
      displayName?: string | null;
      role?: 'admin' | 'user';
      isActive?: boolean;
      passwordHash?: string;
    } = {};
    if (Object.prototype.hasOwnProperty.call(input, 'displayName')) {
      data.displayName = input.displayName?.trim() || null;
    }
    if (input.role) {
      data.role = input.role;
    }
    if (typeof input.isActive === 'boolean') {
      data.isActive = input.isActive;
    }
    if (input.password) {
      data.passwordHash = await hashPassword(input.password);
    }

    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        authPolicy: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
