import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserCredentialsEntity } from '../storage/entities/user-credentials.entity';

export interface UserOzonCredentials {
  clientId: string;
  apiKey: string;
  verifiedAt: Date;
  clusters?: Array<{ id: number; name?: string }>;
}

@Injectable()
export class UserCredentialsStore {
  constructor(
    @InjectRepository(UserCredentialsEntity)
    private readonly repository: Repository<UserCredentialsEntity>,
  ) {}

  async set(chatId: string, credentials: Omit<UserOzonCredentials, 'verifiedAt'>): Promise<void> {
    const entity = this.repository.create({
      chatId,
      clientId: credentials.clientId,
      apiKey: credentials.apiKey,
      verifiedAt: new Date(),
      clusters: credentials.clusters,
    });

    await this.repository.save(entity);
  }

  async get(chatId: string): Promise<UserOzonCredentials | undefined> {
    const entity = await this.repository.findOne({ where: { chatId } });
    return entity ? this.mapEntity(entity) : undefined;
  }

  async clear(chatId: string): Promise<void> {
    await this.repository.delete({ chatId });
  }

  async has(chatId: string): Promise<boolean> {
    const count = await this.repository.count({ where: { chatId } });
    return count > 0;
  }

  async entries(): Promise<Array<{ chatId: string; credentials: UserOzonCredentials }>> {
    const records = await this.repository.find({ order: { verifiedAt: 'DESC' } });
    return records.map((record) => ({ chatId: record.chatId, credentials: this.mapEntity(record) }));
  }

  async updateClusters(chatId: string, clusters: Array<{ id: number; name?: string }>): Promise<void> {
    const entity = await this.repository.findOne({ where: { chatId } });
    if (!entity) {
      return;
    }

    entity.clusters = clusters;
    entity.verifiedAt = new Date();
    await this.repository.save(entity);
  }

  private mapEntity(entity: UserCredentialsEntity): UserOzonCredentials {
    return {
      clientId: entity.clientId,
      apiKey: entity.apiKey,
      verifiedAt: entity.verifiedAt,
      clusters: entity.clusters ?? undefined,
    };
  }
}
