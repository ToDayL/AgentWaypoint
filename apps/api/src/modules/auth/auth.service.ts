import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthSession, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest, RequestPrincipal } from './auth.types';

const PASSWORD_HASH_VERSION = 'scryptv1';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

@Injectable()
export class AuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getOrCreateUserByEmail(email: string): Promise<User> {
    const normalizedEmail = email.trim().toLowerCase();
    return this.prisma.user.upsert({
      where: { email: normalizedEmail },
      update: {},
      create: { email: normalizedEmail },
    });
  }

  async resolveRequestPrincipal(request: AuthenticatedRequest): Promise<RequestPrincipal | null> {
    const sessionPrincipal = await this.resolveSessionPrincipal(request);
    if (sessionPrincipal) {
      return sessionPrincipal;
    }

    if (isDevEmailHeaderEnabled()) {
      return this.resolveDevHeaderPrincipal(request);
    }

    return null;
  }

  async loginWithPassword(
    email: string,
    password: string,
    metadata: { ip: string | null; userAgent: string | null },
  ): Promise<{ user: User; sessionToken: string; expiresAt: Date }> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException({ message: 'Invalid email or password' });
    }
    if (!user.passwordHash?.trim()) {
      throw new UnauthorizedException({ message: 'Password login is not available for this account' });
    }
    if (!isPasswordLoginAllowed(user.authPolicy)) {
      throw new ForbiddenException({ message: 'Password login is disabled for this account' });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException({ message: 'Invalid email or password' });
    }

    const expiresAt = new Date(Date.now() + readSessionTtlHours() * 60 * 60 * 1000);
    const sessionToken = generateSessionToken();
    await this.prisma.$transaction(async (tx) => {
      await tx.authSession.create({
        data: {
          userId: user.id,
          sessionTokenHash: hashToken(sessionToken),
          expiresAt,
          ip: metadata.ip,
          userAgent: metadata.userAgent,
        },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
    });

    return {
      user,
      sessionToken,
      expiresAt,
    };
  }

  async getAuthenticatedSession(request: AuthenticatedRequest): Promise<CurrentAuthSession | null> {
    const principal = await this.resolveSessionPrincipal(request);
    if (!principal) {
      return null;
    }
    return {
      principal,
    };
  }

  async revokeSessionToken(sessionToken: string): Promise<void> {
    if (!sessionToken.trim()) {
      return;
    }
    const session = await this.prisma.authSession.findUnique({
      where: { sessionTokenHash: hashToken(sessionToken) },
      select: { id: true, revokedAt: true },
    });
    if (!session || session.revokedAt) {
      return;
    }
    await this.prisma.authSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
  }

  async revokeSessionFromRequest(request: AuthenticatedRequest): Promise<void> {
    const token = readSessionTokenFromRequest(request);
    if (!token) {
      return;
    }
    await this.revokeSessionToken(token);
  }

  async hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException({ message: 'Authentication required' });
    }
    if (!user.passwordHash?.trim()) {
      throw new UnauthorizedException({ message: 'Password login is not available for this account' });
    }
    if (!isPasswordLoginAllowed(user.authPolicy)) {
      throw new ForbiddenException({ message: 'Password login is disabled for this account' });
    }

    const currentPasswordValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!currentPasswordValid) {
      throw new UnauthorizedException({ message: 'Current password is incorrect' });
    }

    const nextPasswordHash = await hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: nextPasswordHash },
    });
  }

  private async resolveSessionPrincipal(request: AuthenticatedRequest): Promise<RequestPrincipal | null> {
    const token = readSessionTokenFromRequest(request);
    if (!token) {
      return null;
    }

    const session = await this.prisma.authSession.findUnique({
      where: { sessionTokenHash: hashToken(token) },
      include: {
        user: true,
      },
    });
    if (!session) {
      return null;
    }

    if (!isActiveSession(session)) {
      return null;
    }
    if (!session.user.isActive) {
      return null;
    }

    await this.prisma.authSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });

    return {
      type: 'user',
      userId: session.user.id,
      email: session.user.email,
      role: session.user.role === 'admin' ? 'admin' : 'user',
      authMethod: 'session',
    };
  }

  private async resolveDevHeaderPrincipal(request: AuthenticatedRequest): Promise<RequestPrincipal | null> {
    const email = readDevHeaderEmail(request);
    if (!email) {
      return null;
    }

    const user = await this.getOrCreateUserByEmail(email);
    return {
      type: 'user',
      userId: user.id,
      email: user.email,
      role: user.role === 'admin' ? 'admin' : 'user',
      authMethod: 'dev_header',
    };
  }
}

export type CurrentAuthSession = {
  principal: RequestPrincipal;
};

export function readSessionCookieName(): string {
  return (process.env.AUTH_SESSION_COOKIE_NAME?.trim() || 'aw_session').replace(/[;\s]/g, '');
}

export function readSessionTtlHours(): number {
  const parsed = Number.parseInt(process.env.AUTH_SESSION_TTL_HOURS ?? '168', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 168;
  }
  return parsed;
}

function isDevEmailHeaderEnabled(): boolean {
  const value = (process.env.AUTH_DEV_EMAIL_HEADER ?? '1').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function isPasswordLoginAllowed(authPolicy: string): boolean {
  const policy = authPolicy.trim().toLowerCase();
  if (!policy) {
    return true;
  }
  return policy !== 'webauthn_only';
}

function readDevHeaderEmail(request: AuthenticatedRequest): string | null {
  const rawHeader = request.headers['x-user-email'];
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof headerValue !== 'string') {
    return null;
  }
  const normalized = headerValue.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

function readSessionTokenFromRequest(request: AuthenticatedRequest): string | null {
  const rawCookieHeader = request.headers.cookie;
  const cookieHeader = Array.isArray(rawCookieHeader) ? rawCookieHeader[0] : rawCookieHeader;
  if (typeof cookieHeader !== 'string' || !cookieHeader.trim()) {
    return null;
  }
  const cookieName = readSessionCookieName();
  const parsed = parseCookieHeader(cookieHeader);
  const token = parsed.get(cookieName);
  return token?.trim() || null;
}

function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const cookieMap = new Map<string, string>();
  cookieHeader.split(';').forEach((entry) => {
    const [rawKey, ...rawValueParts] = entry.split('=');
    if (!rawKey) {
      return;
    }
    const key = rawKey.trim();
    if (!key) {
      return;
    }
    const value = rawValueParts.join('=').trim();
    cookieMap.set(key, decodeURIComponentSafe(value));
  });
  return cookieMap;
}

function decodeURIComponentSafe(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function isActiveSession(session: Pick<AuthSession, 'expiresAt' | 'revokedAt'>): boolean {
  if (session.revokedAt) {
    return false;
  }
  return session.expiresAt.getTime() > Date.now();
}

function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const key = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }) as Buffer;
  return `${PASSWORD_HASH_VERSION}$${salt}$${key.toString('base64url')}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [version, salt, keyData] = storedHash.split('$');
  if (version !== PASSWORD_HASH_VERSION || !salt || !keyData) {
    return false;
  }
  const expected = Buffer.from(keyData, 'base64url');
  const actual = scryptSync(password, salt, expected.length, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }) as Buffer;
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}
