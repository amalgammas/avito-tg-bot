import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { endOfMoscowDay } from '../utils/time.utils';
import { UserCredentialsEntity } from '../storage/entities/user-credentials.entity';

export interface UserOzonCredentials {
  clientId: string;
  apiKey: string;
  verifiedAt: Date;
  accessExpiresAt: Date;
}

export interface UserAccessInfo {
  chatId: string;
  clientId?: string;
  accessExpiresAt?: Date;
}

export interface UserAccessStatus extends UserAccessInfo {
  expired: boolean;
}

@Injectable()
export class UserCredentialsStore {
  private readonly trialPeriodDays = 30;
  private schemaEnsurePromise?: Promise<void>;

  constructor(
    @InjectRepository(UserCredentialsEntity)
    private readonly repository: Repository<UserCredentialsEntity>,
  ) {}

  async set(chatId: string, credentials: Omit<UserOzonCredentials, 'verifiedAt' | 'accessExpiresAt'>): Promise<void> {
    await this.ensureSchemaCompatibility();
    const entity =
      (await this.repository.findOne({ where: { chatId } })) ??
      this.repository.create({ chatId, accessExpiresAt: this.createDefaultAccessExpiresAt() });
    const inheritedAccessExpiresAt = await this.resolveAccessExpiresAtForClientId(credentials.clientId, chatId);

    entity.clientId = credentials.clientId;
    entity.apiKey = credentials.apiKey;
    entity.verifiedAt = new Date();
    entity.accessExpiresAt = inheritedAccessExpiresAt ?? entity.accessExpiresAt ?? this.createDefaultAccessExpiresAt();
    await this.repository.save(entity);
  }

  async get(chatId: string): Promise<UserOzonCredentials | undefined> {
    await this.ensureSchemaCompatibility();
    const entity = await this.repository.findOne({ where: { chatId } });
    return this.toCredentials(entity);
  }

  async clear(chatId: string): Promise<boolean> {
    await this.ensureSchemaCompatibility();
    const entity = await this.repository.findOne({ where: { chatId } });
    if (!entity) {
      return false;
    }

    const hadValues = Boolean(entity.clientId?.trim() || entity.apiKey?.trim() || entity.verifiedAt);
    entity.clientId = null;
    entity.apiKey = null;
    entity.verifiedAt = null;
    entity.accessExpiresAt = entity.accessExpiresAt ?? this.createDefaultAccessExpiresAt();
    await this.repository.save(entity);
    return hadValues;
  }

  async has(chatId: string): Promise<boolean> {
    await this.ensureSchemaCompatibility();
    const entity = await this.repository.findOne({ where: { chatId } });
    return Boolean(this.toCredentials(entity));
  }

  async entries(chatId?: string): Promise<Array<{ chatId: string; credentials: UserOzonCredentials }>> {
    await this.ensureSchemaCompatibility();
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

  async listChatIds(): Promise<string[]> {
    await this.ensureSchemaCompatibility();
    const records = await this.repository.find({
      select: { chatId: true },
      order: { chatId: 'ASC' },
    });
    return records
      .map((record) => record.chatId?.toString().trim())
      .filter((value): value is string => Boolean(value));
  }

  async getAccessStatus(chatId: string, now = new Date()): Promise<UserAccessStatus> {
    await this.ensureSchemaCompatibility();
    const entity = await this.repository.findOne({ where: { chatId } });
    return this.toAccessStatus(entity, now, chatId);
  }

  async listAccessEntries(): Promise<UserAccessInfo[]> {
    await this.ensureSchemaCompatibility();
    const records = await this.repository.find({
      select: {
        chatId: true,
        clientId: true,
        accessExpiresAt: true,
      },
      order: {
        clientId: 'ASC',
        chatId: 'ASC',
      },
    });

    return records.map((record) => ({
      chatId: record.chatId,
      clientId: record.clientId?.trim() || undefined,
      accessExpiresAt: record.accessExpiresAt ?? undefined,
    }));
  }

  async extendAccessByClientId(clientId: string, days: number): Promise<number> {
    await this.ensureSchemaCompatibility();
    const normalizedClientId = clientId.trim();
    const records = await this.repository.find({ where: { clientId: normalizedClientId } });
    if (!records.length) {
      return 0;
    }

    const expiresAt = this.createExtendedAccessExpiresAt(
      days,
      records.reduce<Date | undefined>((latest, record) => {
        if (!record.accessExpiresAt) {
          return latest;
        }
        if (!latest || record.accessExpiresAt.getTime() > latest.getTime()) {
          return record.accessExpiresAt;
        }
        return latest;
      }, undefined),
    );
    for (const record of records) {
      record.accessExpiresAt = expiresAt;
    }
    await this.repository.save(records);
    return records.length;
  }

  async ensureSchemaCompatibility(): Promise<void> {
    if (this.schemaEnsurePromise) {
      await this.schemaEnsurePromise;
      return;
    }

    this.schemaEnsurePromise = this.ensureSchemaCompatibilityImpl().catch((error) => {
      this.schemaEnsurePromise = undefined;
      throw error;
    });
    await this.schemaEnsurePromise;
  }

  private async ensureSchemaCompatibilityImpl(): Promise<void> {
    if (typeof this.repository.query !== 'function') {
      return;
    }

    const columns = await this.repository.query('PRAGMA table_info("user_credentials")');
    if (!Array.isArray(columns) || !columns.length) {
      return;
    }

    const existing = new Set(
      columns
        .map((column: any) => (typeof column?.name === 'string' ? column.name : undefined))
        .filter((value: string | undefined): value is string => Boolean(value)),
    );

    if (!existing.has('accessExpiresAt')) {
      await this.repository.query('ALTER TABLE "user_credentials" ADD COLUMN "accessExpiresAt" datetime');
      const backfillIso = this.createDefaultAccessExpiresAt().toISOString();
      await this.repository.query(
        `UPDATE "user_credentials" SET "accessExpiresAt" = ? WHERE "accessExpiresAt" IS NULL`,
        [backfillIso],
      );
    }
  }

  private toCredentials(entity: UserCredentialsEntity | null | undefined): UserOzonCredentials | undefined {
    if (!entity) {
      return undefined;
    }

    const clientId = entity.clientId?.trim();
    const apiKey = entity.apiKey?.trim();
    const accessExpiresAt = entity.accessExpiresAt;
    if (!clientId || !apiKey || !entity.verifiedAt || !accessExpiresAt) {
      return undefined;
    }

    return {
      clientId,
      apiKey,
      verifiedAt: entity.verifiedAt,
      accessExpiresAt,
    };
  }

  private toAccessStatus(
    entity: UserCredentialsEntity | null | undefined,
    now: Date,
    fallbackChatId?: string,
  ): UserAccessStatus {
    if (!entity) {
      return { chatId: fallbackChatId ?? '', expired: false };
    }

    const clientId = entity.clientId?.trim() || undefined;
    const accessExpiresAt = entity.accessExpiresAt ?? undefined;
    const deadline = accessExpiresAt ? endOfMoscowDay(accessExpiresAt).getTime() : undefined;
    const expired = deadline ? now.getTime() > deadline : false;

    return {
      chatId: entity.chatId,
      clientId,
      accessExpiresAt,
      expired,
    };
  }

  private createDefaultAccessExpiresAt(): Date {
    return new Date(Date.now() + this.trialPeriodDays * 24 * 60 * 60 * 1000);
  }

  private createExtendedAccessExpiresAt(days: number, currentExpiresAt?: Date): Date {
    const safeDays = Math.max(0, Math.floor(days));
    const now = Date.now();
    const baseTs = currentExpiresAt ? Math.max(now, currentExpiresAt.getTime()) : now;
    return new Date(baseTs + safeDays * 24 * 60 * 60 * 1000);
  }

  private async resolveAccessExpiresAtForClientId(clientId: string, chatId: string): Promise<Date | undefined> {
    const normalizedClientId = clientId.trim();
    if (!normalizedClientId) {
      return undefined;
    }

    const existing = await this.repository.findOne({ where: { clientId: normalizedClientId } });
    if (!existing) {
      return undefined;
    }
    if (existing.chatId === chatId && existing.accessExpiresAt) {
      return existing.accessExpiresAt;
    }
    return existing.accessExpiresAt ?? undefined;
  }
}
