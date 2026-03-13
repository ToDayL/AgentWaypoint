import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.authService.resolveRequestPrincipal(request);
    if (!principal || principal.type !== 'user') {
      throw new UnauthorizedException({ message: 'Authentication required' });
    }
    request.principal = principal;
    request.currentUser = {
      id: principal.userId,
      email: principal.email,
      role: principal.role,
      authMethod: principal.authMethod,
    };

    return true;
  }
}
