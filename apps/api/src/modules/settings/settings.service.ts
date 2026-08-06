import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from '../auth/auth.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';
import {
  AdminCreateUserBody,
  AdminUpdateUserBody,
  UpdateAppSettingsBody,
  UpdateCcSwitchProvidersBody,
} from './settings.schemas';
import { CC_SWITCH_CLIENT, CcSwitchApp, CcSwitchClient, CcSwitchState } from './cc-switch.client';

const ACTIVE_TURN_STATUSES = ['queued', 'running', 'waiting_approval'];
const RUNTIME_CONTROL_ID = 'provider-switch';
const PROVIDER_SWITCH_LEASE_MS = 2 * 60 * 1000;
const PROVIDER_SWITCH_LEASE_RENEW_MS = 30 * 1000;

export type CcSwitchSettingsState = CcSwitchState & {
  hasActiveTurn: boolean;
};

type ProviderSwitchLeaseHeartbeat = {
  assertHeld: () => void;
  renew: () => Promise<void>;
  stop: () => void;
};

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private providerSwitchInProgress = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter,
    @Inject(CC_SWITCH_CLIENT) private readonly ccSwitchClient: CcSwitchClient,
  ) {}

  async assertProviderSwitchAllowsTurn(tx: Prisma.TransactionClient): Promise<void> {
    const now = new Date();
    const control = await tx.runtimeControl.upsert({
      where: { id: RUNTIME_CONTROL_ID },
      create: { id: RUNTIME_CONTROL_ID },
      update: { updatedAt: now },
    });
    const leaseActive =
      control.providerSwitchInProgress &&
      control.providerSwitchLeaseExpires !== null &&
      control.providerSwitchLeaseExpires.getTime() > now.getTime();
    if (leaseActive) {
      throw new ConflictException({ message: 'Provider switch in progress; try again shortly' });
    }
    if (control.providerSwitchInProgress) {
      await tx.runtimeControl.update({
        where: { id: RUNTIME_CONTROL_ID },
        data: {
          providerSwitchInProgress: false,
          providerSwitchOwner: null,
          providerSwitchLeaseExpires: null,
        },
      });
    }
  }

  async getCcSwitchProviders(): Promise<CcSwitchSettingsState> {
    const hasActiveTurn = await this.hasActiveTurn();
    if ((process.env.RUNNER_MODE ?? 'embedded').trim().toLowerCase() === 'http') {
      return {
        ...unavailableCcSwitchState('Provider switching requires an embedded runner on the cc-switch host'),
        hasActiveTurn,
      };
    }
    return { ...(await this.ccSwitchClient.discover()), hasActiveTurn };
  }

  async updateCcSwitchProviders(input: UpdateCcSwitchProvidersBody): Promise<CcSwitchState> {
    if (this.providerSwitchInProgress) {
      throw new ConflictException({ message: 'A provider switch is already in progress' });
    }
    this.providerSwitchInProgress = true;
    let switchOwner: string | null = null;
    let leaseHeartbeat: ProviderSwitchLeaseHeartbeat | null = null;
    try {
      switchOwner = await this.acquireProviderSwitchLease();
      leaseHeartbeat = this.startProviderSwitchLeaseHeartbeat(switchOwner);
      const state = await this.getCcSwitchProviders();
      leaseHeartbeat.assertHeld();
      if (!state.canSwitch) {
        throw new ConflictException({ message: state.reason ?? 'cc-switch is unavailable' });
      }
      const requested = requestedProviderUpdates(input);
      for (const [app, providerId] of requested) {
        assertRequestedProvider(state, app, providerId);
      }

      const previous: Record<CcSwitchApp, string> = {
        codex: selectedProviderId(state.providers.codex),
        claude: selectedProviderId(state.providers.claude),
      };
      for (const [app] of requested) {
        if (input.expectedCurrent?.[app] !== previous[app]) {
          throw new ConflictException({ message: `${app} provider changed outside this settings page; refresh and try again` });
        }
      }
      const switched: CcSwitchApp[] = [];
      try {
        for (const [app, providerId] of requested) {
          if (providerId !== previous[app]) {
            await leaseHeartbeat.renew();
            await this.ccSwitchClient.switchProvider(app, providerId);
            switched.push(app);
            leaseHeartbeat.assertHeld();
          }
        }
      } catch (error: unknown) {
        for (const app of [...switched].reverse()) {
          try {
            await this.ccSwitchClient.switchProvider(app, previous[app]);
          } catch {
            this.logger.error(`Failed to roll back ${app} provider after unsuccessful switch`);
          }
        }
        throw error;
      }

      if (switched.includes('codex')) {
        await leaseHeartbeat.renew();
        await this.runnerAdapter.resetWorkers();
        leaseHeartbeat.assertHeld();
      }
      return this.getCcSwitchProviders();
    } finally {
      leaseHeartbeat?.stop();
      if (switchOwner) {
        try {
          await this.releaseProviderSwitchLease(switchOwner);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'unknown database error';
          this.logger.error(`Failed to release provider switch lease: ${message}`);
        }
      }
      this.providerSwitchInProgress = false;
    }
  }

  private async acquireProviderSwitchLease(): Promise<string> {
    const owner = randomUUID();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const control = await tx.runtimeControl.upsert({
        where: { id: RUNTIME_CONTROL_ID },
        create: { id: RUNTIME_CONTROL_ID },
        update: { updatedAt: now },
      });
      const leaseActive =
        control.providerSwitchInProgress &&
        control.providerSwitchLeaseExpires !== null &&
        control.providerSwitchLeaseExpires.getTime() > now.getTime();
      if (leaseActive) {
        throw new ConflictException({ message: 'A provider switch is already in progress' });
      }

      const activeTurn = await tx.turn.findFirst({
        where: { status: { in: ACTIVE_TURN_STATUSES } },
        select: { id: true },
      });
      if (activeTurn) {
        throw new ConflictException({ message: 'Cannot switch providers while a turn is active' });
      }

      await tx.runtimeControl.update({
        where: { id: RUNTIME_CONTROL_ID },
        data: {
          providerSwitchInProgress: true,
          providerSwitchOwner: owner,
          providerSwitchLeaseExpires: new Date(now.getTime() + PROVIDER_SWITCH_LEASE_MS),
        },
      });
    });
    return owner;
  }

  private async releaseProviderSwitchLease(owner: string): Promise<void> {
    await this.prisma.runtimeControl.updateMany({
      where: {
        id: RUNTIME_CONTROL_ID,
        providerSwitchOwner: owner,
      },
      data: {
        providerSwitchInProgress: false,
        providerSwitchOwner: null,
        providerSwitchLeaseExpires: null,
      },
    });
  }

  private startProviderSwitchLeaseHeartbeat(owner: string): ProviderSwitchLeaseHeartbeat {
    let stopped = false;
    let lost = false;
    let renewal: Promise<void> | null = null;
    const renew = async (): Promise<void> => {
      if (stopped || lost) {
        return;
      }
      if (renewal) {
        return renewal;
      }
      renewal = (async () => {
        try {
          const renewed = await this.prisma.runtimeControl.updateMany({
            where: {
              id: RUNTIME_CONTROL_ID,
              providerSwitchInProgress: true,
              providerSwitchOwner: owner,
            },
            data: {
              providerSwitchLeaseExpires: new Date(Date.now() + PROVIDER_SWITCH_LEASE_MS),
            },
          });
          if (renewed.count !== 1) {
            lost = true;
          }
        } catch (error: unknown) {
          lost = true;
          const message = error instanceof Error ? error.message : 'unknown database error';
          this.logger.error(`Failed to renew provider switch lease: ${message}`);
        } finally {
          renewal = null;
        }
      })();
      return renewal;
    };
    const timer = setInterval(() => {
      void renew();
    }, PROVIDER_SWITCH_LEASE_RENEW_MS);
    timer.unref?.();

    return {
      assertHeld: () => {
        if (lost) {
          throw new ConflictException({ message: 'Provider switch lease was lost; refresh and try again' });
        }
      },
      renew: async () => {
        await renew();
        if (lost) {
          throw new ConflictException({ message: 'Provider switch lease was lost; refresh and try again' });
        }
      },
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private async hasActiveTurn(): Promise<boolean> {
    return !!(await this.prisma.turn.findFirst({
      where: { status: { in: ACTIVE_TURN_STATUSES } },
      select: { id: true },
    }));
  }

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

function assertRequestedProvider(state: CcSwitchState, app: CcSwitchApp, id: string): void {
  if (!state.providers[app].some((provider) => provider.id === id)) {
    throw new ConflictException({ message: `Unknown ${app} provider` });
  }
}

function requestedProviderUpdates(input: UpdateCcSwitchProvidersBody): Array<[CcSwitchApp, string]> {
  const updates: Array<[CcSwitchApp, string]> = [];
  if (input.codexProviderId) {
    updates.push(['codex', input.codexProviderId]);
  }
  if (input.claudeProviderId) {
    updates.push(['claude', input.claudeProviderId]);
  }
  return updates;
}

function selectedProviderId(providers: CcSwitchState['providers'][CcSwitchApp]): string {
  const current = providers.find((provider) => provider.current) ?? providers[0];
  if (!current) {
    throw new ConflictException({ message: 'cc-switch did not return a current provider' });
  }
  return current.id;
}

function unavailableCcSwitchState(reason: string): CcSwitchState {
  return {
    available: false,
    canSwitch: false,
    reason,
    providers: {
      codex: [{ id: 'codex-official', name: 'codex-official', current: true }],
      claude: [{ id: 'claude-official', name: 'claude-official', current: true }],
    },
  };
}
