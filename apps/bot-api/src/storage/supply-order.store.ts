import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { OzonSupplyTask } from '@bot/ozon/ozon-supply.types';
import { SupplyWizardOrderSummary, SupplyWizardSupplyItem } from '../bot/supply-wizard.store';
import { SupplyOrderEntity, SupplyOrderItem, SupplyOrderStatus } from './entities/supply-order.entity';

export interface SupplyOrderTaskPayload {
  task: OzonSupplyTask;
  clusterId: number;
  clusterName?: string;
  warehouseId: number;
  warehouseName?: string;
  dropOffId: number;
  dropOffName?: string;
  readyInDays: number;
  timeslotLabel?: string;
  warehouseAutoSelect?: boolean;
  timeslotAutoSelect?: boolean;
}

export interface SupplyOrderCompletionPayload {
  taskId: string;
  operationId: string;
  arrival?: string;
  warehouse?: string;
  dropOffName?: string;
  items: SupplyWizardSupplyItem[];
  task?: OzonSupplyTask;
}

export interface SupplyOrderQuery {
  status?: SupplyOrderStatus;
}

@Injectable()
export class SupplyOrderStore {
  constructor(
    @InjectRepository(SupplyOrderEntity)
    private readonly repository: Repository<SupplyOrderEntity>,
  ) {}

  async list(chatId: string): Promise<SupplyWizardOrderSummary[]> {
    const records = await this.repository.find({
      where: { chatId },
      order: { createdAt: 'ASC' },
    });

    return records
      .filter((record) => !record.status || record.status === 'supply')
      .map((record) => this.mapEntityToSummary(record));
  }

  async listTasks(query: SupplyOrderQuery = {}): Promise<SupplyOrderEntity[]> {
    const where: Partial<SupplyOrderEntity> = {};
    if (query.status) {
      where.status = query.status;
    }
    return this.repository.find({ where, order: { createdAt: 'ASC' } });
  }

  async saveTask(chatId: string, payload: SupplyOrderTaskPayload): Promise<SupplyOrderEntity> {
    const taskId = payload.task.taskId;
    if (!taskId) {
      throw new Error('taskId is required to persist supply task');
    }

    const existing = await this.repository.findOne({ where: { chatId, taskId } });
    const now = Date.now();

    const entity = existing ?? this.repository.create({
      id: taskId,
      chatId,
      createdAt: now,
    });

    entity.status = 'task';
    entity.taskId = taskId;
    entity.clusterId = payload.clusterId;
    entity.clusterName = payload.clusterName;
    entity.warehouseId = payload.warehouseId;
    entity.warehouseName = payload.warehouseName;
    entity.dropOffId = payload.dropOffId;
    entity.dropOffName = payload.dropOffName;
    entity.readyInDays = payload.readyInDays;
    entity.arrival = payload.timeslotLabel ?? entity.arrival;
    entity.warehouse = payload.warehouseName ?? payload.dropOffName ?? entity.warehouse;
    entity.taskPayload = this.cloneTask(payload.task);
    entity.items = this.cloneItems(payload.task.items);
    entity.timeslotFrom = payload.task.selectedTimeslot?.from_in_timezone;
    entity.timeslotTo = payload.task.selectedTimeslot?.to_in_timezone;
    entity.updatedAt = now;
    entity.completedAt = undefined;
    entity.warehouseAutoSelect = payload.warehouseAutoSelect ?? false;
    entity.timeslotAutoSelect = payload.timeslotAutoSelect ?? true;
    entity.arrival = payload.timeslotAutoSelect
      ? payload.timeslotLabel ?? entity.arrival
      : entity.arrival;

    await this.repository.save(entity);
    return entity;
  }

  async completeTask(chatId: string, payload: SupplyOrderCompletionPayload): Promise<SupplyOrderEntity> {
    const now = Date.now();
    let entity = await this.repository.findOne({ where: { chatId, taskId: payload.taskId } });

    if (!entity) {
      entity = this.repository.create({
        id: payload.operationId ?? payload.taskId,
        chatId,
        createdAt: now,
      });
    }

    entity.status = 'supply';
    entity.taskId = payload.taskId;
    entity.operationId = payload.operationId;
    entity.arrival = payload.arrival ?? entity.arrival;
    entity.warehouse = payload.warehouse ?? entity.warehouse;
    entity.dropOffName = payload.dropOffName ?? entity.dropOffName;
    entity.items = this.cloneSummaryItems(payload.items);
    entity.updatedAt = now;
    entity.completedAt = now;

    if (payload.task) {
      entity.taskPayload = this.cloneTask(payload.task);
      entity.clusterId = payload.task.clusterId ? Number(payload.task.clusterId) : entity.clusterId;
      entity.warehouseId = payload.task.warehouseId ?? entity.warehouseId;
      entity.warehouseName = payload.task.warehouseName ?? entity.warehouseName;
      entity.timeslotFrom = payload.task.selectedTimeslot?.from_in_timezone ?? entity.timeslotFrom;
      entity.timeslotTo = payload.task.selectedTimeslot?.to_in_timezone ?? entity.timeslotTo;
    }

    await this.repository.save(entity);
    return entity;
  }

  async deleteById(chatId: string, id: string): Promise<void> {
    await this.repository.delete({ chatId, id });
  }

  async deleteByTaskId(chatId: string, taskId: string): Promise<void> {
    await this.repository.delete({ chatId, taskId });
  }

  private mapEntityToSummary(record: SupplyOrderEntity): SupplyWizardOrderSummary {
    const items: SupplyWizardSupplyItem[] = (record.items ?? []).map((item) => ({
      article: item.article,
      quantity: item.quantity,
      sku: item.sku,
    }));

    return {
      id: record.operationId ?? record.id,
      taskId: record.taskId ?? record.id,
      operationId: record.operationId,
      status: record.status ?? 'supply',
      arrival: record.arrival ?? undefined,
      warehouse: record.warehouse ?? record.warehouseName ?? undefined,
      timeslotLabel: record.arrival ?? undefined,
      dropOffName: record.dropOffName ?? undefined,
      clusterName: record.clusterName ?? undefined,
      items,
      createdAt: record.completedAt ?? record.createdAt,
    };
  }

  private cloneItems(items: SupplyOrderItem[] | OzonSupplyTask['items']): SupplyOrderItem[] {
    return (items ?? []).map((item) => ({
      article: item.article,
      quantity: item.quantity,
      sku: item.sku,
    }));
  }

  private cloneSummaryItems(items: SupplyWizardSupplyItem[]): SupplyOrderItem[] {
    return items.map((item) => ({
      article: item.article,
      quantity: item.quantity,
      sku: item.sku,
    }));
  }

  private cloneTask(task: OzonSupplyTask): OzonSupplyTask {
    return {
      ...task,
      items: task.items.map((item) => ({ ...item })),
      selectedTimeslot: task.selectedTimeslot ? { ...task.selectedTimeslot } : undefined,
    };
  }
}
