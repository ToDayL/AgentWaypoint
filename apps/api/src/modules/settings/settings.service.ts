import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from '../auth/auth.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';
import { AdminCreateUserBody, AdminUpdateUserBody, UpdateAppSettingsBody } from './settings.schemas';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter,
  ) {}

  async getAppSettings(userId: string) {
    const settings = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        turnSteerEnabled: true,
        defaultWorkspaceRoot: true,
      },
    });
    return {
      ...settings,
      supportedBackends: await this.readSupportedBackends(),
    };
  }

  async updateAppSettings(userId: string, input: UpdateAppSettingsBody) {
    const data: {
      turnSteerEnabled?: boolean;
      defaultWorkspaceRoot?: string | null;
    } = {};
    if (typeof input.turnSteerEnabled === 'boolean') {
      data.turnSteerEnabled = input.turnSteerEnabled;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'defaultWorkspaceRoot')) {
      data.defaultWorkspaceRoot = input.defaultWorkspaceRoot?.trim() || null;
    }

    const settings = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        turnSteerEnabled: true,
        defaultWorkspaceRoot: true,
      },
    });
    return {
      ...settings,
      supportedBackends: await this.readSupportedBackends(),
    };
  }

  async getCodexRateLimits() {
    const supportedBackends = await this.readSupportedBackends();
    if (!supportedBackends.includes('codex')) {
      return {
        rateLimits: null,
        rateLimitsByLimitId: null,
      };
    }
    try {
      return await this.runnerAdapter.readCodexRateLimits();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown runner error';
      this.logger.warn(`Failed to read codex rate limits from runner: ${message}`);
      return {
        rateLimits: null,
        rateLimitsByLimitId: null,
      };
    }
  }

  private async readSupportedBackends(): Promise<string[]> {
    try {
      const health = await this.runnerAdapter.getHealth();
      const supportedBackends = Array.isArray(health.supportedBackends)
        ? health.supportedBackends
            .map((item) => item.trim().toLowerCase())
            .filter((item) => item.length > 0)
        : [];
      const unique = Array.from(new Set(supportedBackends));
      return unique.length > 0 ? unique : ['codex'];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown runner error';
      this.logger.warn(`Failed to read runner health for backend capabilities: ${message}`);
      return ['codex'];
    }
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
        defaultWorkspaceRoot: true,
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
        defaultWorkspaceRoot: input.defaultWorkspaceRoot?.trim() || null,
        passwordHash,
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        authPolicy: true,
        defaultWorkspaceRoot: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async updateUserForAdmin(adminUserId: string, userId: string, input: AdminUpdateUserBody) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isActive: true, defaultWorkspaceRoot: true },
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
      defaultWorkspaceRoot?: string | null;
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
    if (Object.prototype.hasOwnProperty.call(input, 'defaultWorkspaceRoot')) {
      data.defaultWorkspaceRoot = input.defaultWorkspaceRoot?.trim() || null;
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
        defaultWorkspaceRoot: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
