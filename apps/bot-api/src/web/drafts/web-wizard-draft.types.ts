import type { OzonSupplyTask, OzonSupplyType } from '../../ozon/ozon-supply.types';

export type WebWizardClusterType = 'CLUSTER_TYPE_OZON' | 'CLUSTER_TYPE_CIS';

export type WebWizardDraftStage =
  | 'parsed'
  | 'awaitDropOffQuery'
  | 'dropOffSelect'
  | 'clusterTypeSelect'
  | 'clusterSelect'
  | 'warehouseSelect'
  | 'readyDaysPending'
  | 'deadlinePending'
  | 'processingStarted';

export interface WebWizardDropOffOption {
  warehouseId: number;
  name: string;
  address?: string;
  type?: string;
}

export interface WebWizardClusterOption {
  id: number;
  name: string;
  macrolocalClusterId?: number;
}

export interface WebWizardWarehouseOption {
  warehouseId: number;
  name: string;
}

export interface WebWizardDraftPayload {
  id: string;
  stage: WebWizardDraftStage;
  source: string;
  task: OzonSupplyTask;
  supplyType?: OzonSupplyType;
  clusterType?: WebWizardClusterType;
  dropOffSearchQuery?: string;
  dropOffOptions: WebWizardDropOffOption[];
  clusterOptions: WebWizardClusterOption[];
  warehouseOptions: WebWizardWarehouseOption[];
  selectedDropOffId?: number;
  selectedDropOffName?: string;
  selectedClusterId?: number;
  selectedClusterName?: string;
  selectedWarehouseId?: number;
  selectedWarehouseName?: string;
  autoWarehouseSelection?: boolean;
  readyInDays?: number;
  lastDay?: string;
  selectedTimeslotLabel?: string;
  createdAt: number;
  updatedAt: number;
}
