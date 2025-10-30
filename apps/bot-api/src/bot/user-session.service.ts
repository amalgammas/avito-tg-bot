import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import type { SupplyWizardState } from './supply-wizard.store';
import type { OzonSupplyTask } from '../ozon/ozon-supply.types';
import { WizardSessionEntity } from '../storage/entities/wizard-session.entity';

interface StoredTaskContext {
  task: OzonSupplyTask;
  stage: string;
  readyInDays?: number;
  selectedClusterId?: number;
  selectedClusterName?: string;
  selectedDropOffId?: number;
  selectedDropOffName?: string;
  selectedWarehouseId?: number;
  selectedWarehouseName?: string;
  selectedTimeslot?: SupplyWizardState['selectedTimeslot'];
  autoWarehouseSelection?: boolean;
}

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
    await this.repository.save({
      id: mainId,
      chatId,
      taskId: undefined,
      stage: state.stage,
      payload: snapshot,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

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
    const tasks = state.tasks ?? [];
    const targetIds: string[] = [];
    const entities: WizardSessionEntity[] = [];

    for (const task of tasks) {
      if (!task?.taskId) {
        continue;
      }
      const id = this.buildId(chatId, task.taskId);
      targetIds.push(id);
      const payload = this.makeTaskSnapshot(state, task);
      const existing = await this.repository.findOne({ where: { id } });
      entities.push({
        id,
        chatId,
        taskId: task.taskId,
        stage: state.stage,
        payload,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }

    if (entities.length) {
      await this.repository.save(entities);
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

  private makeTaskSnapshot(state: SupplyWizardState, task: OzonSupplyTask): StoredTaskContext {
    return {
      task: this.cloneForStorage(task),
      stage: state.stage,
      readyInDays: state.readyInDays,
      selectedClusterId: state.selectedClusterId,
      selectedClusterName: state.selectedClusterName,
      selectedDropOffId: state.selectedDropOffId,
      selectedDropOffName: state.selectedDropOffName,
      selectedWarehouseId: state.selectedWarehouseId ?? task.warehouseId,
      selectedWarehouseName: state.selectedWarehouseName ?? task.warehouseName,
      selectedTimeslot: this.cloneForStorage(state.selectedTimeslot),
      autoWarehouseSelection: state.autoWarehouseSelection,
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
