import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosRequestConfig, AxiosResponse, GenericAbortSignal, isAxiosError } from 'axios';

export interface OzonCredentials {
  clientId: string;
  apiKey: string;
}

export class OzonAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OzonAccessDeniedError';
  }
}

export interface OzonRoleItem {
  name?: string;
  methods?: string[];
}

export interface OzonRolesResponse {
  roles?: OzonRoleItem[];
  expires_at?: string | null;
}

export interface OzonCluster {
  id: number;
  name: string;
  macrolocal_cluster_id?: number;
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
  macrolocal_cluster_id?: number;
  cluster_name?: string;
  supply_type?: string;
  warehouses?: OzonDraftWarehouseInfo[];
}

export interface OzonDraftWarehouseInfo {
  bundle_ids?: Array<{ bundle_id?: string; is_docless?: boolean }>;
  bundle_id?: string;
  supply_warehouse?: {
    warehouse_id?: number | string;
    name?: string;
    address?: string;
  };
  storage_warehouse?: {
    warehouse_id?: number | string;
    name?: string;
    address?: string;
  };
  status?: {
    state?: string;
    invalid_reason?: string;
    is_available?: boolean;
  };
  availability_status?: {
    state?: string;
    invalid_reason?: string;
  };
  restricted_bundle_id?: string;
  travel_time_days?: string | number | null;
  total_score?: number | string;
  total_rank?: number | string;
  supply_tags?: string[];
}

export interface OzonDraftTimeslot {
  from_in_timezone: string;
  to_in_timezone: string;
}

export type OzonDraftSupplyType = 'DIRECT' | 'CROSSDOCK';

export interface OzonDraftCreateItem {
  sku: number;
  quantity: number;
}

export interface OzonDraftCreatePayload {
  clusterIds: Array<string | number>;
  macrolocalClusterId?: number | string;
  dropOffPointWarehouseId?: number | string;
  items: OzonDraftCreateItem[];
  type: OzonDraftSupplyType;
}

export interface OzonDraftCreateRequest {
  cluster_ids: Array<string | number>;
  items: OzonDraftCreateItem[];
  type: OzonDraftSupplyType;
  drop_off_point_warehouse_id?: number | string;
}

export interface OzonDirectCreateRequest {
  cluster_info: {
    items: OzonDraftCreateItem[];
    macrolocal_cluster_id: number;
  };
  deletion_sku_mode: 'PARTIAL' | 'FULL';
}

export interface OzonCrossdockCreateRequest {
  cluster_info: {
    items: OzonDraftCreateItem[];
    macrolocal_cluster_id: number;
  };
  deletion_sku_mode: 'PARTIAL' | 'FULL';
  delivery_info: {
    drop_off_warehouse: {
      warehouse_id: number;
      warehouse_type: 'DELIVERY_POINT';
    };
    type: 'DROPOFF';
  };
}

export interface OzonDraftCreateResponse {
  operation_id?: string;
  operationId?: string;
  draft_id?: number | string;
  errors?: Array<{
    message?: string;
    error_message?: string;
    error_reasons?: string[];
  }>;
  result?: {
    operation_id?: string;
    operationId?: string;
  };
}

export interface OzonDraftInfoRequest {
  operation_id?: string;
  draft_id?: number;
}

export interface OzonDraftTimeslotsPayload {
  draftId: number | string;
  warehouseIds: Array<number | string>;
  dateFrom: string;
  dateTo: string;
  supplyType: OzonDraftSupplyType;
  selectedClusterWarehouses?: OzonSelectedClusterWarehouse[];
}

export interface OzonSelectedClusterWarehouse {
  macrolocal_cluster_id: number;
  storage_warehouse_id: number;
}

export interface OzonDraftTimeslotsRequest {
  draft_id: number | string;
  date_from: string;
  date_to: string;
  warehouse_ids?: string[];
  supply_type: OzonDraftSupplyType;
  selected_cluster_warehouses?: OzonSelectedClusterWarehouse[];
}

export interface OzonSupplyCreateTimeslot {
  from_in_timezone: string;
  to_in_timezone: string;
}

export interface OzonSupplyCreatePayload {
  draftId: number | string;
  selectedClusterWarehouses: OzonSelectedClusterWarehouse[];
  timeslot: OzonSupplyCreateTimeslot;
  supplyType: OzonDraftSupplyType;
}

export interface OzonSupplyCreateRequest {
  draft_id: number | string;
  selected_cluster_warehouses: OzonSelectedClusterWarehouse[];
  timeslot: OzonSupplyCreateTimeslot;
  supply_type: OzonDraftSupplyType;
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
  result?: {
    drop_off_warehouse_timeslots?:
      | {
          drop_off_warehouse_id?: number | string;
          warehouse_timezone?: string;
          current_time_in_timezone?: string;
          days?: Array<{
            date_in_timezone?: string;
            timeslots?: OzonDraftTimeslot[];
          }>;
        }
      | Array<{
          drop_off_warehouse_id?: number | string;
          warehouse_timezone?: string;
          current_time_in_timezone?: string;
          days?: Array<{
            date_in_timezone?: string;
            timeslots?: OzonDraftTimeslot[];
          }>;
        }>;
  };
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
  draft_id?: number | string;
  order_id?: number | string;
  state?: string;
  status?: string;
  error_reasons?: string[];
  result?: {
    order_id?: number | string;
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

export interface OzonSupplyOrderTimeslot {
  timeslot?: {
    from?: string;
    to?: string;
  };
  timezone_info?: {
    offset?: string;
    iana_name?: string;
  };
}

export interface OzonSupplyOrderWarehouse {
  warehouse_id?: number;
  address?: string;
  name?: string;
}

export interface OzonSupplyOrderSupply {
  state?: string;
  supply_id?: number;
  storage_warehouse?: OzonSupplyOrderWarehouse;
  bundle_id?: string;
}

export interface OzonSupplyOrder {
  order_id?: number;
  order_number?: string;
  created_date?: string;
  state?: string;
  state_updated_date?: string;
  data_filling_deadline?: string;
  drop_off_warehouse?: OzonSupplyOrderWarehouse;
  timeslot?: OzonSupplyOrderTimeslot;
  supplies?: OzonSupplyOrderSupply[];
}

@Injectable()
export class OzonApiService {
  private readonly logger = new Logger(OzonApiService.name);
  private readonly supplyOrderRoleName = 'Supply order';
  private readonly requiredSupplyMethods = [
    '/v1/draft/direct/create',
    '/v1/draft/crossdock/create',
    '/v2/draft/create/info',
    '/v2/draft/timeslot/info',
    '/v2/draft/supply/create',
    '/v2/draft/supply/create/status',
  ];

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
    abortSignal?: AbortSignal,
    options?: { retryDelayMs?: number },
  ): Promise<AxiosResponse<T>> {
    const creds = credentials ?? this.defaultCredentials;
    if (!creds) {
      throw new Error('Ozon credentials are not configured');
    }

    this.ensureNotAborted(abortSignal);

    const url = this.resolveUrl(this.baseUrl, config.url);
    const method = (config.method ?? 'GET').toUpperCase();
    const requestId = `${method} ${url ?? '<relative>'}`;
    const { signal: resolvedSignal, cleanupSignal } = this.composeAbortSignal(config.signal, abortSignal);

    const finalConfig: AxiosRequestConfig = {
      timeout: this.httpTimeoutMs,
      ...config,
      url,
      signal: resolvedSignal,
      headers: {
        ...(config.headers ?? {}),
        'Client-Id': creds.clientId,
        'Api-Key': creds.apiKey,
      },
    };

    let attempt = 0;
    try {
      while (true) {
        this.ensureNotAborted(abortSignal);
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
          if (this.isAbortError(err)) {
            throw this.createAbortError();
          }
          const duration = Date.now() - startedAt;
          const errorSummary = this.describeError(err);
          this.logger.error(
            `× [${requestId}] failed in ${duration}ms: ${errorSummary} body=${requestBodyLog}${this.describeErrorPayload(err)}`,
          );

          const shouldRetry = this.shouldRetry(err) && attempt < this.retryAttempts - 1;
          if (!shouldRetry) throw err;

          attempt++;
          const delay = options?.retryDelayMs ?? this.retryBaseDelayMs;
          this.logger.warn(`↻ [${requestId}] retry ${attempt + 1}/${this.retryAttempts} in ~${delay}ms`);
          await this.sleep(delay, abortSignal);
        }
      }
    } finally {
      cleanupSignal();
    }
  }

  async post<T = unknown>(
    url: string,
    data?: any,
    cfg?: AxiosRequestConfig,
    credentials?: OzonCredentials,
    abortSignal?: AbortSignal,
    options?: { retryDelayMs?: number },
  ) {
    const headers =
      data && typeof data === 'object' && !(data instanceof URLSearchParams)
        ? { 'Content-Type': 'application/json', ...(cfg?.headers ?? {}) }
        : cfg?.headers;
    return this.request<T>({ method: 'POST', url, data, ...(cfg ?? {}), headers }, credentials, abortSignal, options);
  }

  async get<T = unknown>(
    url: string,
    cfg?: AxiosRequestConfig,
    credentials?: OzonCredentials,
    abortSignal?: AbortSignal,
    options?: { retryDelayMs?: number },
  ) {
    return this.request<T>({ method: 'GET', url, ...(cfg ?? {}) }, credentials, abortSignal, options);
  }

  /** Проверка ключей: запрашиваем информацию о продавце. */
  async validateCredentials(credentials: OzonCredentials): Promise<{ account: unknown }> {
    const response = await this.post('/v1/seller/info', {}, undefined, credentials);
    return { account: response.data };
  }

  async getRoles(credentials: OzonCredentials): Promise<OzonRolesResponse> {
    const response = await this.post<OzonRolesResponse>('/v1/roles', {}, undefined, credentials);
    return response.data ?? {};
  }

  async validateSupplyOrderAccess(
    credentials: OzonCredentials,
  ): Promise<{ account: unknown; roles: OzonRoleItem[] }> {
    const [validated, rolesResponse] = await Promise.all([
      this.validateCredentials(credentials),
      this.getRoles(credentials),
    ]);

    const roles = Array.isArray(rolesResponse.roles) ? rolesResponse.roles : [];

    const supplyRole = roles.find((role) => role?.name?.trim() === this.supplyOrderRoleName);
    if (!supplyRole) {
      throw new OzonAccessDeniedError(
        `Недостаточно прав Ozon API: требуется роль "${this.supplyOrderRoleName}".`,
      );
    }

    const methods = new Set((supplyRole.methods ?? []).map((method) => String(method).trim()).filter(Boolean));
    const missingMethods = this.requiredSupplyMethods.filter((method) => !methods.has(method));
    if (missingMethods.length) {
      throw new OzonAccessDeniedError(
        `Недостаточно прав Ozon API: в роли "${this.supplyOrderRoleName}" отсутствуют методы: ${missingMethods.join(', ')}.`,
      );
    }

    return { account: validated.account, roles };
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
    abortSignal?: AbortSignal,
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
      abortSignal,
    );
    return {
      clusters: response.data?.clusters ?? [],
      warehouses: response.data?.warehouses ?? [],
    };
  }

  async listAvailableWarehouses(
    credentials?: OzonCredentials,
    abortSignal?: AbortSignal,
  ): Promise<OzonAvailableWarehouse[]> {
    const { warehouses } = await this.listClusters({}, credentials, abortSignal);
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
    payload: OzonDraftCreatePayload,
    credentials?: OzonCredentials,
    abortSignal?: AbortSignal,
  ): Promise<string | undefined> {
    const supplyType = this.normalizeSupplyType(payload.type);
    const macrolocalClusterId = await this.resolveMacrolocalClusterId(payload, credentials, abortSignal);
    const body =
      supplyType === 'CROSSDOCK'
        ? this.buildCrossdockCreateRequest(payload, macrolocalClusterId)
        : this.buildDirectCreateRequest(payload, macrolocalClusterId);

    const response = await this.post<OzonDraftCreateResponse>(
      this.resolveDraftCreateEndpoint(supplyType),
      body,
      undefined,
      credentials,
      abortSignal,
    );

    this.logger.debug(
      `[OzonApiService] createDraft response: ${this.stringifySafe(response.data) ?? 'empty body'} payload=${this.stringifySafe(body) ?? '<unserializable>'}`,
    );

    await this.sleep(30_000, abortSignal);

    const draftId = this.extractDraftId(response.data);
    if (draftId) {
      return `draft-${draftId}`;
    }

    const draftErrors = this.extractDraftCreateErrors(response.data);
    if (draftErrors.length) {
      throw new Error(`createDraft returned errors: ${draftErrors.join('; ')}`);
    }

    const operationId = this.extractOperationId(response.data);
    if (!operationId) {
      this.logger.warn(
        `[OzonApiService] createDraft: operation_id not found in response body=${this.stringifySafe(response.data) ?? 'empty body'}`,
      );
    }
    return operationId;
  }

  async getDraftInfo(
    operationId: string,
    credentials?: OzonCredentials,
    abortSignal?: AbortSignal,
  ): Promise<OzonDraftStatus> {
    const localDraftId = this.parseLocalDraftOperationId(operationId);
    const requestBody: OzonDraftInfoRequest = localDraftId
      ? { draft_id: localDraftId }
      : { operation_id: operationId };
    const response = await this.post<OzonDraftStatus>(
      '/v2/draft/create/info',
      requestBody,
      undefined,
      credentials,
      abortSignal,
      { retryDelayMs: 30_000 },
    );
    this.logger.debug(
      `[OzonApiService] draftInfo response: ${this.stringifySafe(response.data) ?? 'empty body'}`,
    );
    return response.data;
  }

  async getDraftTimeslots(
    payload: OzonDraftTimeslotsPayload,
    credentials?: OzonCredentials,
    abortSignal?: AbortSignal,
  ): Promise<OzonTimeslotResponse> {
    const normalizedSupplyType = this.normalizeSupplyType(payload.supplyType);
    const selectedClusterWarehouses = (payload.selectedClusterWarehouses ?? [])
      .map((entry) => {
        try {
          return {
            macrolocal_cluster_id: this.parsePositiveInt(entry.macrolocal_cluster_id, 'selectedClusterWarehouses.macrolocal_cluster_id'),
            storage_warehouse_id: this.parseNonNegativeInt(entry.storage_warehouse_id, 'selectedClusterWarehouses.storage_warehouse_id'),
          };
        } catch (error) {
          return undefined;
        }
      })
      .filter((entry): entry is OzonSelectedClusterWarehouse => Boolean(entry));

    const requestBody: OzonDraftTimeslotsRequest = {
      draft_id: payload.draftId,
      date_from: payload.dateFrom,
      date_to: payload.dateTo,
      supply_type: normalizedSupplyType,
      ...(normalizedSupplyType === 'DIRECT' ? { warehouse_ids: payload.warehouseIds.map(String) } : {}),
      ...(selectedClusterWarehouses.length
        ? { selected_cluster_warehouses: selectedClusterWarehouses }
        : {}),
    };

    const response = await this.post<OzonTimeslotResponse>(
      '/v2/draft/timeslot/info',
      requestBody,
      undefined,
      credentials,
      abortSignal,
    );

    this.logger.debug(
      `[OzonApiService] timeslot response: ${this.stringifySafe(response.data) ?? 'empty body'}`,
    );

    return this.normalizeTimeslotResponse(response.data);
  }

  async createSupply(
    payload: OzonSupplyCreatePayload,
    credentials?: OzonCredentials,
    abortSignal?: AbortSignal,
  ): Promise<string | undefined> {
    const selectedClusterWarehouses = (payload.selectedClusterWarehouses ?? [])
      .map((entry) => {
        try {
          return {
            macrolocal_cluster_id: this.parsePositiveInt(entry.macrolocal_cluster_id, 'selectedClusterWarehouses.macrolocal_cluster_id'),
            storage_warehouse_id: this.parseNonNegativeInt(entry.storage_warehouse_id, 'selectedClusterWarehouses.storage_warehouse_id'),
          };
        } catch (error) {
          return undefined;
        }
      })
      .filter((entry): entry is OzonSelectedClusterWarehouse => Boolean(entry));
    if (!selectedClusterWarehouses.length) {
      throw new Error('createSupply requires selectedClusterWarehouses with at least one item');
    }

    const requestBody: OzonSupplyCreateRequest = {
      draft_id: payload.draftId,
      selected_cluster_warehouses: selectedClusterWarehouses,
      timeslot: {
        from_in_timezone: this.toOzonLocalDateTime(payload.timeslot.from_in_timezone),
        to_in_timezone: this.toOzonLocalDateTime(payload.timeslot.to_in_timezone),
      },
      supply_type: this.normalizeSupplyType(payload.supplyType),
    };

    const response = await this.post<OzonDraftCreateResponse>(
      '/v2/draft/supply/create',
      requestBody,
      undefined,
      credentials,
      abortSignal,
    );

    const operationId = this.extractOperationId(response.data);
    if (operationId) {
      return operationId;
    }

    const draftId = this.extractDraftId(response.data);
    if (draftId) {
      return `draft-${draftId}`;
    }

    return undefined;
  }

  async getSupplyCreateStatus(
    operationId: string,
    credentials?: OzonCredentials,
    abortSignal?: AbortSignal,
  ): Promise<OzonSupplyCreateStatus> {
    const localDraftId = this.parseLocalDraftOperationId(operationId);
    const requestBody: OzonDraftInfoRequest = localDraftId
      ? { draft_id: localDraftId }
      : { operation_id: operationId };
    const response = await this.post<OzonSupplyCreateStatus>(
      '/v2/draft/supply/create/status',
      requestBody,
      undefined,
      credentials,
      abortSignal,
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

  async getSupplyOrders(
    orderIds: Array<number | string>,
    credentials?: OzonCredentials,
  ): Promise<OzonSupplyOrder[]> {
    const numericIds = orderIds
      .map((value) => (typeof value === 'string' ? Number(value.trim()) : Number(value)))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.trunc(value));

    if (!numericIds.length) {
      return [];
    }

    const response = await this.post<{ orders?: OzonSupplyOrder[] }>(
      '/v3/supply-order/get',
      { order_ids: numericIds },
      undefined,
      credentials,
    );

    return response.data?.orders ?? [];
  }

  private composeAbortSignal(
    axiosSignal?: GenericAbortSignal,
    abortSignal?: AbortSignal,
  ): { signal?: GenericAbortSignal; cleanupSignal: () => void } {
    if (axiosSignal) {
      return { signal: axiosSignal, cleanupSignal: () => undefined };
    }
    if (!abortSignal) {
      return { signal: undefined, cleanupSignal: () => undefined };
    }

    if (abortSignal.aborted) {
      const controller = new AbortController();
      controller.abort();
      return { signal: controller.signal, cleanupSignal: () => undefined };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    abortSignal.addEventListener('abort', onAbort);

    return {
      signal: controller.signal,
      cleanupSignal: () => abortSignal.removeEventListener('abort', onAbort),
    };
  }

  private resolveUrl(baseUrl: string, url?: string): string | undefined {
    if (!url) return url;
    if (/^https?:\/\//i.test(url)) return url;

    const normalizedBase = baseUrl.replace(/\/$/, '');
    const normalizedPath = url.startsWith('/') ? url : `/${url}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  private normalizeSupplyType(
    value: OzonDraftSupplyType,
  ): OzonDraftSupplyType {
    if (value === 'DIRECT') {
      return 'DIRECT';
    }

    if (value === 'CROSSDOCK') {
      return 'CROSSDOCK';
    }

    throw new Error(`Unsupported or missing supply type: ${String(value)}`);
  }

  private resolveDraftCreateEndpoint(type: OzonDraftSupplyType): string {
    switch (type) {
      case 'DIRECT':
        return '/v1/draft/direct/create';
      case 'CROSSDOCK':
        return '/v1/draft/crossdock/create';
      default: {
        // Keep switch exhaustive and ready for future multi-cluster support.
        const exhaustiveCheck: never = type;
        return exhaustiveCheck;
      }
    }
  }

  private buildDirectCreateRequest(
    payload: OzonDraftCreatePayload,
    macrolocalClusterId: number,
  ): OzonDirectCreateRequest {
    return {
      cluster_info: {
        items: payload.items,
        macrolocal_cluster_id: macrolocalClusterId,
      },
      deletion_sku_mode: 'PARTIAL',
    };
  }

  private buildCrossdockCreateRequest(
    payload: OzonDraftCreatePayload,
    macrolocalClusterId: number,
  ): OzonCrossdockCreateRequest {
    const dropOffWarehouseId = this.parsePositiveInt(payload.dropOffPointWarehouseId, 'dropOffPointWarehouseId');

    return {
      cluster_info: {
        items: payload.items,
        macrolocal_cluster_id: macrolocalClusterId,
      },
      deletion_sku_mode: 'PARTIAL',
      delivery_info: {
        drop_off_warehouse: {
          warehouse_id: dropOffWarehouseId,
          warehouse_type: 'DELIVERY_POINT',
        },
        type: 'DROPOFF',
      },
    };
  }

  private parsePositiveInt(value: unknown, field: string): number {
    if (typeof value === 'undefined' || value === null) {
      throw new Error(`Missing required field for crossdock draft: ${field}`);
    }

    const parsed = Number(String(value).trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid ${field}: ${String(value)}`);
    }

    return Math.trunc(parsed);
  }

  private parseNonNegativeInt(value: unknown, field: string): number {
    if (typeof value === 'undefined' || value === null) {
      throw new Error(`Missing required field: ${field}`);
    }

    const parsed = Number(String(value).trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid ${field}: ${String(value)}`);
    }

    return Math.trunc(parsed);
  }

  private async resolveMacrolocalClusterId(
    payload: OzonDraftCreatePayload,
    credentials?: OzonCredentials,
    abortSignal?: AbortSignal,
  ): Promise<number> {
    if (typeof payload.macrolocalClusterId !== 'undefined' && payload.macrolocalClusterId !== null) {
      return this.parsePositiveInt(payload.macrolocalClusterId, 'macrolocalClusterId');
    }

    const clusterId = this.parsePositiveInt(payload.clusterIds[0], 'clusterIds[0]');
    if (!credentials) {
      return clusterId;
    }

    try {
      const { clusters } = await this.listClusters({ clusterIds: [clusterId] }, credentials, abortSignal);
      const cluster =
        clusters.find((entry) => Number(entry.id) === clusterId) ??
        clusters[0];
      const macro = cluster?.macrolocal_cluster_id;
      if (typeof macro === 'number' && Number.isFinite(macro) && macro > 0) {
        return Math.trunc(macro);
      }
      this.logger.warn(
        `[OzonApiService] macrolocal_cluster_id is missing for cluster_id=${clusterId}, fallback to cluster id`,
      );
      return clusterId;
    } catch (error) {
      this.logger.warn(
        `[OzonApiService] failed to resolve macrolocal_cluster_id for cluster_id=${clusterId}: ${this.describeError(error)}; fallback to cluster id`,
      );
      return clusterId;
    }
  }

  private extractOperationId(data: unknown): string | undefined {
    if (!data || typeof data !== 'object') {
      return undefined;
    }
    const body = data as Record<string, unknown>;
    const direct = this.readNonEmptyString(body.operation_id) ?? this.readNonEmptyString(body.operationId);
    if (direct) {
      return direct;
    }

    const result = body.result;
    if (!result || typeof result !== 'object') {
      return undefined;
    }
    const nested = result as Record<string, unknown>;
    return this.readNonEmptyString(nested.operation_id) ?? this.readNonEmptyString(nested.operationId);
  }

  private readNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private extractDraftId(data: unknown): number | undefined {
    if (!data || typeof data !== 'object') {
      return undefined;
    }
    const raw = (data as Record<string, unknown>).draft_id;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.trunc(raw);
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.trunc(parsed);
      }
    }
    return undefined;
  }

  private extractDraftCreateErrors(data: unknown): string[] {
    if (!data || typeof data !== 'object') {
      return [];
    }
    const rawErrors = (data as Record<string, unknown>).errors;
    if (!Array.isArray(rawErrors)) {
      return [];
    }

    return rawErrors
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return undefined;
        }
        const error = entry as Record<string, unknown>;
        const parts: string[] = [];

        const message = this.readNonEmptyString(error.message);
        if (message) parts.push(message);

        const errorMessage = this.readNonEmptyString(error.error_message);
        if (errorMessage && errorMessage !== message) parts.push(errorMessage);

        const reasons = Array.isArray(error.error_reasons)
          ? error.error_reasons
              .map((reason) => this.readNonEmptyString(reason))
              .filter((reason): reason is string => Boolean(reason))
          : [];
        if (reasons.length) {
          parts.push(`reasons=${reasons.join(',')}`);
        }

        const skus = Array.isArray(error.skus)
          ? error.skus.map((sku) => this.readNonEmptyString(sku)).filter((sku): sku is string => Boolean(sku))
          : [];
        if (skus.length) {
          parts.push(`skus=${skus.join(',')}`);
        }

        const clusterIds = Array.isArray(error.macrolocal_cluster_ids)
          ? error.macrolocal_cluster_ids
              .map((id) => this.readNonEmptyString(id))
              .filter((id): id is string => Boolean(id))
          : [];
        if (clusterIds.length) {
          parts.push(`macrolocal_cluster_ids=${clusterIds.join(',')}`);
        }

        const itemsValidation = Array.isArray(error.items_validation) ? error.items_validation : [];
        const rejected: string[] = [];
        for (const validation of itemsValidation) {
          if (!validation || typeof validation !== 'object') {
            continue;
          }
          const v = validation as Record<string, unknown>;
          const macrolocalClusterId = this.readNonEmptyString(v.macrolocal_cluster_id) ?? String(v.macrolocal_cluster_id ?? '');
          const rejectedItems = Array.isArray(v.rejected_items) ? v.rejected_items : [];
          for (const item of rejectedItems) {
            if (!item || typeof item !== 'object') {
              continue;
            }
            const rejectedItem = item as Record<string, unknown>;
            const sku = this.readNonEmptyString(rejectedItem.sku) ?? String(rejectedItem.sku ?? '');
            const itemReasons = Array.isArray(rejectedItem.reasons)
              ? rejectedItem.reasons
                  .map((reason) => this.readNonEmptyString(reason))
                  .filter((reason): reason is string => Boolean(reason))
              : [];
            if (sku || itemReasons.length) {
              rejected.push(
                `cluster=${macrolocalClusterId || 'n/a'} sku=${sku || 'n/a'} reasons=${itemReasons.join(',') || 'n/a'}`,
              );
            }
          }
        }
        if (rejected.length) {
          parts.push(`rejected_items=[${rejected.join(' | ')}]`);
        }

        return parts.length ? parts.join(' ') : undefined;
      })
      .filter((value): value is string => Boolean(value));
  }

  private parseLocalDraftOperationId(operationId: string): number | undefined {
    const match = /^draft-(\d+)$/.exec(operationId.trim());
    if (!match) {
      return undefined;
    }
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return Math.trunc(parsed);
  }

  private normalizeTimeslotResponse(data: OzonTimeslotResponse | undefined): OzonTimeslotResponse {
    if (!data) {
      return {};
    }

    const source = data.drop_off_warehouse_timeslots?.length
      ? data.drop_off_warehouse_timeslots
      : this.extractTimeslotBucketsFromResult(data.result?.drop_off_warehouse_timeslots);

    const buckets: NonNullable<OzonTimeslotResponse['drop_off_warehouse_timeslots']> = [];
    for (const bucket of source ?? []) {
      if (!bucket || typeof bucket !== 'object') {
        continue;
      }

      const normalizedDays: Array<{ timeslots?: OzonDraftTimeslot[] }> = [];
      for (const day of bucket.days ?? []) {
        if (!day || typeof day !== 'object') {
          continue;
        }
        const normalizedSlots: OzonDraftTimeslot[] = [];
        for (const slot of day.timeslots ?? []) {
          const from = this.normalizeOzonDateTime(slot?.from_in_timezone);
          const to = this.normalizeOzonDateTime(slot?.to_in_timezone);
          if (!from || !to) {
            continue;
          }
          normalizedSlots.push({
            from_in_timezone: from,
            to_in_timezone: to,
          });
        }
        normalizedDays.push({ timeslots: normalizedSlots });
      }

      buckets.push({
        drop_off_warehouse_id: bucket.drop_off_warehouse_id,
        warehouse_timezone: bucket.warehouse_timezone,
        current_time_in_timezone: this.normalizeOzonDateTime(bucket.current_time_in_timezone),
        days: normalizedDays,
      });
    }

    return {
      drop_off_warehouse_timeslots: buckets,
    };
  }

  private extractTimeslotBucketsFromResult(
    source:
      | {
          drop_off_warehouse_id?: number | string;
          warehouse_timezone?: string;
          current_time_in_timezone?: string;
          days?: Array<{ date_in_timezone?: string; timeslots?: OzonDraftTimeslot[] }>;
        }
      | Array<{
          drop_off_warehouse_id?: number | string;
          warehouse_timezone?: string;
          current_time_in_timezone?: string;
          days?: Array<{ date_in_timezone?: string; timeslots?: OzonDraftTimeslot[] }>;
        }>
      | undefined,
  ) {
    if (!source) {
      return [];
    }
    return Array.isArray(source) ? source : [source];
  }

  private normalizeOzonDateTime(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    // New Ozon contracts return local datetime without timezone.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
      return `${trimmed}Z`;
    }

    return trimmed;
  }

  private toOzonLocalDateTime(value: string): string {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
      return trimmed;
    }

    // Supply create expects local datetime without timezone suffix.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(trimmed)) {
      return trimmed.slice(0, -1);
    }

    return trimmed;
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

  private ensureNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw this.createAbortError();
    }
  }

  private createAbortError(): Error {
    const error = new Error('Request aborted by signal');
    error.name = 'AbortError';
    return error;
  }

  private isAbortError(err: unknown): boolean {
    if (!err) {
      return false;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return true;
    }
    if (isAxiosError(err) && err.code === 'ERR_CANCELED') {
      return true;
    }
    return typeof (err as any)?.code === 'string' && (err as any).code === 'ERR_CANCELED';
  }

  private sleep(ms: number, signal?: AbortSignal) {
    if (!signal) {
      return new Promise<void>((resolve) => setTimeout(() => resolve(undefined), ms));
    }

    if (signal.aborted) {
      return Promise.reject(this.createAbortError());
    }

    return new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;

      const onAbort = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        signal.removeEventListener('abort', onAbort);
        reject(this.createAbortError());
      };

      timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(undefined);
      }, ms);

      signal.addEventListener('abort', onAbort);
    });
  }
}
