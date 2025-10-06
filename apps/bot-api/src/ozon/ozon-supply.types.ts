export interface OzonSupplyItem {
  sku: number;
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
  clusterId?: number;
  warehouseId?: number;
}

export type OzonSupplyTaskMap = Map<string, OzonSupplyTask>;

export interface OzonSupplyProcessResult {
  task: OzonSupplyTask;
  event: OzonSupplyEvent;
  message?: string;
}

export type OzonSupplyEvent =
  | 'draftCreated'
  | 'draftValid'
  | 'draftExpired'
  | 'draftInvalid'
  | 'draftError'
  | 'timeslotMissing'
  | 'supplyCreated'
  | 'noCredentials'
  | 'error';

export interface OzonSupplyProcessOptions {
  credentials?: {
    clientId: string;
    apiKey: string;
  };
  delayBetweenCallsMs?: number;
  onEvent?: (result: OzonSupplyProcessResult) => void | Promise<void>;
}

export interface OzonSupplySheetTaskRow {
  task_id: string;
  city: string;
  warehouse_name: string;
  lastday: string;
  draft_id?: number;
  draft_operation_id?: string;
  order_flag?: number;
}

export interface OzonSupplySheetSkuRow {
  Артикул: string | number;
  sku: number | string;
}

export interface OzonSupplySheetItemRow {
  Артикул: string | number;
  Количество: number | string;
}
