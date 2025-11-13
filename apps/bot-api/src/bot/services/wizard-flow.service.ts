import { Injectable } from '@nestjs/common';

import type {
  OzonAvailableWarehouse,
  OzonDraftStatus,
  OzonDraftTimeslot,
  OzonFboWarehouseSearchItem,
  OzonTimeslotResponse,
  OzonSupplyCreateStatus,
  OzonSupplyCancelStatus,
  OzonSupplyOrder,
} from '@bot/config/ozon-api.service';
import { OzonApiService } from '@bot/config/ozon-api.service';
import type { OzonSupplyTask } from '@bot/ozon/ozon-supply.types';

@Injectable()
export class WizardFlowService {
  constructor(private readonly ozonApi: OzonApiService) {}

  async searchDropOffs(query: string, credentials: { clientId: string; apiKey: string }): Promise<OzonFboWarehouseSearchItem[]> {
    return this.ozonApi.searchFboWarehouses(
      { search: query, supplyTypes: ['CREATE_TYPE_CROSSDOCK'] },
      credentials,
    );
  }

  async listClusters(
    payload: {
      clusterIds?: number[];
      clusterType?: string;
    } = {},
    credentials?: { clientId: string; apiKey: string },
  ): Promise<{
    clusters: Awaited<ReturnType<OzonApiService['listClusters']>>['clusters'];
    warehouses: OzonAvailableWarehouse[];
  }> {
    return this.ozonApi.listClusters(payload, credentials);
  }

  async getDraftInfo(operationId: string, credentials: { clientId: string; apiKey: string }): Promise<OzonDraftStatus> {
    return this.ozonApi.getDraftInfo(operationId, credentials);
  }

  async fetchDraftTimeslots(
    draftId: number | string,
    warehouseIds: Array<number | string>,
    window: { dateFromIso: string; dateToIso: string },
    credentials: { clientId: string; apiKey: string },
  ): Promise<OzonTimeslotResponse> {
    return this.ozonApi.getDraftTimeslots(
      {
        draftId,
        warehouseIds,
        dateFrom: window.dateFromIso,
        dateTo: window.dateToIso,
      },
      credentials,
    );
  }

  pickFirstTimeslot(response: OzonTimeslotResponse): OzonDraftTimeslot | undefined {
    for (const warehouse of response.drop_off_warehouse_timeslots ?? []) {
      for (const day of warehouse.days ?? []) {
        for (const slot of day.timeslots ?? []) {
          if (slot.from_in_timezone && slot.to_in_timezone) {
            return slot;
          }
        }
      }
    }
    return undefined;
  }

  async createDraft(
    payload: {
      clusterIds: Array<string | number>;
      dropOffPointWarehouseId: number | string;
      items: Array<{ sku: number; quantity: number }>;
      type: 'CREATE_TYPE_DIRECT' | 'CREATE_TYPE_CROSSDOCK';
    },
    credentials: { clientId: string; apiKey: string },
  ): Promise<string | undefined> {
    return this.ozonApi.createDraft(payload, credentials);
  }

  async getSupplyCreateStatus(
    operationId: string,
    credentials: { clientId: string; apiKey: string },
  ): Promise<OzonSupplyCreateStatus> {
    return this.ozonApi.getSupplyCreateStatus(operationId, credentials);
  }

  async cancelSupplyOrder(
    orderId: number | string,
    credentials: { clientId: string; apiKey: string },
  ): Promise<string | undefined> {
    return this.ozonApi.cancelSupplyOrder(orderId, credentials);
  }

  async getSupplyCancelStatus(
    operationId: string,
    credentials: { clientId: string; apiKey: string },
  ): Promise<OzonSupplyCancelStatus> {
    return this.ozonApi.getSupplyCancelStatus(operationId, credentials);
  }

  async getSupplyOrders(
    orderIds: Array<number | string>,
    credentials: { clientId: string; apiKey: string },
  ): Promise<OzonSupplyOrder[]> {
    return this.ozonApi.getSupplyOrders(orderIds, credentials);
  }

  async getProductsByOfferIds(
    offers: string[],
    credentials: { clientId: string; apiKey: string },
  ): Promise<Map<string, number>> {
    return this.ozonApi.getProductsByOfferIds(offers, credentials);
  }
}
