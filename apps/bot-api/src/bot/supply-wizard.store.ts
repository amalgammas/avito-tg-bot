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
  tasks?: OzonSupplyTask[];
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
    });
    this.storage.set(chatId, normalized);
    return this.cloneState(normalized);
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

  private cloneTasks(tasks: OzonSupplyTask[] | undefined): OzonSupplyTask[] | undefined {
    if (!tasks) {
      return undefined;
    }
    return tasks.map((task) => ({
      ...task,
      items: task.items.map((item) => ({ ...item })),
      selectedTimeslot: task.selectedTimeslot ? { ...task.selectedTimeslot } : undefined,
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
      tasks: this.cloneTasks(state.tasks),
      orders: this.cloneOrders(state.orders),
      pendingTasks: this.clonePendingTasks(state.pendingTasks),
      selectedTimeslot: state.selectedTimeslot
        ? {
            ...state.selectedTimeslot,
            data: state.selectedTimeslot.data ? { ...state.selectedTimeslot.data } : state.selectedTimeslot.data,
          }
        : undefined,
    };
  }
}
