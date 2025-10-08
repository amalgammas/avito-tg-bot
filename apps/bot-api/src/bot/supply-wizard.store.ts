import { Injectable } from '@nestjs/common';

import type { OzonSupplyTask } from '../ozon/ozon-supply.types';

export interface SupplyWizardClusterOption {
  id: number;
  name: string;
}

export interface SupplyWizardWarehouseOption {
  id: number;
  name: string;
  clusterId: number;
}

export interface SupplyWizardDropOffOption {
  id: number;
  name: string;
}

export type SupplyWizardStage =
  | 'idle'
  | 'awaitSpreadsheet'
  | 'clusterSelect'
  | 'warehouseSelect'
  | 'dropOffSelect'
  | 'awaitReadyDays'
  | 'processing';

export interface SupplyWizardState {
  stage: SupplyWizardStage;
  clusters: SupplyWizardClusterOption[];
  warehouses: SupplyWizardWarehouseOption[];
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
      warehouses: SupplyWizardWarehouseOption[];
      dropOffs: SupplyWizardDropOffOption[];
    },
  ): SupplyWizardState {
    const state: SupplyWizardState = {
      stage: 'awaitSpreadsheet',
      clusters: payload.clusters,
      warehouses: payload.warehouses,
      dropOffs: payload.dropOffs,
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
    return { ...state, tasks: state.tasks ? [...state.tasks] : undefined };
  }

  update(
    chatId: string,
    updater: (state: SupplyWizardState | undefined) => SupplyWizardState | undefined,
  ): SupplyWizardState | undefined {
    const current = this.storage.get(chatId);
    const next = updater(current ? { ...current, tasks: current.tasks ? [...current.tasks] : undefined } : undefined);
    if (!next) {
      this.storage.delete(chatId);
      return undefined;
    }
    const normalized: SupplyWizardState = {
      ...next,
      tasks: next.tasks ? [...next.tasks] : undefined,
      createdAt: next.createdAt ?? current?.createdAt ?? Date.now(),
    };
    this.storage.set(chatId, normalized);
    return normalized;
  }

  clear(chatId: string): void {
    this.storage.delete(chatId);
  }
}
