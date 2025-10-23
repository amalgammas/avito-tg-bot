import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserCredentialsEntity } from '../storage/entities/user-credentials.entity';

export interface UserOzonCredentials {
  clientId: string;
  apiKey: string;
  verifiedAt: Date;
}

@Injectable()
export class UserCredentialsStore {
  constructor(
    @InjectRepository(UserCredentialsEntity)
    private readonly repository: Repository<UserCredentialsEntity>,
  ) {}

  async set(chatId: string, credentials: Omit<UserOzonCredentials, 'verifiedAt'>): Promise<void> {
    const entity =
      (await this.repository.findOne({ where: { chatId } })) ??
      this.repository.create({ chatId });

    entity.clientId = credentials.clientId;
    entity.apiKey = credentials.apiKey;
    entity.verifiedAt = new Date();
    await this.repository.save(entity);
  }

  async get(chatId: string): Promise<UserOzonCredentials | undefined> {
    const entity = await this.repository.findOne({ where: { chatId } });
    return this.toCredentials(entity);
  }

  async clear(chatId: string): Promise<void> {
    await this.repository.update(
      { chatId },
      {
        clientId: null,
        apiKey: null,
        verifiedAt: null,
      },
    );
  }

  async has(chatId: string): Promise<boolean> {
    const entity = await this.repository.findOne({ where: { chatId } });
    return Boolean(this.toCredentials(entity));
  }

  async entries(chatId?: string): Promise<Array<{ chatId: string; credentials: UserOzonCredentials }>> {
    const where = chatId ? { chatId } : undefined;
    const records = await this.repository.find({ where, order: { verifiedAt: 'DESC' } });

    return records.reduce<Array<{ chatId: string; credentials: UserOzonCredentials }>>((acc, record) => {
      const credentials = this.toCredentials(record);
      if (!credentials) {
        return acc;
      }
      acc.push({ chatId: record.chatId, credentials });
      return acc;
    }, []);
  }

  private toCredentials(entity: UserCredentialsEntity | null | undefined): UserOzonCredentials | undefined {
    if (!entity) {
      return undefined;
    }

    const clientId = entity.clientId?.trim();
    const apiKey = entity.apiKey?.trim();
    if (!clientId || !apiKey || !entity.verifiedAt) {
      return undefined;
    }

    return {
      clientId,
      apiKey,
      verifiedAt: entity.verifiedAt,
    };
  }
}
