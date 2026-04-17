import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';

import type { AuthenticatedWebRequest } from '../common/web-request';
import { CurrentWebUser } from './current-web-user.decorator';
import { WebSessionGuard } from './web-session.guard';
import { RequestMagicLinkDto } from '../dto/request-magic-link.dto';
import { VerifyMagicLinkDto } from '../dto/verify-magic-link.dto';
import { WebAuthService } from './web-auth.service';

@Controller('api/auth')
export class WebAuthController {
  constructor(private readonly authService: WebAuthService) {}

  @Post('request-magic-link')
  async requestMagicLink(@Body() body: RequestMagicLinkDto) {
    return this.authService.requestMagicLink(body.email);
  }

  @Post('verify-magic-link')
  async verifyMagicLink(@Body() body: VerifyMagicLinkDto, @Res({ passthrough: true }) res: any) {
    const result = await this.authService.verifyMagicLink(body.token);
    res.cookie(this.authService.getSessionCookieName(), result.sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      expires: new Date(result.expiresAt),
      path: '/',
    });

    return { user: result.user, expiresAt: result.expiresAt };
  }

  @Get('session')
  @UseGuards(WebSessionGuard)
  async getSession(@CurrentWebUser() user: { id: string; email: string }) {
    return { authenticated: true, user };
  }

  @Post('logout')
  async logout(@Req() req: AuthenticatedWebRequest, @Res({ passthrough: true }) res: any) {
    await this.authService.destroySessionFromRequest(req);
    res.cookie(this.authService.getSessionCookieName(), '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      expires: new Date(0),
      path: '/',
    });
    return { ok: true };
  }
}
