import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

import type { WebSessionUser } from '../common/web-auth.types';

export const CurrentWebUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WebSessionUser => {
    const request = ctx.switchToHttp().getRequest<{ webUser?: WebSessionUser }>();
    if (!request.webUser) {
      throw new UnauthorizedException('Требуется авторизация.');
    }
    return request.webUser;
  },
);
