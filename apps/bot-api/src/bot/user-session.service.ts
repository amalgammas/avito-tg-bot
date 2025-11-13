import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import type { SupplyWizardState, SupplyWizardTaskContext, SupplyWizardTimeslotOption, SupplyWizardSupplyItem } from './supply-wizard.store';
import type { OzonSupplyTask } from '../ozon/ozon-supply.types';
import { WizardSessionEntity } from '../storage/entities/wizard-session.entity';

type StoredTaskContext = SupplyWizardTaskContext;

@Injectable()
export class UserSessionService {

  constructor(
    @InjectRepository(WizardSessionEntity)
    private readonly repository: Repository<WizardSessionEntity>,
  ) {}

  async loadChatState(chatId: string): Promise<SupplyWizardState | undefined> {
    const entity = await this.repository.findOne({
      where: { chatId, taskId: IsNull() },
    });
    if (!entity) {
      return undefined;
    }
    return this.cloneFromPayload<SupplyWizardState>(entity.payload);
  }

  async saveChatState(chatId: string, state: SupplyWizardState): Promise<void> {
    const snapshot = this.cloneForStorage(state);
    const now = Date.now();
    const mainId = this.buildId(chatId, undefined);

    const existing = await this.repository.findOne({ where: { id: mainId } });
    const entity: QueryDeepPartialEntity<WizardSessionEntity> = {
      id: mainId,
      chatId,
      taskId: null,
      stage: state.stage,
      payload: snapshot as QueryDeepPartialEntity<unknown>,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.repository.upsert(entity, ['id']);

    await this.syncTaskSessions(chatId, state, now);
  }

  async deleteChatState(chatId: string): Promise<void> {
    await this.repository.delete({ chatId });
  }

  async deleteTaskState(chatId: string, taskId: string): Promise<void> {
    await this.repository.delete({ chatId, taskId });
  }

  async loadTaskState(chatId: string, taskId: string): Promise<StoredTaskContext | undefined> {
    const entity = await this.repository.findOne({
      where: { chatId, taskId },
    });
    if (!entity) {
      return undefined;
    }
    return this.cloneFromPayload<StoredTaskContext>(entity.payload);
  }

  private async syncTaskSessions(chatId: string, state: SupplyWizardState, timestamp: number): Promise<void> {
    const contexts = state.taskContexts ?? {};
    const hasContexts = Object.keys(contexts).length > 0;
    const legacyTasks = Array.isArray((state as any)?.tasks)
      ? ((state as any).tasks as OzonSupplyTask[])
      : [];
    const tasks = hasContexts
      ? Object.values(contexts)
      : legacyTasks.map((task) => this.makeLegacyTaskContext(state, task));
    const targetIds: string[] = [];
    const entities: QueryDeepPartialEntity<WizardSessionEntity>[] = [];

    for (const context of tasks) {
      const taskId = context?.taskId ?? context?.task?.taskId;
      if (!taskId) {
        continue;
      }
      const id = this.buildId(chatId, taskId);
      targetIds.push(id);
      const payload = this.cloneForStorage(context) as QueryDeepPartialEntity<unknown>;
      const existing = await this.repository.findOne({ where: { id } });
      entities.push({
        id,
        chatId,
        taskId,
        stage: context.stage,
        payload,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }

    if (entities.length) {
      await this.repository.upsert(entities, ['id']);
    }

    if (targetIds.length) {
      await this.repository
        .createQueryBuilder()
        .delete()
        .where('chatId = :chatId', { chatId })
        .andWhere('taskId IS NOT NULL')
        .andWhere('id NOT IN (:...ids)', { ids: targetIds })
        .execute();
    } else {
      await this.repository
        .createQueryBuilder()
        .delete()
        .where('chatId = :chatId', { chatId })
        .andWhere('taskId IS NOT NULL')
        .execute();
    }
  }

  private makeLegacyTaskContext(state: SupplyWizardState, task: OzonSupplyTask): SupplyWizardTaskContext {
    return {
      taskId: task.taskId,
      stage: state.stage,
      draftStatus: state.draftStatus,
      draftOperationId: state.draftOperationId,
      draftId: state.draftId,
      draftCreatedAt: state.draftCreatedAt,
      draftExpiresAt: state.draftExpiresAt,
      draftError: state.draftError,
      draftWarehouses: this.cloneForStorage(state.draftWarehouses ?? []),
      draftTimeslots: this.cloneForStorage(state.draftTimeslots ?? []),
      selectedClusterId: state.selectedClusterId,
      selectedClusterName: state.selectedClusterName,
      selectedWarehouseId: state.selectedWarehouseId ?? task.warehouseId,
      selectedWarehouseName: state.selectedWarehouseName ?? task.warehouseName,
      selectedDropOffId: state.selectedDropOffId,
      selectedDropOffName: state.selectedDropOffName,
      selectedTimeslot: this.cloneForStorage(state.selectedTimeslot) as SupplyWizardTimeslotOption | undefined,
      readyInDays: state.readyInDays,
      autoWarehouseSelection: state.autoWarehouseSelection,
      dropOffSearchQuery: state.dropOffSearchQuery,
      promptMessageId: state.promptMessageId,
      task: this.cloneForStorage(task),
      summaryItems: this.cloneForStorage(
        (task.items ?? []).map((item) => ({
          article: item.article,
          quantity: item.quantity,
          sku: item.sku,
        })),
      ) as SupplyWizardSupplyItem[],
      createdAt: state.createdAt,
      updatedAt: Date.now(),
    };
  }

  private buildId(chatId: string, taskId?: string): string {
    return taskId ? `${chatId}::${taskId}` : `chat::${chatId}`;
  }

  private cloneForStorage<T>(value: T): T {
    if (value === undefined || value === null) {
      return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private cloneFromPayload<T>(value: unknown): T {
    if (value === undefined || value === null) {
      return value as T;
    }
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
