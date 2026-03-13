import { Body, Controller, Get, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { parseWithZod } from '../../common/validation/zod';
import { AuthService, readSessionCookieName } from './auth.service';
import { PasswordChangeBodySchema, PasswordLoginBodySchema } from './auth.schemas';
import { AuthenticatedRequest } from './auth.types';

type ReplyLike = {
  header: (name: string, value: string) => void;
};

@Controller('/api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('/login/password')
  async loginWithPassword(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: ReplyLike) {
    const input = parseWithZod(PasswordLoginBodySchema, body);
    const loginResult = await this.authService.loginWithPassword(input.email, input.password, {
      ip: readFirstHeaderValue(request.headers['x-forwarded-for']) ?? request.ip ?? null,
      userAgent: readFirstHeaderValue(request.headers['user-agent']),
    });
    setSessionCookie(reply, loginResult.sessionToken, loginResult.expiresAt);

    return {
      user: {
        id: loginResult.user.id,
        email: loginResult.user.email,
        role: loginResult.user.role === 'admin' ? 'admin' : 'user',
      },
    };
  }

  @Post('/logout')
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: ReplyLike) {
    await this.authService.revokeSessionFromRequest(request);
    clearSessionCookie(reply);
    return { success: true };
  }

  @Post('/password/change')
  async changePassword(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = parseWithZod(PasswordChangeBodySchema, body);
    const session = await this.authService.getAuthenticatedSession(request);
    if (!session || session.principal.type !== 'user') {
      throw new UnauthorizedException({ message: 'Authentication required' });
    }

    await this.authService.changePassword(session.principal.userId, input.currentPassword, input.newPassword);
    return { success: true };
  }

  @Get('/session')
  async getSession(@Req() request: AuthenticatedRequest) {
    const session = await this.authService.getAuthenticatedSession(request);
    if (!session || session.principal.type !== 'user') {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      principal: {
        type: 'user',
        userId: session.principal.userId,
        email: session.principal.email,
        role: session.principal.role,
        authMethod: session.principal.authMethod,
      },
    };
  }
}

function setSessionCookie(reply: ReplyLike, sessionToken: string, expiresAt: Date): void {
  const maxAge = Math.max(Math.floor((expiresAt.getTime() - Date.now()) / 1000), 1);
  const parts = [
    `${readSessionCookieName()}=${encodeURIComponent(sessionToken)}`,
    'Path=/',
    'HttpOnly',
    process.env.NODE_ENV === 'development' ? '' : 'Secure',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${maxAge}`,
  ].filter((entry) => entry.length > 0);
  reply.header('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(reply: ReplyLike): void {
  const parts = [
    `${readSessionCookieName()}=`,
    'Path=/',
    'HttpOnly',
    process.env.NODE_ENV === 'development' ? '' : 'Secure',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ].filter((entry) => entry.length > 0);
  reply.header('Set-Cookie', parts.join('; '));
}

function readFirstHeaderValue(input: string | string[] | undefined): string | null {
  if (Array.isArray(input)) {
    return input[0]?.trim() || null;
  }
  return typeof input === 'string' ? input.trim() || null : null;
}
