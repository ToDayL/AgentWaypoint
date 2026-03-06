import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';

const EmailHeaderSchema = z.string().trim().email();

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawHeader = request.headers['x-user-email'];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    const parsedEmail = EmailHeaderSchema.safeParse(headerValue);
    if (!parsedEmail.success) {
      throw new UnauthorizedException({
        message: 'Missing or invalid x-user-email header',
      });
    }

    const user = await this.authService.getOrCreateUserByEmail(parsedEmail.data);
    request.currentUser = { id: user.id, email: user.email };

    return true;
  }
}
