import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import type { AuthenticatedWebRequest } from '../common/web-request';
import { WebAuthService } from './web-auth.service';

@Injectable()
export class WebSessionGuard implements CanActivate {
  constructor(private readonly authService: WebAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedWebRequest>();
    const user = await this.authService.resolveSessionUserFromRequest(request);
    if (!user) {
      throw new UnauthorizedException('Сессия не найдена.');
    }
    request.webUser = user;
    return true;
  }
}
