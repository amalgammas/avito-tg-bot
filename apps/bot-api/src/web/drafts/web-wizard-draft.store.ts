import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { WizardSessionEntity } from '../../storage/entities/wizard-session.entity';
import type { WebWizardDraftPayload } from './web-wizard-draft.types';

@Injectable()
export class WebWizardDraftStore {
  constructor(
    @InjectRepository(WizardSessionEntity)
    private readonly repository: Repository<WizardSessionEntity>,
  ) {}

  async create(actorId: string, payload: Omit<WebWizardDraftPayload, 'id' | 'createdAt' | 'updatedAt'>) {
    const now = Date.now();
    const id = randomUUID();
    const entity = this.repository.create({
      id: this.buildEntityId(actorId, id),
      chatId: actorId,
      taskId: id,
      stage: payload.stage,
      payload: {
        id,
        ...payload,
        createdAt: now,
        updatedAt: now,
      } satisfies WebWizardDraftPayload,
      createdAt: now,
      updatedAt: now,
    });

    await this.repository.save(entity);
    return this.clone(entity.payload as WebWizardDraftPayload);
  }

  async get(actorId: string, draftId: string): Promise<WebWizardDraftPayload> {
    const entity = await this.repository.findOne({
      where: {
        id: this.buildEntityId(actorId, draftId),
        chatId: actorId,
        taskId: draftId,
      },
    });

    if (!entity) {
      throw new NotFoundException('Draft не найден.');
    }

    return this.clone(entity.payload as WebWizardDraftPayload);
  }

  async update(
    actorId: string,
    draftId: string,
    updater: (current: WebWizardDraftPayload) => WebWizardDraftPayload,
  ): Promise<WebWizardDraftPayload> {
    const entity = await this.repository.findOne({
      where: {
        id: this.buildEntityId(actorId, draftId),
        chatId: actorId,
        taskId: draftId,
      },
    });

    if (!entity) {
      throw new NotFoundException('Draft не найден.');
    }

    const current = this.clone(entity.payload as WebWizardDraftPayload);
    const next = this.clone({
      ...updater(current),
      id: draftId,
      updatedAt: Date.now(),
      createdAt: current.createdAt,
    });

    entity.stage = next.stage;
    entity.payload = next;
    entity.updatedAt = next.updatedAt;
    await this.repository.save(entity);
    return next;
  }

  private buildEntityId(actorId: string, draftId: string): string {
    return `web-draft::${actorId}::${draftId}`;
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
