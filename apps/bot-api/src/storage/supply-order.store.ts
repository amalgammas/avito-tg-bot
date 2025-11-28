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
  warehouseId?: number;
  warehouseName?: string;
  dropOffId?: number;
  dropOffName?: string;
  readyInDays: number;
  timeslotLabel?: string;
  warehouseAutoSelect?: boolean;
  timeslotAutoSelect?: boolean;
  orderId?: number;
}

export interface SupplyOrderCompletionPayload {
  taskId: string;
  operationId: string;
  orderId?: number;
  arrival?: string;
  warehouse?: string;
  warehouseName?: string;
  warehouseId?: number;
  dropOffName?: string;
  dropOffId?: number;
  timeslotFrom?: string;
  timeslotTo?: string;
  items: SupplyWizardSupplyItem[];
  task?: OzonSupplyTask;
}

export interface SupplyOrderQuery {
  status?: SupplyOrderStatus;
  chatId?: string;
}

@Injectable()
export class SupplyOrderStore {
  constructor(
    @InjectRepository(SupplyOrderEntity)
    private readonly repository: Repository<SupplyOrderEntity>,
  ) {}

    private readonly searchWindowFallbackDays = 28;

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
    if (query.chatId) {
      where.chatId = query.chatId;
    }
    return this.repository.find({ where, order: { createdAt: 'ASC' } });
  }

  async findTask(chatId: string, taskId: string): Promise<SupplyOrderEntity | null> {
    return this.repository.findOne({ where: { chatId, taskId } });
  }

  async saveTask(chatId: string, payload: SupplyOrderTaskPayload): Promise<SupplyOrderEntity> {
    const taskId = payload.task.taskId;
    if (!taskId) {
      throw new Error('taskId is required to persist supply task');
    }

    const existing = await this.repository.findOne({ where: { chatId, taskId } });
    const now = Date.now();

    if (existing && existing.status === 'supply') {
      return existing;
    }

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
    if (payload.warehouseName) {
      entity.warehouse = payload.warehouseName;
    } else if (!entity.warehouse && payload.dropOffName) {
      entity.warehouse = payload.dropOffName;
    }
    entity.taskPayload = this.cloneTask(payload.task);
    entity.items = this.cloneItems(payload.task.items);
    entity.timeslotFrom = payload.task.selectedTimeslot?.from_in_timezone;
    entity.timeslotTo = payload.task.selectedTimeslot?.to_in_timezone;
    entity.updatedAt = now;
    entity.completedAt = undefined;
    entity.warehouseAutoSelect = payload.warehouseAutoSelect ?? false;
    entity.timeslotAutoSelect = payload.timeslotAutoSelect ?? true;
    entity.orderId = payload.orderId ?? entity.orderId;
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
        id: payload.orderId ? String(payload.orderId) : payload.operationId ?? payload.taskId,
        chatId,
        createdAt: now,
      });
    }

    entity.status = 'supply';
    entity.taskId = payload.taskId;
    entity.operationId = payload.operationId;
    entity.orderId = payload.orderId ?? entity.orderId;
    entity.arrival = payload.arrival ?? entity.arrival;
    const warehouseDisplay = payload.warehouse ?? payload.warehouseName;
    entity.warehouse = warehouseDisplay ?? entity.warehouse;
    entity.warehouseId = payload.warehouseId ?? entity.warehouseId;
    entity.warehouseName = payload.warehouseName ?? entity.warehouseName;
    entity.dropOffName = payload.dropOffName ?? entity.dropOffName;
    entity.dropOffId = payload.dropOffId ?? entity.dropOffId;
    entity.timeslotFrom = payload.timeslotFrom ?? entity.timeslotFrom;
    entity.timeslotTo = payload.timeslotTo ?? entity.timeslotTo;
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

  async deleteByOperationId(chatId: string, operationId: string): Promise<void> {
    await this.repository.delete({ chatId, operationId });
  }

  async setOrderId(chatId: string, operationId: string | undefined, orderId: number): Promise<void> {
    if (!operationId) return;

    let entity =
      (await this.repository.findOne({ where: { chatId, operationId } })) ??
      (await this.repository.findOne({ where: { chatId, id: operationId } }));

    if (!entity) {
      return;
    }

    entity.orderId = orderId;
    entity.id = String(orderId);
    entity.operationId = entity.operationId ?? operationId;
    entity.updatedAt = Date.now();

    await this.repository.save(entity);
  }

  async listTaskSummaries(chatId: string): Promise<SupplyWizardOrderSummary[]> {
    const tasks = await this.listTasks({ chatId, status: 'task' });
    return tasks.map((task) => this.mapEntityToSummary(task));
  }

  private mapEntityToSummary(record: SupplyOrderEntity): SupplyWizardOrderSummary {
    const items: SupplyWizardSupplyItem[] = (record.items ?? []).map((item) => ({
      article: item.article,
      quantity: item.quantity,
      sku: item.sku,
    }));

    const summaryId = record.orderId ? String(record.orderId) : record.operationId ?? record.id;

    return {
      id: summaryId,
      orderId: record.orderId ?? undefined,
      taskId: record.taskId ?? record.id,
      operationId: record.operationId,
      status: record.status ?? 'supply',
      arrival: record.arrival ?? undefined,
      warehouse: record.warehouse ?? record.warehouseName ?? undefined,
      timeslotLabel: record.arrival ?? undefined,
      dropOffName: record.dropOffName ?? undefined,
      clusterName: record.clusterName ?? undefined,
      readyInDays: record.readyInDays ?? undefined,
      items,
      createdAt: record.completedAt ?? record.createdAt,
      searchDeadlineAt: this.computeSearchDeadline(record),
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

    private computeSearchDeadline(record: SupplyOrderEntity): number | undefined {
        const deadlineIso = record.taskPayload?.lastDay;
        const explicitDeadline = this.parseSupplyDeadline(deadlineIso);
        if (explicitDeadline) {
            explicitDeadline.setHours(23, 59, 59, 0);
            return explicitDeadline.getTime();
        }

        const baseTimestamp = Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
        const baseDate = new Date(baseTimestamp);
        if (Number.isNaN(baseDate.getTime())) {
            return undefined;
        }
        baseDate.setHours(23, 59, 59, 0);
        baseDate.setDate(baseDate.getDate() + this.searchWindowFallbackDays);
        return baseDate.getTime();
    }

    private parseSupplyDeadline(value?: string): Date | undefined {
        if (!value?.trim()) {
            return undefined;
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }

  private cloneTask(task: OzonSupplyTask): OzonSupplyTask {
    return {
      ...task,
      items: task.items.map((item) => ({ ...item })),
      selectedTimeslot: task.selectedTimeslot ? { ...task.selectedTimeslot } : undefined,
    };
  }
}
