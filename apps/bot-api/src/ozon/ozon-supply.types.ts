import type { OzonDraftTimeslot } from '../config/ozon-api.service';

export interface OzonSupplyItem {
  article: string;
  sku?: number;
  quantity: number;
}

export interface OzonSupplyTask {
  taskId: string;
  city: string;
  warehouseName: string;
  lastDay: string;
  draftId: number;
  draftOperationId: string;
  orderFlag: number;
  items: OzonSupplyItem[];
  readyInDays?: number;
  clusterId?: string | number;
  warehouseId?: number;
  selectedTimeslot?: OzonDraftTimeslot;
  warehouseAutoSelect?: boolean;
  warehouseSelectionPendingNotified?: boolean;
}

export type OzonSupplyTaskMap = Map<string, OzonSupplyTask>;

export interface OzonSupplyProcessResult {
  task: OzonSupplyTask;
  event: OzonSupplyEvent;
  message?: string;
  operationId?: string;
}

export type OzonSupplyEvent =
  | 'draftCreated'
  | 'draftValid'
  | 'draftExpired'
  | 'draftInvalid'
  | 'draftError'
  | 'timeslotMissing'
  | 'warehousePending'
  | 'windowExpired'
  | 'supplyCreated'
  | 'supplyStatus'
  | 'noCredentials'
  | 'error';

export interface OzonSupplyProcessOptions {
  credentials?: {
    clientId: string;
    apiKey: string;
  };
  delayBetweenCallsMs?: number;
  onEvent?: (result: OzonSupplyProcessResult) => void | Promise<void>;
  dropOffWarehouseId?: number;
  skipDropOffValidation?: boolean;
  abortSignal?: AbortSignal;
}
