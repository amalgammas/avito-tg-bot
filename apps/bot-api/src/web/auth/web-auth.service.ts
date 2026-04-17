import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Repository } from 'typeorm';

import { WebAuthTokenEntity } from '../../storage/entities/web-auth-token.entity';
import { WebSessionEntity } from '../../storage/entities/web-session.entity';
import { WebUserEntity } from '../../storage/entities/web-user.entity';
import type { AuthenticatedWebRequest } from '../common/web-request';
import type { WebSessionUser } from '../common/web-auth.types';
import { WebMailerService } from '../services/web-mailer.service';

@Injectable()
export class WebAuthService {
  constructor(
    @InjectRepository(WebUserEntity)
    private readonly usersRepository: Repository<WebUserEntity>,
    @InjectRepository(WebAuthTokenEntity)
    private readonly authTokensRepository: Repository<WebAuthTokenEntity>,
    @InjectRepository(WebSessionEntity)
    private readonly sessionsRepository: Repository<WebSessionEntity>,
    private readonly config: ConfigService,
    private readonly mailer: WebMailerService,
  ) {}

  async requestMagicLink(emailRaw: string): Promise<{ delivery: 'resend' | 'log'; previewUrl?: string }> {
    const email = this.normalizeEmail(emailRaw);
    if (!email) {
      throw new UnauthorizedException('Укажите корректный email.');
    }

    const user = await this.findOrCreateUser(email);
    const token = randomBytes(24).toString('hex');
    const now = Date.now();
    const ttlMinutes = this.config.get<number>('web.magicLinkTtlMinutes') ?? 20;

    await this.authTokensRepository.save(
      this.authTokensRepository.create({
        id: randomUUID(),
        userId: user.id,
        tokenHash: this.hashValue(token),
        expiresAt: now + ttlMinutes * 60 * 1000,
        createdAt: now,
      }),
    );

    const appUrl = (this.config.get<string>('web.appUrl') ?? 'http://localhost:4200').replace(/\/$/, '');
    const magicLink = `${appUrl}/login/verify?token=${encodeURIComponent(token)}`;
    const delivery = await this.mailer.sendMagicLink(email, magicLink);
    return { delivery: delivery.mode, previewUrl: delivery.previewUrl };
  }

  async verifyMagicLink(token: string): Promise<{ user: WebSessionUser; sessionToken: string; expiresAt: number }> {
    const normalizedToken = token.trim();
    if (!normalizedToken) {
      throw new UnauthorizedException('Токен входа пуст.');
    }

    const now = Date.now();
    const tokenHash = this.hashValue(normalizedToken);
    const authToken = await this.authTokensRepository.findOne({ where: { tokenHash } });

    if (!authToken || authToken.consumedAt || authToken.expiresAt < now) {
      throw new UnauthorizedException('Ссылка для входа недействительна или истекла.');
    }

    const user = await this.usersRepository.findOne({ where: { id: authToken.userId } });
    if (!user) {
      throw new UnauthorizedException('Пользователь не найден.');
    }

    await this.sessionsRepository.delete({ userId: user.id });

    const sessionToken = randomBytes(32).toString('hex');
    const sessionTtlDays = this.config.get<number>('web.sessionTtlDays') ?? 30;
    const expiresAt = now + sessionTtlDays * 24 * 60 * 60 * 1000;

    await this.sessionsRepository.save(
      this.sessionsRepository.create({
        id: randomUUID(),
        userId: user.id,
        sessionHash: this.hashValue(sessionToken),
        expiresAt,
        createdAt: now,
        lastSeenAt: now,
      }),
    );

    authToken.consumedAt = now;
    await this.authTokensRepository.save(authToken);

    user.lastLoginAt = now;
    user.updatedAt = now;
    await this.usersRepository.save(user);

    return {
      user: { id: user.id, email: user.email },
      sessionToken,
      expiresAt,
    };
  }

  async resolveSessionUserFromRequest(request: AuthenticatedWebRequest): Promise<WebSessionUser | undefined> {
    const cookieName = this.config.get<string>('web.sessionCookieName') ?? 'ozon_web_session';
    const sessionToken = this.parseCookies(request.headers.cookie)[cookieName];
    if (!sessionToken) {
      return undefined;
    }

    const session = await this.sessionsRepository.findOne({
      where: { sessionHash: this.hashValue(sessionToken) },
    });
    if (!session || session.expiresAt < Date.now()) {
      return undefined;
    }

    const user = await this.usersRepository.findOne({ where: { id: session.userId } });
    if (!user) {
      return undefined;
    }

    session.lastSeenAt = Date.now();
    await this.sessionsRepository.save(session);
    return { id: user.id, email: user.email };
  }

  async destroySessionFromRequest(request: AuthenticatedWebRequest): Promise<void> {
    const cookieName = this.config.get<string>('web.sessionCookieName') ?? 'ozon_web_session';
    const sessionToken = this.parseCookies(request.headers.cookie)[cookieName];
    if (!sessionToken) {
      return;
    }
    await this.sessionsRepository.delete({ sessionHash: this.hashValue(sessionToken) });
  }

  getSessionCookieName(): string {
    return this.config.get<string>('web.sessionCookieName') ?? 'ozon_web_session';
  }

  private async findOrCreateUser(email: string): Promise<WebUserEntity> {
    const existing = await this.usersRepository.findOne({ where: { email } });
    if (existing) {
      return existing;
    }

    const now = Date.now();
    return this.usersRepository.save(
      this.usersRepository.create({
        id: randomUUID(),
        email,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private hashValue(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private parseCookies(cookieHeader?: string | string[]): Record<string, string> {
    if (!cookieHeader) {
      return {};
    }
    const rawValue = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
    return rawValue.split(';').reduce<Record<string, string>>((acc, item) => {
      const [rawName, ...rest] = item.split('=');
      const name = rawName?.trim();
      if (!name) {
        return acc;
      }
      acc[name] = decodeURIComponent(rest.join('=').trim());
      return acc;
    }, {});
  }
}
