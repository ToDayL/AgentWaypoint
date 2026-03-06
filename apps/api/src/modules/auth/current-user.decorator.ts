import { UnauthorizedException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest, CurrentUser } from './auth.types';

export const CurrentUserDecorator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.currentUser) {
      throw new UnauthorizedException({ message: 'User context missing from request' });
    }

    return request.currentUser;
  },
);
