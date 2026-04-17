import { BadRequestException, Injectable } from '@nestjs/common';

import { OzonAccessDeniedError, OzonApiService } from '../../config/ozon-api.service';
import { SupplyOrderStore } from '../../storage/supply-order.store';
import { UserCredentialsStore } from '../../bot/user-credentials.store';
import type { WebSessionUser } from '../common/web-auth.types';

@Injectable()
export class WebAccountService {
  constructor(
    private readonly credentialsStore: UserCredentialsStore,
    private readonly orderStore: SupplyOrderStore,
    private readonly ozonApi: OzonApiService,
  ) {}

  toActorId(user: WebSessionUser): string {
    return `web:${user.id}`;
  }

  async getProfile(user: WebSessionUser) {
    const actorId = this.toActorId(user);
    const credentials = await this.credentialsStore.get(actorId);
    const tasks = await this.orderStore.listTasks({ chatId: actorId });

    return {
      id: user.id,
      email: user.email,
      ozonConnected: Boolean(credentials),
      counts: {
        all: tasks.length,
        inProgress: tasks.filter((item) => item.status === 'task').length,
        completed: tasks.filter((item) => item.status === 'supply').length,
        failed: tasks.filter((item) => item.status?.startsWith('failed_')).length,
      },
    };
  }

  async getOzonCredentials(user: WebSessionUser) {
    const credentials = await this.credentialsStore.get(this.toActorId(user));
    return credentials
      ? {
          connected: true,
          clientId: this.maskValue(credentials.clientId),
          apiKey: this.maskValue(credentials.apiKey),
          verifiedAt: credentials.verifiedAt.toISOString(),
          accessExpiresAt: credentials.accessExpiresAt.toISOString(),
        }
      : { connected: false };
  }

  async updateOzonCredentials(user: WebSessionUser, payload: { clientId: string; apiKey: string }) {
    const actorId = this.toActorId(user);

    try {
      await this.ozonApi.validateSupplyOrderAccess(payload);
    } catch (error) {
      if (error instanceof OzonAccessDeniedError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    await this.credentialsStore.set(actorId, payload);
    return this.getOzonCredentials(user);
  }

  async clearOzonCredentials(user: WebSessionUser) {
    await this.credentialsStore.clear(this.toActorId(user));
    return { connected: false };
  }

  private maskValue(value: string): string {
    if (value.length <= 6) {
      return '*'.repeat(Math.max(value.length, 3));
    }
    return `${value.slice(0, 3)}***${value.slice(-3)}`;
  }
}
