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

export type OzonSupplyRequestPriority = 'high' | 'normal';

export enum OzonSupplyEventType {
  DraftCreated = 'draftCreated',
  DraftValid = 'draftValid',
  DraftExpired = 'draftExpired',
  DraftInvalid = 'draftInvalid',
  DraftError = 'draftError',
  TimeslotMissing = 'timeslotMissing',
  WarehousePending = 'warehousePending',
  WindowExpired = 'windowExpired',
  SupplyCreated = 'supplyCreated',
  SupplyStatus = 'supplyStatus',
  NoCredentials = 'noCredentials',
  Error = 'error',
}

export interface OzonSupplyEventPayload {
  type: OzonSupplyEventType;
}

export interface OzonSupplySupplyCreatedPayload extends OzonSupplyEventPayload {
  type: OzonSupplyEventType.SupplyCreated;
  operationId?: string;
}

export type OzonSupplyEvent = OzonSupplyEventPayload | OzonSupplySupplyCreatedPayload;

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
  priority?: OzonSupplyRequestPriority;
}
