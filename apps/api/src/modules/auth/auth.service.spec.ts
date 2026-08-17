import type { AuthSession, User } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { AuthService } from './auth.service.js';

function authenticatedRequest(): AuthenticatedRequest {
  return {
    headers: {
      cookie: 'aw_session=test-token',
    },
  };
}

function activeSession(lastSeenAt: Date): AuthSession & { user: User } {
  const now = new Date();
  return {
    id: 'session-1',
    userId: 'user-1',
    sessionTokenHash: 'hash',
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    lastSeenAt,
    revokedAt: null,
    ip: null,
    userAgent: null,
    user: {
      id: 'user-1',
      email: 'user@example.com',
      displayName: null,
      isActive: true,
      role: 'user',
      authPolicy: 'password_or_webauthn',
      passwordHash: null,
      lastLoginAt: null,
      turnSteerEnabled: false,
      defaultWorkspaceRoot: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe('AuthService session activity tracking', () => {
  it('does not write lastSeenAt when it was updated recently', async () => {
    const update = vi.fn();
    const service = new AuthService({
      authSession: {
        findUnique: vi.fn().mockResolvedValue(activeSession(new Date())),
        update,
      },
    } as unknown as PrismaService);

    await expect(service.resolveRequestPrincipal(authenticatedRequest())).resolves.toMatchObject({
      userId: 'user-1',
      authMethod: 'session',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('coalesces concurrent stale-session touches without blocking authentication', async () => {
    let finishUpdate: (() => void) | undefined;
    const pendingUpdate = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    const update = vi.fn().mockReturnValue(pendingUpdate);
    const session = activeSession(new Date(Date.now() - 10 * 60 * 1000));
    const service = new AuthService({
      authSession: {
        findUnique: vi.fn().mockResolvedValue(session),
        update,
      },
    } as unknown as PrismaService);

    const principals = await Promise.all([
      service.resolveRequestPrincipal(authenticatedRequest()),
      service.resolveRequestPrincipal(authenticatedRequest()),
      service.resolveRequestPrincipal(authenticatedRequest()),
    ]);

    expect(principals).toHaveLength(3);
    expect(principals.every((principal) => principal?.userId === 'user-1')).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    finishUpdate?.();
    await pendingUpdate;
  });
});
