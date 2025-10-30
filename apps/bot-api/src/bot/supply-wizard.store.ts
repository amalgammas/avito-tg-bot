import { Injectable } from '@nestjs/common';

import type { OzonDraftTimeslot } from '../config/ozon-api.service';
import type { OzonSupplyTask } from '../ozon/ozon-supply.types';
import type { SupplyOrderStatus } from '../storage/entities/supply-order.entity';

export interface SupplyWizardWarehouseOption {
  warehouse_id: number;
  name: string;
  type?: string;
}

export interface SupplyWizardWarehousesOption {
  warehouses: SupplyWizardWarehouseOption[];
}

export interface SupplyWizardClusterOption {
  id: number;
  name: string;
  logistic_clusters: SupplyWizardWarehousesOption;
}

export interface SupplyWizardDropOffOption {
  warehouse_id: number;
  name: string;
  address?: string;
  type?: string;
}

export interface SupplyWizardDraftWarehouseOption {
  warehouseId: number;
  name: string;
  clusterId?: number;
  clusterName?: string;
  address?: string;
  totalRank?: number;
  totalScore?: number;
  travelTimeDays?: number | null;
  isAvailable?: boolean;
  statusState?: string;
  statusReason?: string;
  bundleId?: string;
  restrictedBundleId?: string;
}

export interface SupplyWizardTimeslotOption {
  id: string;
  from: string;
  to: string;
  label: string;
  data: OzonDraftTimeslot;
}

export interface SupplyWizardSupplyItem {
  article: string;
  quantity: number;
  sku?: number;
}

export interface SupplyWizardOrderSummary {
  id: string;
  orderId?: number;
  taskId?: string;
  operationId?: string;
  status?: SupplyOrderStatus;
  arrival?: string;
  warehouse?: string;
  timeslotLabel?: string;
  dropOffName?: string;
  clusterName?: string;
  items: SupplyWizardSupplyItem[];
  createdAt: number;
}

export type SupplyWizardDraftStatus = 'idle' | 'creating' | 'success' | 'failed';

export type SupplyWizardStage =
  | 'idle'
  | 'authWelcome'
  | 'authApiKey'
  | 'authClientId'
  | 'landing'
  | 'support'
  | 'awaitSpreadsheet'
  | 'awaitDropOffQuery'
  | 'clusterPrompt'
  | 'clusterSelect'
  | 'warehouseSelect'
  | 'draftWarehouseSelect'
  | 'timeslotSelect'
  | 'dropOffSelect'
  | 'ordersList'
  | 'orderDetails'
  | 'tasksList'
  | 'taskDetails'
  | 'authResetConfirm'
  | 'awaitReadyDays'
  | 'processing';

export interface SupplyWizardState {
  stage: SupplyWizardStage;
  clusters: SupplyWizardClusterOption[];
  warehouses: Record<number, SupplyWizardWarehouseOption[]>;
  dropOffs: SupplyWizardDropOffOption[];
  draftWarehouses: SupplyWizardDraftWarehouseOption[];
  draftTimeslots: SupplyWizardTimeslotOption[];
  dropOffSearchQuery?: string;
  draftStatus: SupplyWizardDraftStatus;
  draftOperationId?: string;
  draftId?: number;
  draftCreatedAt?: number;
  draftExpiresAt?: number;
  draftError?: string;
  selectedClusterId?: number;
  selectedClusterName?: string;
  selectedWarehouseId?: number;
  selectedWarehouseName?: string;
  selectedDropOffId?: number;
  selectedDropOffName?: string;
  selectedTimeslot?: SupplyWizardTimeslotOption;
  spreadsheet?: string;
  selectedTaskId?: string;
  readyInDays?: number;
  promptMessageId?: number;
  pendingApiKey?: string;
  pendingClientId?: string;
  orders: SupplyWizardOrderSummary[];
  activeOrderId?: string;
  pendingTasks: SupplyWizardOrderSummary[];
  activeTaskId?: string;
  createdAt: number;
  autoWarehouseSelection?: boolean;
  warehouseSearchQuery?: string;
  warehousePage?: number;
  taskContexts?: Record<string, SupplyWizardTaskContext>;
  taskOrder?: string[];
}

export interface SupplyWizardTaskContext {
  taskId: string;
  stage: SupplyWizardStage;
  draftStatus: SupplyWizardDraftStatus;
  draftOperationId?: string;
  draftId?: number;
  draftCreatedAt?: number;
  draftExpiresAt?: number;
  draftError?: string;
  draftWarehouses: SupplyWizardDraftWarehouseOption[];
  draftTimeslots: SupplyWizardTimeslotOption[];
  selectedClusterId?: number;
  selectedClusterName?: string;
  selectedWarehouseId?: number;
  selectedWarehouseName?: string;
  selectedDropOffId?: number;
  selectedDropOffName?: string;
  selectedTimeslot?: SupplyWizardTimeslotOption;
  readyInDays?: number;
  autoWarehouseSelection?: boolean;
  dropOffSearchQuery?: string;
  promptMessageId?: number;
  task: OzonSupplyTask;
  summaryItems: SupplyWizardSupplyItem[];
  createdAt: number;
  updatedAt?: number;
}

@Injectable()
export class SupplyWizardStore {
  private readonly storage = new Map<string, SupplyWizardState>();

  start(
    chatId: string,
    payload: {
      clusters: SupplyWizardClusterOption[];
      warehouses: Record<number, SupplyWizardWarehouseOption[]>;
      dropOffs: SupplyWizardDropOffOption[];
    },
    options: { stage?: SupplyWizardStage } = {},
  ): SupplyWizardState {
    const state: SupplyWizardState = {
      stage: options.stage ?? 'awaitSpreadsheet',
      clusters: this.cloneClusters(payload.clusters),
      warehouses: this.cloneWarehouses(payload.warehouses),
      dropOffs: this.cloneDropOffs(payload.dropOffs),
      draftWarehouses: [],
      draftTimeslots: [],
      dropOffSearchQuery: undefined,
      draftStatus: 'idle',
      draftOperationId: undefined,
      draftId: undefined,
      draftCreatedAt: undefined,
      draftExpiresAt: undefined,
      draftError: undefined,
      selectedTimeslot: undefined,
      pendingApiKey: undefined,
      pendingClientId: undefined,
      orders: [],
      activeOrderId: undefined,
      pendingTasks: [],
      activeTaskId: undefined,
      createdAt: Date.now(),
      promptMessageId: undefined,
      autoWarehouseSelection: false,
      warehouseSearchQuery: undefined,
      warehousePage: 0,
      taskContexts: {},
      taskOrder: [],
    };
    this.storage.set(chatId, this.cloneState(state));
    return this.get(chatId) ?? state;
  }

  get(chatId: string): SupplyWizardState | undefined {
    const state = this.storage.get(chatId);
    if (!state) {
      return undefined;
    }
    return this.cloneState(state);
  }

  update(
    chatId: string,
    updater: (state: SupplyWizardState | undefined) => SupplyWizardState | undefined,
  ): SupplyWizardState | undefined {
    const current = this.storage.get(chatId);
    const next = updater(current ? this.cloneState(current) : undefined);
    if (!next) {
      this.storage.delete(chatId);
      return undefined;
    }
    const normalized = this.cloneState({
      ...next,
      createdAt: next.createdAt ?? current?.createdAt ?? Date.now(),
      draftStatus: next.draftStatus ?? 'idle',
      warehousePage:
        typeof next.warehousePage === 'number' ? next.warehousePage : current?.warehousePage ?? 0,
      taskContexts: this.cloneTaskContexts(next.taskContexts ?? current?.taskContexts ?? {}),
      taskOrder: [...(next.taskOrder ?? current?.taskOrder ?? [])],
    });
    this.storage.set(chatId, normalized);
    return this.cloneState(normalized);
  }

  getTaskContext(chatId: string, taskId: string): SupplyWizardTaskContext | undefined {
    const state = this.storage.get(chatId);
    if (!state?.taskContexts) return undefined;
    const context = state.taskContexts[taskId];
    return context ? this.cloneTaskContext(context) : undefined;
  }

  listTaskContexts(chatId: string): SupplyWizardTaskContext[] {
    const state = this.storage.get(chatId);
    if (!state?.taskContexts) return [];
    const order = state.taskOrder ?? Object.keys(state.taskContexts);
    return order
      .map((taskId) => state.taskContexts?.[taskId])
      .filter((value): value is SupplyWizardTaskContext => Boolean(value))
      .map((context) => this.cloneTaskContext(context));
  }

  upsertTaskContext(
    chatId: string,
    taskId: string,
    updater: (context: SupplyWizardTaskContext | undefined) => SupplyWizardTaskContext | undefined,
  ): SupplyWizardTaskContext | undefined {
    const current = this.storage.get(chatId);
    if (!current) {
      throw new Error(`SupplyWizardStore: chat ${chatId} не инициализирован`);
    }

    const existing = current.taskContexts?.[taskId];
    const next = updater(existing ? this.cloneTaskContext(existing) : undefined);

    if (!next) {
      if (current.taskContexts) {
        delete current.taskContexts[taskId];
      }
      current.taskOrder = (current.taskOrder ?? []).filter((value) => value !== taskId);
      this.storage.set(chatId, this.cloneState(current));
      return undefined;
    }

    const normalized = this.cloneTaskContext({
      ...next,
      taskId,
      draftStatus: next.draftStatus ?? 'idle',
      createdAt: next.createdAt ?? existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });

    const contexts = { ...(current.taskContexts ?? {}) };
    contexts[taskId] = normalized;

    const order = current.taskOrder ?? [];
    const filtered = order.filter((value) => value !== taskId);
    filtered.push(taskId);

    const nextState: SupplyWizardState = {
      ...current,
      taskContexts: contexts,
      taskOrder: filtered,
    };

    this.storage.set(chatId, this.cloneState(nextState));
    return this.cloneTaskContext(normalized);
  }

  removeTaskContext(chatId: string, taskId: string): void {
    const current = this.storage.get(chatId);
    if (!current?.taskContexts?.[taskId]) {
      return;
    }

    delete current.taskContexts[taskId];
    current.taskOrder = (current.taskOrder ?? []).filter((value) => value !== taskId);

    if (current.activeTaskId === taskId) {
      current.activeTaskId = current.taskOrder?.[current.taskOrder.length - 1];
    }

    this.storage.set(chatId, this.cloneState(current));
  }

  clear(chatId: string): void {
    this.storage.delete(chatId);
  }

  hydrate(chatId: string, state: SupplyWizardState): void {
    this.storage.set(chatId, this.cloneState(state));
  }

  private cloneWarehouses(
    source: Record<number, SupplyWizardWarehouseOption[]> = {},
  ): Record<number, SupplyWizardWarehouseOption[]> {
    const entries = Object.entries(source ?? {});
    return entries.reduce<Record<number, SupplyWizardWarehouseOption[]>>((acc, [key, value]) => {
      const numericKey = Number(key);
      if (!Number.isFinite(numericKey)) {
        return acc;
      }
      acc[numericKey] = value ? value.map((item) => ({ ...item })) : [];
      return acc;
    }, {});
  }

  private cloneDropOffs(source: SupplyWizardDropOffOption[] = []): SupplyWizardDropOffOption[] {
    return source.map((item) => ({ ...item }));
  }

  private cloneDraftWarehouses(
    source: SupplyWizardDraftWarehouseOption[] = [],
  ): SupplyWizardDraftWarehouseOption[] {
    return source.map((item) => ({ ...item }));
  }

  private cloneDraftTimeslots(
    source: SupplyWizardTimeslotOption[] = [],
  ): SupplyWizardTimeslotOption[] {
    return source.map((item) => ({
      ...item,
      data: item.data ? { ...item.data } : item.data,
    }));
  }

  private cloneClusters(source: SupplyWizardClusterOption[] = []): SupplyWizardClusterOption[] {
    return source.map((cluster) => ({
      id: cluster.id,
      name: cluster.name,
      logistic_clusters: {
        warehouses: (cluster.logistic_clusters?.warehouses ?? []).map((item) => ({ ...item })),
      },
    }));
  }

  private cloneOrders(orders: SupplyWizardOrderSummary[] = []): SupplyWizardOrderSummary[] {
    return orders.map((order) => ({
      ...order,
      items: order.items.map((item) => ({ ...item })),
    }));
  }

  private clonePendingTasks(tasks: SupplyWizardOrderSummary[] = []): SupplyWizardOrderSummary[] {
    return tasks.map((task) => ({
      ...task,
      items: task.items.map((item) => ({ ...item })),
    }));
  }

  private cloneState(state: SupplyWizardState): SupplyWizardState {
    return {
      ...state,
      clusters: this.cloneClusters(state.clusters),
      warehouses: this.cloneWarehouses(state.warehouses),
      dropOffs: this.cloneDropOffs(state.dropOffs),
      draftWarehouses: this.cloneDraftWarehouses(state.draftWarehouses),
      draftTimeslots: this.cloneDraftTimeslots(state.draftTimeslots),
      orders: this.cloneOrders(state.orders),
      pendingTasks: this.clonePendingTasks(state.pendingTasks),
      selectedTimeslot: state.selectedTimeslot
        ? {
            ...state.selectedTimeslot,
            data: state.selectedTimeslot.data ? { ...state.selectedTimeslot.data } : state.selectedTimeslot.data,
          }
        : undefined,
      taskContexts: this.cloneTaskContexts(state.taskContexts ?? {}),
      taskOrder: [...(state.taskOrder ?? [])],
    };
  }

  private cloneTaskContexts(source: Record<string, SupplyWizardTaskContext>): Record<string, SupplyWizardTaskContext> {
    const result: Record<string, SupplyWizardTaskContext> = {};
    for (const [taskId, context] of Object.entries(source ?? {})) {
      result[taskId] = this.cloneTaskContext(context);
    }
    return result;
  }

  private cloneTaskContext(source: SupplyWizardTaskContext): SupplyWizardTaskContext {
    return {
      ...source,
      draftWarehouses: this.cloneDraftWarehouses(source.draftWarehouses),
      draftTimeslots: this.cloneDraftTimeslots(source.draftTimeslots),
      selectedTimeslot: source.selectedTimeslot
        ? {
            ...source.selectedTimeslot,
            data: source.selectedTimeslot.data
              ? { ...source.selectedTimeslot.data }
              : source.selectedTimeslot.data,
          }
        : undefined,
      task: this.cloneSingleTask(source.task),
      summaryItems: source.summaryItems.map((item) => ({ ...item })),
    };
  }

  private cloneSingleTask(task: OzonSupplyTask): OzonSupplyTask {
    return {
      ...task,
      items: task.items.map((item) => ({ ...item })),
      selectedTimeslot: task.selectedTimeslot ? { ...task.selectedTimeslot } : undefined,
    };
  }
}
