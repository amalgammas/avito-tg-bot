import { Injectable } from '@nestjs/common';

import { OzonSupplyTask } from '../ozon/ozon-supply.types';

export interface ClusterOption {
  id: number;
  name: string;
  taskCount: number;
}

export interface FlowState {
  spreadsheet: string;
  tasks: OzonSupplyTask[];
  clusterOptions: ClusterOption[];
  selectedClusterIds: Set<number>;
  selectionMessageId?: number;
  createdAt: number;
}

@Injectable()
export class BotSessionStore {
  private readonly flows = new Map<string, FlowState>();

  setFlowState(chatId: string, state: Omit<FlowState, 'createdAt'> & { createdAt?: number }): FlowState {
    const payload: FlowState = {
      ...state,
      createdAt: state.createdAt ?? Date.now(),
      selectedClusterIds: new Set(state.selectedClusterIds ?? []),
    };
    this.flows.set(chatId, payload);
    return payload;
  }

  getFlowState(chatId: string): FlowState | undefined {
    const state = this.flows.get(chatId);
    if (!state) {
      return undefined;
    }
    return {
      ...state,
      selectedClusterIds: new Set(state.selectedClusterIds),
    };
  }

  updateFlowState(
    chatId: string,
    updater: (state: FlowState | undefined) => FlowState | undefined,
  ): FlowState | undefined {
    const current = this.flows.get(chatId);
    const next = updater(current ? { ...current, selectedClusterIds: new Set(current.selectedClusterIds) } : undefined);
    if (!next) {
      this.flows.delete(chatId);
      return undefined;
    }
    const normalized: FlowState = {
      ...next,
      selectedClusterIds: new Set(next.selectedClusterIds),
      createdAt: next.createdAt ?? current?.createdAt ?? Date.now(),
    };
    this.flows.set(chatId, normalized);
    return normalized;
  }

  clearFlowState(chatId: string): void {
    this.flows.delete(chatId);
  }
}
