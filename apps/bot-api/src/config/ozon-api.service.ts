import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AxiosError,
  AxiosRequestConfig,
  AxiosResponse,
  isAxiosError,
} from 'axios';

export interface OzonCredentials {
  clientId: string;
  apiKey: string;
}

export interface OzonCluster {
  id: number;
  name: string;
  logistic_clusters?: Array<{
    warehouses?: Array<{
      warehouse_id?: number;
      name?: string;
      type?: string | number;
    }>;
  }>;
}

export interface OzonDraftStatus {
  status?: string;
  code?: number;
  draft_id?: number;
  errors?: Array<{ code?: number; message?: string }>;
  clusters?: OzonDraftCluster[];
}

export interface OzonDraftCluster {
  cluster_id?: number;
  cluster_name?: string;
  warehouses?: OzonDraftWarehouseInfo[];
}

export interface OzonDraftWarehouseInfo {
  bundle_ids?: Array<{ bundle_id?: string; is_docless?: boolean }>;
  supply_warehouse?: {
    warehouse_id?: number | string;
    name?: string;
    address?: string;
  };
  status?: {
    state?: string;
    invalid_reason?: string;
    is_available?: boolean;
  };
  restricted_bundle_id?: string;
  travel_time_days?: string | number | null;
  total_score?: number | string;
  total_rank?: number | string;
}

export interface OzonDraftTimeslot {
  from_in_timezone: string;
  to_in_timezone: string;
}

export interface OzonTimeslotResponse {
  drop_off_warehouse_timeslots?: Array<{
    drop_off_warehouse_id?: number | string;
    warehouse_timezone?: string;
    current_time_in_timezone?: string;
    days?: Array<{
      timeslots?: OzonDraftTimeslot[];
    }>;
  }>;
}

export interface OzonAvailableWarehouse {
  warehouse_id: number;
  name?: string;
  is_active?: boolean;
  is_enabled?: boolean;
  region?: string;
}

export interface OzonFboWarehouseSearchItem {
  warehouse_id: number;
  warehouse_type?: string;
  coordinates?: {
    latitude?: number;
    longitude?: number;
  };
  address?: string;
  name?: string;
}

export interface OzonProductInfo {
  offer_id?: string;
  id?: number;
}

export interface OzonProductInfoListSource {
  sku?: number | string;
  source?: string;
}

export interface OzonProductInfoListItem {
  offer_id?: string;
  sku?: number;
  sources?: OzonProductInfoListSource[];
}

export interface OzonProductInfoListResponse {
  items?: OzonProductInfoListItem[];
  result?: {
    items?: OzonProductInfoListItem[];
  };
}

export interface OzonSupplyCreateStatus {
  operation_id?: string;
  state?: string;
  status?: string;
  result?: {
    order_ids?: number[];
    [key: string]: unknown;
  };
  errors?: Array<{ code?: number; message?: string }>;
  error_messages?: string[];
}

export interface OzonCancelSupplyResponse {
  operation_id?: string;
}

export interface OzonSupplyCancelStatusSupply {
  supply_id?: number;
  is_supply_cancelled?: boolean;
  error_reasons?: Array<{ code?: string; message?: string }>;
}

export interface OzonSupplyCancelStatusResult {
  is_order_cancelled?: boolean;
  supplies?: OzonSupplyCancelStatusSupply[];
}

export interface OzonSupplyCancelStatus {
  status?: string;
  result?: OzonSupplyCancelStatusResult;
  error_reasons?: Array<{ code?: string; message?: string }>;
}

@Injectable()
export class OzonApiService {
  private readonly logger = new Logger(OzonApiService.name);

  private readonly baseUrl: string;
  private readonly httpTimeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly defaultCredentials?: OzonCredentials;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl =
      this.config.get<string>('ozon.apiBaseUrl') ??
      this.config.get<string>('OZON_API_BASE_URL') ??
      'https://api-seller.ozon.ru';

    this.httpTimeoutMs = Number(this.config.get<string>('HTTP_TIMEOUT_MS') ?? '10000');
    this.retryAttempts = Number(this.config.get<string>('HTTP_RETRY_ATTEMPTS') ?? '3');
    this.retryBaseDelayMs = Number(this.config.get<string>('HTTP_RETRY_BASE_MS') ?? '200');

    const clientId = this.config.get<string>('ozon.clientId') ?? this.config.get<string>('OZON_CLIENT_ID');
    const apiKey = this.config.get<string>('ozon.apiKey') ?? this.config.get<string>('OZON_API_KEY');

    if (clientId && apiKey) {
      this.defaultCredentials = { clientId, apiKey };
    }
  }

  /**
   * Универсальный запрос к Ozon API.
   * credentials можно передать явно, иначе используются значения из конфигурации.
   */
  async request<T = unknown>(
    config: AxiosRequestConfig,
    credentials?: OzonCredentials,
  ): Promise<AxiosResponse<T>> {
    const creds = credentials ?? this.defaultCredentials;
    if (!creds) {
      throw new Error('Ozon credentials are not configured');
    }

    const url = this.resolveUrl(this.baseUrl, config.url);
    const method = (config.method ?? 'GET').toUpperCase();
    const requestId = `${method} ${url ?? '<relative>'}`;

    const finalConfig: AxiosRequestConfig = {
      timeout: this.httpTimeoutMs,
      ...config,
      url,
      headers: {
        ...(config.headers ?? {}),
        'Client-Id': creds.clientId,
        'Api-Key': creds.apiKey,
      },
    };

    let attempt = 0;
    while (true) {
      const startedAt = Date.now();
      const requestBodyLog = this.describeBody(finalConfig.data);
      try {
        this.logger.debug(
          `→ [${requestId}] attempt ${attempt + 1}/${this.retryAttempts} headers=${this.describeHeaders(
            finalConfig.headers,
          )} body=${requestBodyLog}`,
        );

        const response = await this.http.axiosRef.request<T>(finalConfig);
        const duration = Date.now() - startedAt;
        this.logger.debug(`← [${requestId}] ${response.status} ${response.statusText} in ${duration}ms`);
        return response;
      } catch (err) {
        const duration = Date.now() - startedAt;
        const errorSummary = this.describeError(err);
        this.logger.error(
          `× [${requestId}] failed in ${duration}ms: ${errorSummary} body=${requestBodyLog}${this.describeErrorPayload(err)}`,
        );

        const shouldRetry = this.shouldRetry(err) && attempt < this.retryAttempts - 1;
        if (!shouldRetry) throw err;

        attempt++;
        const delay = this.retryBaseDelayMs;
        this.logger.warn(`↻ [${requestId}] retry ${attempt + 1}/${this.retryAttempts} in ~${delay}ms`);
        await this.sleep(delay);
      }
    }
  }

  async post<T = unknown>(url: string, data?: any, cfg?: AxiosRequestConfig, credentials?: OzonCredentials) {
    const headers =
      data && typeof data === 'object' && !(data instanceof URLSearchParams)
        ? { 'Content-Type': 'application/json', ...(cfg?.headers ?? {}) }
        : cfg?.headers;
    return this.request<T>({ method: 'POST', url, data, ...(cfg ?? {}), headers }, credentials);
  }

  async get<T = unknown>(url: string, cfg?: AxiosRequestConfig, credentials?: OzonCredentials) {
    return this.request<T>({ method: 'GET', url, ...(cfg ?? {}) }, credentials);
  }

  /** Проверка ключей: запрашиваем информацию о продавце. */
  async validateCredentials(credentials: OzonCredentials): Promise<{ account: unknown }> {
    const response = await this.post('/v1/seller/info', {}, undefined, credentials);
    return { account: response.data };
  }

  async getSellerInfo(credentials?: OzonCredentials): Promise<unknown> {
    const response = await this.post('/v1/seller/info', {}, undefined, credentials);
    return response.data;
  }

  /** Получить список кластеров и складов. */
  async listClusters(
    payload: {
      clusterIds?: number[];
      clusterType?: string;
    } = {},
    credentials?: OzonCredentials,
  ): Promise<{ clusters: OzonCluster[]; warehouses: OzonAvailableWarehouse[] }> {
    const body = {
      cluster_ids: payload.clusterIds ?? [],
      cluster_type: payload.clusterType ?? 'CLUSTER_TYPE_OZON',
    };
    const response = await this.post<{ clusters?: OzonCluster[]; warehouses?: OzonAvailableWarehouse[] }>(
      '/v1/cluster/list',
      body,
      undefined,
      credentials,
    );
    return {
      clusters: response.data?.clusters ?? [],
      warehouses: response.data?.warehouses ?? [],
    };
  }

  async listAvailableWarehouses(credentials?: OzonCredentials): Promise<OzonAvailableWarehouse[]> {
    const { warehouses } = await this.listClusters({}, credentials);
    return warehouses;
  }

  async searchFboWarehouses(
    payload: { search: string; supplyTypes?: string[] },
    credentials?: OzonCredentials,
  ): Promise<OzonFboWarehouseSearchItem[]> {
    const search = payload.search?.trim();
    if (!search) {
      return [];
    }

    const body = {
      filter_by_supply_type: (payload.supplyTypes && payload.supplyTypes.length
        ? payload.supplyTypes
        : ['CREATE_TYPE_CROSSDOCK']) as string[],
      search,
    };

    const response = await this.post<{ search?: OzonFboWarehouseSearchItem[] }>(
      '/v1/warehouse/fbo/list',
      body,
      undefined,
      credentials,
    );

    const items = Array.isArray(response.data?.search) ? response.data?.search : [];
    const results: OzonFboWarehouseSearchItem[] = [];

    for (const raw of items) {
      if (!raw || typeof raw.warehouse_id !== 'number') {
        continue;
      }

      results.push({
        warehouse_id: raw.warehouse_id,
        warehouse_type: raw.warehouse_type,
        coordinates: raw.coordinates,
        address: raw.address,
        name: raw.name,
      });
    }

    return results;
  }

  async getProductsByOfferIds(
    offers: string[],
    credentials?: OzonCredentials,
  ): Promise<Map<string, number>> {
    if (!offers.length) {
      return new Map();
    }

    const uniqueOffers = Array.from(new Set(offers.map((value) => value.trim()))).filter(Boolean);
    if (!uniqueOffers.length) {
      return new Map();
    }

    const map = new Map<string, number>();

    const chunkSize = 100;
    for (let index = 0; index < uniqueOffers.length; index += chunkSize) {
      const chunk = uniqueOffers.slice(index, index + chunkSize);
      const response = await this.post<OzonProductInfoListResponse>(
        '/v3/product/info/list',
        {
          offer_id: chunk,
          product_id: [],
          sku: [],
          visibility: 'ALL',
        },
        undefined,
        credentials,
      );

      const rawItems = response.data?.items ?? response.data?.result?.items;
      const items = Array.isArray(rawItems) ? rawItems : [];
      for (const item of items) {
        const offerId = item?.offer_id?.trim();
        const sku = this.resolveSkuFromProduct(item);
        if (!offerId || !sku) {
          continue;
        }
        map.set(offerId, sku);
      }
    }

    return map;
  }

  findClusterIdByName(targetName: string, clusters: OzonCluster[]): number | undefined {
    const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
    const want = normalize(targetName);

    for (const cluster of clusters) {
      if (normalize(cluster.name) === want) {
        return cluster.id;
      }
    }
    return undefined;
  }

  findWarehouseId(
    clusterName: string,
    warehouseName: string,
    clusters: OzonCluster[],
  ): number | undefined {
    const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
    const wantCluster = normalize(clusterName);
    const wantWarehouse = normalize(warehouseName);

    for (const cluster of clusters) {
      if (normalize(cluster.name) !== wantCluster) continue;
      for (const logisticCluster of cluster.logistic_clusters ?? []) {
        for (const warehouse of logisticCluster.warehouses ?? []) {
          if (normalize(warehouse.name) === wantWarehouse) {
            return warehouse.warehouse_id;
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
    credentials?: OzonCredentials,
  ): Promise<string | undefined> {
    const response = await this.post<{ operation_id?: string }>(
      '/v1/draft/create',
      {
        cluster_ids: payload.clusterIds,
        drop_off_point_warehouse_id: payload.dropOffPointWarehouseId,
        items: payload.items,
        type: payload.type,
      },
      undefined,
      credentials,
    );

    this.logger.debug(
      `[OzonApiService] createDraft response: ${this.stringifySafe(response.data) ?? 'empty body'} *** ${payload}`,
    );

    return response.data?.operation_id;
  }

  async getDraftInfo(
    operationId: string,
    credentials?: OzonCredentials,
  ): Promise<OzonDraftStatus> {
    const response = await this.post<OzonDraftStatus>(
      '/v1/draft/create/info',
      { operation_id: operationId },
      undefined,
      credentials,
    );
    this.logger.debug(
      `[OzonApiService] draftInfo response: ${this.stringifySafe(response.data) ?? 'empty body'}`,
    );
    return response.data;
  }

  async getDraftTimeslots(
    payload: {
      draftId: number | string;
      warehouseIds: Array<number | string>;
      dateFrom: string;
      dateTo: string;
    },
    credentials?: OzonCredentials,
  ): Promise<OzonTimeslotResponse> {
    const response = await this.post<OzonTimeslotResponse>(
      '/v1/draft/timeslot/info',
      {
        draft_id: payload.draftId,
        date_from: payload.dateFrom,
        date_to: payload.dateTo,
        warehouse_ids: payload.warehouseIds.map(String),
      },
      undefined,
      credentials,
    );

    return response.data;
  }

  async createSupply(
    payload: {
      draftId: number | string;
      warehouseId: number | string;
      timeslot: OzonDraftTimeslot;
    },
    credentials?: OzonCredentials,
  ): Promise<string | undefined> {


      console.log(payload.draftId)
      console.log(payload.warehouseId)
      console.log(payload.timeslot)

    const response = await this.post<{ operation_id?: string }>(
      '/v1/draft/supply/create',
      {
        draft_id: payload.draftId,
        warehouse_id: payload.warehouseId,
        timeslot: payload.timeslot,
      },
      undefined,
      credentials,
    );

    return response.data?.operation_id;
  }

  async getSupplyCreateStatus(
    operationId: string,
    credentials?: OzonCredentials,
  ): Promise<OzonSupplyCreateStatus> {
    const response = await this.post<OzonSupplyCreateStatus>(
      '/v1/draft/supply/create/status',
      { operation_id: operationId },
      undefined,
      credentials,
    );
    return response.data;
  }

  async cancelSupplyOrder(
    orderId: number | string,
    credentials?: OzonCredentials,
  ): Promise<string | undefined> {
    const normalized =
      typeof orderId === 'string' ? Number(orderId.trim()) : Number(orderId);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new Error(`Некорректный order_id: ${orderId}`);
    }

    const response = await this.post<OzonCancelSupplyResponse>(
      '/v1/supply-order/cancel',
      { order_id: Math.trunc(normalized) },
      undefined,
      credentials,
    );
    return response.data?.operation_id;
  }

  async getSupplyCancelStatus(
    operationId: string,
    credentials?: OzonCredentials,
  ): Promise<OzonSupplyCancelStatus> {
    const response = await this.post<OzonSupplyCancelStatus>(
      '/v1/supply-order/cancel/status',
      { operation_id: operationId },
      undefined,
      credentials,
    );
    return response.data;
  }

  private resolveUrl(baseUrl: string, url?: string): string | undefined {
    if (!url) return url;
    if (/^https?:\/\//i.test(url)) return url;

    const normalizedBase = baseUrl.replace(/\/$/, '');
    const normalizedPath = url.startsWith('/') ? url : `/${url}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  private shouldRetry(err: unknown): boolean {
    if (!isAxiosError(err)) return false;
    const status = err.response?.status ?? 0;
    return status === 429 || (status >= 500 && status <= 599) || this.isTimeout(err);
  }

  private isTimeout(err: AxiosError): boolean {
    return err.code === 'ECONNABORTED';
  }

  private describeHeaders(headers: AxiosRequestConfig['headers']): string {
    if (!headers) return '{}';
    try {
      const normalized = Object.entries(headers).reduce<Record<string, string>>((acc, [key, value]) => {
        if (typeof value === 'undefined') return acc;
        if (key.toLowerCase() === 'api-key') {
          acc[key] = this.maskApiKey(String(value));
        } else if (key.toLowerCase() === 'client-id') {
          acc[key] = this.maskClientId(String(value));
        } else {
          acc[key] = Array.isArray(value) ? value.join(',') : String(value);
        }
        return acc;
      }, {});
      return JSON.stringify(normalized);
    } catch (error) {
      return '<unable to stringify headers>';
    }
  }

  private describeBody(data: AxiosRequestConfig['data']): string {
    if (data === null || typeof data === 'undefined') {
      return '<empty>';
    }

    if (typeof data === 'string') {
      return data.length > 1000 ? `${data.slice(0, 1000)}…` : data;
    }

    if (data instanceof URLSearchParams) {
      return data.toString();
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
      return `<buffer ${data.length}b>`;
    }

    const serialized = this.stringifySafe(data);
    return serialized ?? '<unserializable>';
  }

  private describeError(err: unknown): string {
    if (isAxiosError(err)) {
      const s = err.response?.status;
      return `AxiosError ${s ?? ''} ${err.message}`;
    }
    return String(err);
  }

  private describeErrorPayload(err: unknown): string {
    if (isAxiosError(err) && err.response?.data) {
      try {
        return ` payload=${JSON.stringify(err.response.data)}`;
      } catch (error) {
        return ' payload=<unserializable>';
      }
    }
    return '';
  }

  private stringifySafe(value: unknown): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }

    if (typeof value === 'string') {
      return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
    }

    try {
      const json = JSON.stringify(value, null, 2);
      return json.length > 1000 ? `${json.slice(0, 1000)}…` : json;
    } catch (error) {
      return undefined;
    }
  }

  private maskClientId(clientId: string): string {
    if (clientId.length <= 4) {
      return `${clientId[0] ?? '*'}***`;
    }
    return `${clientId.slice(0, 3)}***${clientId.slice(-2)}`;
  }

  private maskApiKey(apiKey: string): string {
    if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
    return `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`;
  }

  private resolveSkuFromProduct(item: OzonProductInfoListItem | undefined): number | undefined {
    if (!item) {
      return undefined;
    }

    if (typeof item.sku === 'number' && Number.isFinite(item.sku) && item.sku > 0) {
      return Math.round(item.sku);
    }

    for (const source of item.sources ?? []) {
      const candidate = typeof source?.sku === 'string' ? Number(source.sku) : source?.sku;
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return Math.round(candidate);
      }
    }

    return undefined;
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
