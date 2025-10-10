import { Injectable } from '@nestjs/common';

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
  id: number;
  name: string;
}

export type SupplyWizardStage =
  | 'idle'
  | 'awaitSpreadsheet'
  | 'clusterPrompt'
  | 'clusterSelect'
  | 'warehouseSelect'
  | 'dropOffSelect'
  | 'awaitReadyDays'
  | 'processing';

export interface SupplyWizardState {
  stage: SupplyWizardStage;
  clusters: SupplyWizardClusterOption[];
  warehouses: Record<number, SupplyWizardWarehouseOption[]>;
  dropOffs: SupplyWizardDropOffOption[];
  selectedClusterId?: number;
  selectedClusterName?: string;
  selectedWarehouseId?: number;
  selectedWarehouseName?: string;
  selectedDropOffId?: number;
  selectedDropOffName?: string;
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
