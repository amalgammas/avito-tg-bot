import { Injectable } from '@nestjs/common';

import type { OzonDraftTimeslot } from '../config/ozon-api.service';
import type { OzonSupplyTask } from '../ozon/ozon-supply.types';

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

export type SupplyWizardDraftStatus = 'idle' | 'creating' | 'success' | 'failed';

export type SupplyWizardStage =
  | 'idle'
  | 'awaitSpreadsheet'
  | 'awaitDropOffQuery'
  | 'clusterPrompt'
  | 'clusterSelect'
  | 'warehouseSelect'
  | 'draftWarehouseSelect'
  | 'timeslotSelect'
  | 'dropOffSelect'
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
  createdAt: number;
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
  ): SupplyWizardState {
    const state: SupplyWizardState = {
      stage: 'awaitSpreadsheet',
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
      createdAt: Date.now(),
      promptMessageId: undefined,
    };
    this.storage.set(chatId, state);
    return state;
  }

  get(chatId: string): SupplyWizardState | undefined {
    const state = this.storage.get(chatId);
    if (!state) {
      return undefined;
    }
    return {
      ...state,
      tasks: state.tasks ? [...state.tasks] : undefined,
      clusters: this.cloneClusters(state.clusters),
      warehouses: this.cloneWarehouses(state.warehouses),
      dropOffs: this.cloneDropOffs(state.dropOffs),
      draftWarehouses: this.cloneDraftWarehouses(state.draftWarehouses),
      draftTimeslots: this.cloneDraftTimeslots(state.draftTimeslots),
      dropOffSearchQuery: state.dropOffSearchQuery,
      draftStatus: state.draftStatus,
      draftOperationId: state.draftOperationId,
      draftId: state.draftId,
      draftCreatedAt: state.draftCreatedAt,
      draftExpiresAt: state.draftExpiresAt,
      draftError: state.draftError,
      selectedTimeslot: state.selectedTimeslot
        ? {
            ...state.selectedTimeslot,
            data: state.selectedTimeslot.data ? { ...state.selectedTimeslot.data } : state.selectedTimeslot.data,
          }
        : undefined,
    };
  }

  update(
    chatId: string,
    updater: (state: SupplyWizardState | undefined) => SupplyWizardState | undefined,
  ): SupplyWizardState | undefined {
    const current = this.storage.get(chatId);
    const next = updater(
      current
        ? {
            ...current,
            tasks: current.tasks ? [...current.tasks] : undefined,
            clusters: this.cloneClusters(current.clusters),
            warehouses: this.cloneWarehouses(current.warehouses),
            dropOffs: this.cloneDropOffs(current.dropOffs),
            draftWarehouses: this.cloneDraftWarehouses(current.draftWarehouses),
            draftTimeslots: this.cloneDraftTimeslots(current.draftTimeslots),
            dropOffSearchQuery: current.dropOffSearchQuery,
            draftStatus: current.draftStatus,
            draftOperationId: current.draftOperationId,
            draftId: current.draftId,
            draftCreatedAt: current.draftCreatedAt,
            draftExpiresAt: current.draftExpiresAt,
            draftError: current.draftError,
            selectedTimeslot: current.selectedTimeslot
              ? {
                  ...current.selectedTimeslot,
                  data: current.selectedTimeslot.data
                    ? { ...current.selectedTimeslot.data }
                    : current.selectedTimeslot.data,
                }
              : undefined,
          }
        : undefined,
    );
    if (!next) {
      this.storage.delete(chatId);
      return undefined;
    }
    const normalized: SupplyWizardState = {
      ...next,
      tasks: next.tasks ? [...next.tasks] : undefined,
      clusters: this.cloneClusters(next.clusters),
      warehouses: this.cloneWarehouses(next.warehouses),
      dropOffs: this.cloneDropOffs(next.dropOffs),
      draftWarehouses: this.cloneDraftWarehouses(next.draftWarehouses),
      draftTimeslots: this.cloneDraftTimeslots(next.draftTimeslots),
      dropOffSearchQuery: next.dropOffSearchQuery,
      draftStatus: next.draftStatus ?? 'idle',
      draftOperationId: next.draftOperationId,
      draftId: next.draftId,
      draftCreatedAt: next.draftCreatedAt,
      draftExpiresAt: next.draftExpiresAt,
      draftError: next.draftError,
      selectedTimeslot: next.selectedTimeslot
        ? {
            ...next.selectedTimeslot,
            data: next.selectedTimeslot.data ? { ...next.selectedTimeslot.data } : next.selectedTimeslot.data,
          }
        : undefined,
      createdAt: next.createdAt ?? current?.createdAt ?? Date.now(),
    };
    this.storage.set(chatId, normalized);
    return normalized;
  }

  clear(chatId: string): void {
    this.storage.delete(chatId);
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
}
