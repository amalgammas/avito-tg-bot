import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  OzonApiService,
  OzonCredentials,
  OzonDraftTimeslot,
  OzonCluster,
  OzonAvailableWarehouse,
  OzonDraftStatus,
} from '../config/ozon-api.service';
import {
  OzonSupplyProcessOptions,
  OzonSupplyProcessResult,
  OzonSupplyTask,
  OzonSupplyTaskMap,
  OzonSupplyItem,
} from './ozon-supply.types';
import { OzonSheetService } from './ozon-sheet.service';

interface PrepareTasksOptions {
  credentials?: OzonCredentials;
  spreadsheet?: string;
  buffer?: Buffer;
}

@Injectable()
export class OzonSupplyService {
  private readonly logger = new Logger(OzonSupplyService.name);
  private readonly dropOffPointWarehouseId: string;
  private readonly defaultSpreadsheetId: string;
  private readonly pollIntervalMs: number;
  private readonly availableWarehousesTtlMs = 10 * 60 * 1000; // 10 минут
  private readonly draftTtlMs = 55 * 60 * 1000; // 55 минут
  private readonly draftCache = new Map<
    string,
    { operationId: string; draftId?: number; expiresAt: number }
  >();
  private lastClusters: OzonCluster[] = [];
  private availableWarehousesCache?: {
    warehouses: OzonAvailableWarehouse[];
    expiresAt: number;
  };

  constructor(
    private readonly sheetService: OzonSheetService,
    private readonly ozonApi: OzonApiService,
    private readonly configService: ConfigService,
  ) {
    this.dropOffPointWarehouseId =
      String(this.configService.get('ozonSupply.dropOffPointWarehouseId') ?? '').trim();
    this.defaultSpreadsheetId =
      String(this.configService.get('ozonSupply.spreadsheetId') ?? '').trim();
    this.pollIntervalMs = Number(
      this.configService.get('ozonSupply.pollIntervalMs') ?? 3_000,
    );
  }

  private getDefaultDropOffId(): number {
    const trimmed = this.dropOffPointWarehouseId.trim();
    if (!trimmed) {
      return 0;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  async prepareTasks(options: PrepareTasksOptions = {}): Promise<OzonSupplyTaskMap> {
    const credentials = options.credentials;
    const tasks = await this.sheetService.loadTasks({
      spreadsheet: options.spreadsheet,
      buffer: options.buffer,
    });
    const { clusters } = await this.ozonApi.listClusters({}, credentials);
    this.lastClusters = clusters;

    for (const task of tasks) {
      if (!task.city) continue;
      const clusterId = this.ozonApi.findClusterIdByName(task.city, clusters);
      const warehouseId = task.warehouseName
        ? this.ozonApi.findWarehouseId(task.city, task.warehouseName, clusters)
        : undefined;

      task.clusterId = clusterId;
      task.warehouseId = warehouseId;
    }

    const result: OzonSupplyTaskMap = new Map();
    for (const task of tasks) {
      result.set(task.taskId, task);
    }

    return result;
  }

  async processTasks(
    taskMap: OzonSupplyTaskMap,
    options: OzonSupplyProcessOptions = {},
  ): Promise<void> {
    if (!taskMap.size) {
      this.logger.warn('Нет задач для обработки');
      return;
    }

    const delayBetweenCalls = options.delayBetweenCallsMs ?? this.pollIntervalMs;
    const credentials = options.credentials;
    const abortSignal = options.abortSignal;

    this.ensureNotAborted(abortSignal);

    const dropOffWarehouseId = options.dropOffWarehouseId ?? this.getDefaultDropOffId();
    if (!dropOffWarehouseId) {
      throw new Error('Пункт сдачи (drop-off) не задан. Укажите его в мастере или через OZON_SUPPLY_DROP_OFF_ID.');
    }
    if (!options.skipDropOffValidation) {
      await this.ensureDropOffWarehouseAvailable(dropOffWarehouseId, credentials);
    }
    const seenUnavailableWarehouses = new Set<number>();

    while (taskMap.size) {
      this.ensureNotAborted(abortSignal);

      for (const [taskId, state] of Array.from(taskMap.entries())) {
        this.ensureNotAborted(abortSignal);
        try {
          const result = await this.processSingleTask(state, credentials, dropOffWarehouseId);
          if (result.event === 'error' && /Склад отгрузки/.test(result.message ?? '')) {
            const match = /Склад отгрузки (\d+)/.exec(result.message ?? '');
            const warehouseId = match ? Number(match[1]) : undefined;
            if (warehouseId && !seenUnavailableWarehouses.has(warehouseId)) {
              seenUnavailableWarehouses.add(warehouseId);
              await this.emitEvent(options.onEvent, {
                task: state,
                event: 'error',
                message: `⚠️ Склад ${warehouseId} недоступен по данным Ozon (drop-off ${dropOffWarehouseId}). Выберите склад из списка, предложенного черновиком.`,
              });
            }
          }
          await this.emitEvent(options.onEvent, result);

          if (result.event === 'supplyCreated' && result.operationId) {
            await this.emitSupplyStatus(result.operationId, state, credentials, options.onEvent);
          }

          if (state.orderFlag === 1) {
            this.logger.log(`[${taskId}] Поставка создана, удаляем из очереди`);
            taskMap.delete(taskId);
            continue;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[${taskId}] Ошибка обработки: ${message}`);
          await this.emitEvent(options.onEvent, { task: state, event: 'error', message });
        }

        try {
          await this.sleep(delayBetweenCalls, abortSignal);
        } catch (error) {
          if (this.isAbortError(error)) {
            this.logger.warn('Обработка поставок прервана по сигналу отмены');
            throw error;
          }
          throw error;
        }
      }
    }
  }

  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  async runSingleTask(
    task: OzonSupplyTask,
    options: OzonSupplyProcessOptions & { readyInDays: number },
  ): Promise<void> {
    const cloned = this.cloneTask(task);
    cloned.lastDay = this.computeReadyDate(options.readyInDays);
    cloned.orderFlag = cloned.orderFlag ?? 0;

    const map: OzonSupplyTaskMap = new Map([[cloned.taskId, cloned]]);

    await this.processTasks(map, {
      ...options,
      delayBetweenCallsMs: options.delayBetweenCallsMs ?? this.pollIntervalMs,
    });
  }

  private async ensureDropOffWarehouseAvailable(
    dropOffId: number,
    credentials?: OzonCredentials,
  ): Promise<void> {
    if (!dropOffId) {
      throw new Error('Пункт сдачи не задан. Выберите склад drop-off перед запуском.');
    }

    const warehouses = await this.getAvailableWarehouses(credentials);
    const found = warehouses.some(
      (warehouse) => Number(warehouse.warehouse_id) === dropOffId,
    );

    if (!found) {
      const sample = warehouses
        .slice(0, 5)
        .map((warehouse) => `${warehouse.warehouse_id}${warehouse.name ? ` (${warehouse.name})` : ''}`)
        .join(', ');
      const error = new Error(
        [
          `Склад отгрузки ${dropOffId} отсутствует среди доступных складов Ozon.`,
          'Проверьте переменную OZON_SUPPLY_DROP_OFF_ID или права доступа.',
          sample ? `Ответ сервиса: ${sample}${warehouses.length > 5 ? ', …' : ''}` : 'Сервис вернул пустой список.',
        ].join(' '),
      );
      (error as any).isExpectedFlowError = true;
      throw error;
    }
  }

  private async getAvailableWarehouses(credentials?: OzonCredentials): Promise<OzonAvailableWarehouse[]> {
    const now = Date.now();
    const cached = this.availableWarehousesCache;
    if (cached && cached.expiresAt > now) {
      return cached.warehouses;
    }

    const creds = credentials ?? this.ozonApiDefaultCredentials();
    if (!creds.clientId || !creds.apiKey) {
      throw new Error('Не заданы ключи для проверки доступного склада');
    }

    const warehouses = await this.ozonApi.listAvailableWarehouses(creds);
    this.availableWarehousesCache = {
      warehouses,
      expiresAt: now + this.availableWarehousesTtlMs,
    };
    return warehouses;
  }

  private async emitEvent(
    handler: OzonSupplyProcessOptions['onEvent'],
    result: OzonSupplyProcessResult,
  ): Promise<void> {
    try {
      await handler?.(result);
    } catch (error) {
      this.logger.warn(`onEvent handler failed: ${String(error)}`);
    }
  }

  private async emitSupplyStatus(
    operationId: string,
    task: OzonSupplyTask,
    credentials: OzonCredentials | undefined,
    handler: OzonSupplyProcessOptions['onEvent'],
  ): Promise<void> {
    try {
      const status = await this.ozonApi.getSupplyCreateStatus(operationId, credentials);
      const message = this.describeSupplyStatus(status);
      await this.emitEvent(handler, {
        task,
        event: 'supplyStatus',
        message,
        operationId,
      });
    } catch (error) {
      this.logger.warn(`Не удалось получить статус поставки ${operationId}: ${String(error)}`);
      await this.emitEvent(handler, {
        task,
        event: 'supplyStatus',
        message: `Не удалось получить статус поставки ${operationId}: ${this.describeUnknownError(error)}`,
        operationId,
      });
    }
  }

  private describeSupplyStatus(status: unknown): string {
    if (!status || typeof status !== 'object') {
      return 'Статус поставки: ответ без данных';
    }

    const payload = status as any;
    const parts: string[] = [];
    if (payload.state) {
      parts.push(`state=${payload.state}`);
    }
    if (payload.status) {
      parts.push(`status=${payload.status}`);
    }
    if (Array.isArray(payload.errors) && payload.errors.length) {
      parts.push(
        'errors=' +
          payload.errors
            .map((err: any) => `${err?.code ?? 'n/a'}:${err?.message ?? '—'}`)
            .join(', '),
      );
    }
    return parts.length ? `Статус поставки: ${parts.join(', ')}` : 'Статус поставки: ответ без статуса';
  }

  private describeUnknownError(error: unknown): string {
    if (!error) return 'unknown error';
    if (error instanceof Error) return error.message;
    return String(error);
  }

  getClustersOverview(tasks: Map<string, OzonSupplyTask>): string[] {
    if (!this.lastClusters.length) {
      return [];
    }

    const byCluster = new Map<
      number,
      { name: string; warehouseNames: Set<string>; warehouseIds: Set<number> }
    >();

    for (const task of tasks.values()) {
      if (!task.clusterId) continue;
      const cluster = this.lastClusters.find((c) => c.id === task.clusterId);
      if (!cluster) continue;

      const entry = byCluster.get(cluster.id) ?? {
        name: cluster.name ?? `Кластер ${cluster.id}`,
        warehouseNames: new Set<string>(),
        warehouseIds: new Set<number>(),
      };

      if (task.warehouseName) entry.warehouseNames.add(task.warehouseName);
      if (task.warehouseId) entry.warehouseIds.add(task.warehouseId);

      byCluster.set(cluster.id, entry);
    }

    return [...byCluster.values()].map((entry) => {
      const names = [...entry.warehouseNames].join(', ') || 'не указаны';
      return `• ${entry.name}: ${names}`;
    });
  }

  getCachedClusters(): OzonCluster[] {
    return this.lastClusters;
  }

  private async processSingleTask(
    task: OzonSupplyTask,
    credentials: OzonCredentials | undefined,
    dropOffWarehouseId: number,
    abortSignal?: AbortSignal,
  ): Promise<OzonSupplyProcessResult> {
    this.ensureNotAborted(abortSignal);

    if (!credentials && !this.ozonApiDefaultCredentialsAvailable()) {
      return { task, event: 'noCredentials', message: 'Не заданы ключи Ozon' };
    }

    if (!task.clusterId) {
      return { task, event: 'error', message: 'Не удалось определить cluster_id' };
    }

    const creds = credentials ?? this.ozonApiDefaultCredentials();

    if (task.draftOperationId) {
      return this.handleExistingDraft(task, creds, abortSignal);
    }

    return this.createDraft(task, creds, dropOffWarehouseId, abortSignal);
  }

  private async handleExistingDraft(
    task: OzonSupplyTask,
    credentials: OzonCredentials,
    abortSignal?: AbortSignal,
  ): Promise<OzonSupplyProcessResult> {
    this.ensureNotAborted(abortSignal);
    const info = await this.ozonApi.getDraftInfo(task.draftOperationId, credentials);
    this.ensureNotAborted(abortSignal);

    if (info.status === 'CALCULATION_STATUS_SUCCESS') {
      const warehouseChoice = this.resolveWarehouseFromDraft(info, task.warehouseId, task.warehouseName);
      if (!warehouseChoice) {
        return {
          task,
          event: 'draftError',
          message: 'Черновик не содержит доступных складов для отгрузки',
        };
      }

      const selectedWarehouseId = warehouseChoice.warehouseId;
      const selectedWarehouseName = warehouseChoice.name;
      const warehouseChanged =
        typeof task.warehouseId === 'number' && task.warehouseId !== selectedWarehouseId;

      task.warehouseId = selectedWarehouseId;
      task.warehouseName = selectedWarehouseName ?? task.warehouseName;
      task.draftId = info.draft_id ?? task.draftId;
      this.rememberDraft(task, info.draft_id ?? task.draftId);
      this.ensureNotAborted(abortSignal);
      const timeslot = await this.pickTimeslot(task, credentials, abortSignal);

      if (!timeslot) {
        return { task, event: 'timeslotMissing', message: 'Свободных таймслотов нет' };
      }
      task.selectedTimeslot = timeslot;

      const operationId = await this.ozonApi.createSupply(
        {
          draftId: task.draftId,
          warehouseId: task.warehouseId!,
          timeslot,
        },
        credentials,
      );

      if (operationId) {
        task.orderFlag = 1;
        const messageParts = [`Создана поставка, operation_id=${operationId}`];
        if (warehouseChanged) {
          messageParts.push(`выбран склад ${selectedWarehouseId}`);
        }
        return {
          task,
          event: 'supplyCreated',
          message: messageParts.join(', '),
          operationId,
        };
      }

      return { task, event: 'error', message: 'Ответ без operation_id при создании поставки' };
    }

    if (info.code === 5) {
      task.draftOperationId = '';
      task.draftId = 0;
      this.draftCache.delete(this.getTaskHash(task));
      return { task, event: 'draftExpired', message: 'Черновик устарел, создадим заново' };
    }

    if (info.code === 1) {
      task.draftOperationId = '';
      task.draftId = 0;
      this.draftCache.delete(this.getTaskHash(task));
      return { task, event: 'draftInvalid', message: 'Черновик невалидный' };
    }

    return {
      task,
      event: 'draftError',
      message: `Неожиданный ответ статуса черновика: ${JSON.stringify(info)}`,
    };
  }

  private async createDraft(
    task: OzonSupplyTask,
    credentials: OzonCredentials,
    dropOffWarehouseId: number,
    abortSignal?: AbortSignal,
  ): Promise<OzonSupplyProcessResult> {
    this.ensureNotAborted(abortSignal);
    const cacheKey = this.getTaskHash(task);
    const cached = this.draftCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      task.draftOperationId = cached.operationId;
      task.draftId = cached.draftId ?? task.draftId;
      return {
        task,
        event: 'draftValid',
        message: `Используем существующий черновик ${cached.operationId}`,
      };
    }

    this.ensureNotAborted(abortSignal);
    const ozonItems = await this.buildOzonItems(task, credentials);
    this.ensureNotAborted(abortSignal);

    const operationId = await this.ozonApi.createDraft(
      {
        clusterIds: [task.clusterId!],
        dropOffPointWarehouseId: dropOffWarehouseId,
        items: ozonItems,
        type: 'CREATE_TYPE_CROSSDOCK',
      },
      credentials,
    );
    this.ensureNotAborted(abortSignal);

    if (!operationId) {
      return { task, event: 'error', message: 'Черновик не создан: пустой operation_id' };
    }

    task.draftOperationId = operationId;
    this.draftCache.set(cacheKey, {
      operationId,
      draftId: undefined,
      expiresAt: Date.now() + this.draftTtlMs,
    });

    return { task, event: 'draftCreated', message: `Создан черновик ${operationId}` };
  }

  private async pickTimeslot(
    task: OzonSupplyTask,
    credentials: OzonCredentials,
    abortSignal?: AbortSignal,
  ): Promise<OzonDraftTimeslot | undefined> {
    if (task.selectedTimeslot) {
      return task.selectedTimeslot;
    }

    if (!task.draftId) {
      return undefined;
    }

    const dateFrom = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const dateFromIso = this.toOzonIso(dateFrom);
    const dateToIso = this.normalizeDateString(task.lastDay);

    const response = await this.ozonApi.getDraftTimeslots(
      {
        draftId: task.draftId,
        warehouseIds: [task.warehouseId!],
        dateFrom: dateFromIso,
        dateTo: dateToIso,
      },
      credentials,
    );
    this.ensureNotAborted(abortSignal);

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

  private resolveWarehouseFromDraft(
    info: OzonDraftStatus,
    preferredWarehouseId: number | undefined,
    preferredWarehouseName: string | undefined,
  ): { warehouseId: number; name?: string } | undefined {
    const warehouses = this.collectDraftWarehouses(info);
    if (!warehouses.length) {
      return undefined;
    }

    if (typeof preferredWarehouseId === 'number') {
      const match = warehouses.find(
        (entry) => entry.warehouseId === preferredWarehouseId && entry.isAvailable !== false,
      );
      if (match) {
        return { warehouseId: match.warehouseId, name: match.name ?? preferredWarehouseName };
      }
    }

    const firstAvailable = warehouses.find((entry) => entry.isAvailable !== false);
    if (firstAvailable) {
      return { warehouseId: firstAvailable.warehouseId, name: firstAvailable.name ?? preferredWarehouseName };
    }

    const fallback = warehouses[0];
    return fallback
      ? { warehouseId: fallback.warehouseId, name: fallback.name ?? preferredWarehouseName }
      : undefined;
  }

  private collectDraftWarehouses(
    info: OzonDraftStatus,
  ): Array<{ warehouseId: number; name?: string; isAvailable?: boolean }> {
    const result: Array<{ warehouseId: number; name?: string; isAvailable?: boolean }> = [];
    for (const cluster of info.clusters ?? []) {
      for (const warehouseInfo of cluster.warehouses ?? []) {
        const rawId =
          warehouseInfo?.supply_warehouse?.warehouse_id ??
          (warehouseInfo as any)?.warehouse_id ??
          undefined;
        const warehouseId = this.parseWarehouseId(rawId);
        if (!warehouseId) {
          continue;
        }
        const name = warehouseInfo?.supply_warehouse?.name?.trim();
        const isAvailable = warehouseInfo?.status?.is_available;
        result.push({ warehouseId, name, isAvailable });
      }
    }
    return result;
  }

  private parseWarehouseId(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.round(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.round(parsed);
      }
    }
    return undefined;
  }

  private ozonApiDefaultCredentialsAvailable(): boolean {
    const creds = this.ozonApiDefaultCredentials();
    return Boolean(creds.clientId && creds.apiKey);
  }

  private ozonApiDefaultCredentials(): OzonCredentials {
    return {
      clientId: this.configService.get<string>('ozon.clientId') ?? '',
      apiKey: this.configService.get<string>('ozon.apiKey') ?? '',
    };
  }

  private toOzonIso(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private normalizeDateString(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return this.toOzonIso(new Date(Date.now() + 28 * 24 * 60 * 60 * 1000));
    }

    if (/T/.test(trimmed)) {
      return trimmed;
    }

    return `${trimmed}T23:59:59Z`;
  }

  private computeReadyDate(days: number): string {
    const minDays = 2;
    const maxDays = 28;
    const defaultDays = 2;

    let readyDays: number;
    if (!Number.isFinite(days)) {
      readyDays = defaultDays;
    } else {
      const rounded = Math.floor(days);
      if (rounded === 0) {
        readyDays = 0;
      } else if (rounded < minDays) {
        readyDays = minDays;
      } else if (rounded > maxDays) {
        readyDays = maxDays;
      } else {
        readyDays = rounded;
      }
    }

    const base = new Date();
    base.setUTCDate(base.getUTCDate() + readyDays);
    base.setUTCHours(23, 59, 59, 0);
    return this.toOzonIso(base);
  }

  private cloneTask(task: OzonSupplyTask): OzonSupplyTask {
    return {
      ...task,
      items: task.items.map((item) => ({ ...item })),
    };
  }

  private rememberDraft(task: OzonSupplyTask, draftId?: number) {
    const cacheKey = this.getTaskHash(task);
    const existing = this.draftCache.get(cacheKey);
    if (existing) {
      existing.draftId = draftId ?? existing.draftId;
      existing.expiresAt = Date.now() + this.draftTtlMs;
    } else if (task.draftOperationId) {
      this.draftCache.set(cacheKey, {
        operationId: task.draftOperationId,
        draftId,
        expiresAt: Date.now() + this.draftTtlMs,
      });
    }
  }

  private getTaskHash(task: OzonSupplyTask): string {
    const itemsHash = task.items
      .slice()
      .sort((a, b) => a.article.localeCompare(b.article, 'ru', { sensitivity: 'base' }))
      .map((item) => `${item.article}:${item.quantity}`)
      .join('|');
    return `${task.clusterId ?? 'x'}-${task.warehouseId ?? 'x'}-${itemsHash}`;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    if (signal.aborted) {
      return Promise.reject(this.createAbortError());
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        reject(this.createAbortError());
      };

      signal.addEventListener('abort', onAbort);
    });
  }

  private ensureNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw this.createAbortError();
    }
  }

  private createAbortError(): Error {
    const error = new Error('Processing aborted by signal');
    error.name = 'AbortError';
    return error;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private async buildOzonItems(
    task: OzonSupplyTask,
    credentials: OzonCredentials,
  ): Promise<Array<{ sku: number; quantity: number }>> {
    const result: Array<{ sku: number; quantity: number }> = [];
    const articlesToResolve = new Set<string>();

    for (const item of task.items) {
      if (!item.article) {
        throw new Error('В документе есть строки без артикула.');
      }

      const trimmed = item.article.trim();
      if (!trimmed) {
        throw new Error('В документе есть строки с пустым артикулом.');
      }

      if (!item.sku) {
        const numericCandidate = Number(trimmed);
        if (Number.isFinite(numericCandidate) && numericCandidate > 0) {
          item.sku = Math.round(numericCandidate);
        } else {
          articlesToResolve.add(trimmed);
        }
      }
    }

    let resolvedSkus = new Map<string, number>();
    if (articlesToResolve.size) {
      resolvedSkus = await this.ozonApi.getProductsByOfferIds(Array.from(articlesToResolve), credentials);
    }

    for (const item of task.items) {
      const trimmed = item.article.trim();
      const skuNumber = item.sku ?? resolvedSkus.get(trimmed);
      if (!skuNumber) {
        throw new Error(`Для артикула «${item.article}» не найден SKU в кабинете Ozon.`);
      }

      if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
        throw new Error(`Количество должно быть положительным числом (артикул ${item.article}).`);
      }

      const normalizedSku = Math.round(skuNumber);
      item.sku = normalizedSku;
      result.push({ sku: normalizedSku, quantity: Math.round(item.quantity) });
    }

    return result;
  }
}
