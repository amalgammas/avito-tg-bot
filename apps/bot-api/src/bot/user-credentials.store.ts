import { Injectable } from '@nestjs/common';

export interface UserOzonCredentials {
  clientId: string;
  apiKey: string;
  verifiedAt: Date;
}

@Injectable()
export class UserCredentialsStore {
  private readonly storage = new Map<string, UserOzonCredentials>();

  set(chatId: string, credentials: Omit<UserOzonCredentials, 'verifiedAt'>): void {
    this.storage.set(chatId, { ...credentials, verifiedAt: new Date() });
  }

  get(chatId: string): UserOzonCredentials | undefined {
    return this.storage.get(chatId);
  }

  clear(chatId: string): void {
    this.storage.delete(chatId);
  }

  has(chatId: string): boolean {
    return this.storage.has(chatId);
  }
}
