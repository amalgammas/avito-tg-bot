import { Injectable } from '@nestjs/common';

export interface UserOzonCredentials {
  clientId: string;
  apiKey: string;
  verifiedAt: Date;
  clusters?: Array<{ id: number; name?: string }>;
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

  entries(): Array<{ chatId: string; credentials: UserOzonCredentials }> {
    return [...this.storage.entries()].map(([chatId, credentials]) => ({ chatId, credentials }));
  }

  updateClusters(chatId: string, clusters: Array<{ id: number; name?: string }>): void {
    const existing = this.storage.get(chatId);
    if (!existing) return;
    this.storage.set(chatId, { ...existing, clusters, verifiedAt: new Date() });
  }
}
