import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AxiosError } from 'axios';

import {
  OzonApiService,
  OzonCredentials,
  OzonDraftTimeslot,
  OzonCluster,
  OzonAvailableWarehouse,
  OzonDraftStatus,
} from '../config/ozon-api.service';
import {
  addUtcDays,
  endOfUtcDay,
  parseIsoDate,
  startOfUtcDay,
  toOzonIso,
} from '@bot/utils/time.utils';
import {
  OzonSupplyEventType,
  OzonSupplyProcessOptions,
  OzonSupplyProcessResult,
  OzonSupplyTask,
  OzonSupplyTaskMap
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
  private readonly timeslotWindowMaxDays = 28;
  private readonly dayMs = 24 * 60 * 60 * 1000;
  private readonly draftMinuteLimit = 2;
  private readonly draftHourLimit = 50;
  private readonly draftSecondIntervalMs = 2_000;
  private readonly draftMinuteWindowMs = 60 * 1000;
  private readonly draftHourWindowMs = 60 * 60 * 1000;
  private draftRequestHistory = new Map<string, { minute: number[]; hour: number[]; lastTs?: number }>();
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
      await this.ensureDropOffWarehouseAvailable(dropOffWarehouseId, credentials, abortSignal);
    }
    const seenUnavailableWarehouses = new Set<number>();

    while (taskMap.size) {
      this.ensureNotAborted(abortSignal);

      for (const [taskId, state] of Array.from(taskMap.entries())) {
        this.ensureNotAborted(abortSignal);
        try {
          const result = await this.processSingleTask(state, credentials, dropOffWarehouseId, abortSignal);
          const eventType = result.event?.type ?? OzonSupplyEventType.Error;

          if (eventType === OzonSupplyEventType.Error && /Склад отгрузки/.test(result.message ?? '')) {
            const match = /Склад отгрузки (\d+)/.exec(result.message ?? '');
            const warehouseId = match ? Number(match[1]) : undefined;
            if (warehouseId && !seenUnavailableWarehouses.has(warehouseId)) {
              seenUnavailableWarehouses.add(warehouseId);
              await this.emitEvent(options.onEvent, {
                task: state,
                event: { type: OzonSupplyEventType.Error },
                message: `⚠️ Склад ${warehouseId} недоступен по данным Ozon (drop-off ${dropOffWarehouseId}). Выберите склад из списка, предложенного черновиком.`,
              });
            }
          }
          await this.emitEvent(options.onEvent, result);

          if (eventType === OzonSupplyEventType.SupplyCreated && result.operationId) {
            await this.emitSupplyStatus(result.operationId, state, credentials, options.onEvent, abortSignal);
          }

          if (state.orderFlag === 1) {
            this.logger.log(`[${taskId}] Поставка создана, удаляем из очереди`);
            taskMap.delete(taskId);
            continue;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[${taskId}] Ошибка обработки: ${message}`);
          await this.emitEvent(options.onEvent, { task: state, event: { type: OzonSupplyEventType.Error }, message });
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
    cloned.readyInDays = options.readyInDays;
    cloned.lastDay = this.computeTimeslotUpperBound();
    cloned.orderFlag = cloned.orderFlag ?? 0;

    const map: OzonSupplyTaskMap = new Map([[cloned.taskId, cloned]]);

    await this.processTasks(map, {
      ...options,
      delayBetweenCallsMs: options.delayBetweenCallsMs ?? this.pollIntervalMs,
    });
  }

  private async ensureDropOffWarehouseAvailable(
    dropOffId: number,
    credentials: OzonCredentials | undefined,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (!dropOffId) {
      throw new Error('Пункт сдачи не задан. Выберите склад drop-off перед запуском.');
    }

    const warehouses = await this.getAvailableWarehouses(credentials, abortSignal);
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

  private async getAvailableWarehouses(
    credentials: OzonCredentials | undefined,
    abortSignal?: AbortSignal,
  ): Promise<OzonAvailableWarehouse[]> {
    const now = Date.now();
    const cached = this.availableWarehousesCache;
    if (cached && cached.expiresAt > now) {
      return cached.warehouses;
    }

    const creds = credentials ?? this.ozonApiDefaultCredentials();
    if (!creds.clientId || !creds.apiKey) {
      throw new Error('Не заданы ключи для проверки доступного склада');
    }

    const warehouses = await this.ozonApi.listAvailableWarehouses(creds, abortSignal);
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
    abortSignal?: AbortSignal,
  ): Promise<void> {
    try {
      const status = await this.ozonApi.getSupplyCreateStatus(operationId, credentials, abortSignal);
      const message = this.describeSupplyStatus(status);
      await this.emitEvent(handler, {
        task,
        event: { type: OzonSupplyEventType.SupplyStatus },
        message,
        operationId,
      });
    } catch (error) {
      this.logger.warn(`Не удалось получить статус поставки ${operationId}: ${String(error)}`);
      await this.emitEvent(handler, {
        task,
        event: { type: OzonSupplyEventType.SupplyStatus },
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
      return { task, event: { type: OzonSupplyEventType.NoCredentials }, message: 'Не заданы ключи Ozon' };
    }

    if (!task.clusterId) {
      return { task, event: { type: OzonSupplyEventType.Error }, message: 'Не удалось определить cluster_id' };
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
    let info: OzonDraftStatus;
      try {
        await this.throttleDraftRequests(credentials, abortSignal);
        info = await this.ozonApi.getDraftInfo(task.draftOperationId, credentials, abortSignal);
      } catch (error) {
      const axiosError = error as AxiosError<any>;
      const response = axiosError?.response;
      const data = response?.data as { code?: number };
      if (response?.status === 404 && data?.code === 5) {
        task.draftOperationId = '';
        task.draftId = 0;
        return { task, event: { type: OzonSupplyEventType.DraftExpired }, message: 'Черновик не найден, создаём заново' };
      }
      throw error;
    }
    this.ensureNotAborted(abortSignal);

    if (info.status === 'CALCULATION_STATUS_SUCCESS') {
      const strictWarehouse = task.warehouseAutoSelect === false && typeof task.warehouseId === 'number';
      const warehouseChoice = this.resolveWarehouseFromDraft(info, task.warehouseId, task.warehouseName, {
        strict: strictWarehouse,
      });
      if (!warehouseChoice) {
        if (strictWarehouse) {
          const message = task.warehouseSelectionPendingNotified
            ? undefined
            : `Ждём склад ${task.warehouseId}. Ozon пока его не подтвердил.`;
          task.warehouseSelectionPendingNotified = true;
          return {
            task,
            event: { type: OzonSupplyEventType.WarehousePending },
            message,
          };
        }
        return {
          task,
          event: { type: OzonSupplyEventType.DraftError },
          message: 'Черновик не содержит доступных складов для отгрузки',
        };
      }
      task.warehouseSelectionPendingNotified = false;

      const selectedWarehouseId = warehouseChoice.warehouseId;
      const selectedWarehouseName = warehouseChoice.name;
      const warehouseChanged =
        typeof task.warehouseId === 'number' && task.warehouseId !== selectedWarehouseId;

      task.warehouseId = selectedWarehouseId;
      task.warehouseName = selectedWarehouseName ?? task.warehouseName;
      task.draftId = info.draft_id ?? task.draftId;
      this.ensureNotAborted(abortSignal);

      const window = this.computeTimeslotWindow(task);
      if (window.expired) {
        task.orderFlag = 1;
        return {
          task,
          event: { type: OzonSupplyEventType.WindowExpired },
          message: 'Временной диапазон для поиска таймслотов истёк.',
        };
      }

      const timeslot = await this.pickTimeslot(task, credentials, window, abortSignal);

      if (!timeslot) {
        return { task, event: { type: OzonSupplyEventType.TimeslotMissing }, message: 'Свободных таймслотов нет' };
      }

      task.selectedTimeslot = timeslot;

      const operationId = await this.ozonApi.createSupply(
        {
          draftId: task.draftId,
          warehouseId: task.warehouseId!,
          timeslot,
        },
        credentials,
        abortSignal,
      );

      if (operationId) {
        task.orderFlag = 1;
        const messageParts = [`Создана поставка, operation_id=${operationId}`];
        if (warehouseChanged) {
          messageParts.push(`выбран склад ${selectedWarehouseId}`);
        }
        return {
          task,
          event: { type: OzonSupplyEventType.SupplyCreated },
          message: messageParts.join(', '),
          operationId,
        };
      }

      return { task, event: { type: OzonSupplyEventType.Error }, message: 'Ответ без operation_id при создании поставки' };
    }

    if (info.code === 5) {
      task.draftOperationId = '';
      task.draftId = 0;
      return { task, event: { type: OzonSupplyEventType.DraftExpired }, message: 'Черновик устарел, создадим заново' };
    }

    if (info.code === 1) {
      task.draftOperationId = '';
      task.draftId = 0;
      return { task, event: { type: OzonSupplyEventType.DraftInvalid }, message: 'Черновик невалидный' };
    }

    return {
      task,
      event: { type: OzonSupplyEventType.DraftError },
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
    const ozonItems = await this.buildOzonItems(task, credentials);
    this.ensureNotAborted(abortSignal);
    await this.throttleDraftRequests(credentials, abortSignal);

    const operationId = await this.ozonApi.createDraft(
      {
        clusterIds: [task.clusterId!],
        dropOffPointWarehouseId: dropOffWarehouseId,
        items: ozonItems,
        type: 'CREATE_TYPE_CROSSDOCK',
      },
      credentials,
      abortSignal,
    );
    this.ensureNotAborted(abortSignal);

    if (!operationId) {
      return { task, event: { type: OzonSupplyEventType.Error }, message: 'Черновик не создан: пустой operation_id' };
    }

    task.draftOperationId = operationId;

    return { task, event: { type: OzonSupplyEventType.DraftCreated }, message: `Создан черновик ${operationId}` };
  }

  private async pickTimeslot(
    task: OzonSupplyTask,
    credentials: OzonCredentials,
    window: { dateFromIso: string; dateToIso: string },
    abortSignal?: AbortSignal,
  ): Promise<OzonDraftTimeslot | undefined> {
    if (task.selectedTimeslot) {
      return task.selectedTimeslot;
    }

    if (!task.draftId) {
      return undefined;
    }

    const response = await this.ozonApi.getDraftTimeslots(
      {
        draftId: task.draftId,
        warehouseIds: [task.warehouseId!],
        dateFrom: window.dateFromIso,
        dateTo: window.dateToIso,
      },
      credentials,
      abortSignal,
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
    options: { strict?: boolean } = {},
  ): { warehouseId: number; name?: string } | undefined {
    const warehouses = this.collectDraftWarehouses(info);
    if (!warehouses.length) {
      return undefined;
    }

    const strict = options.strict === true;

    if (typeof preferredWarehouseId === 'number') {
      const match = warehouses.find((entry) => entry.warehouseId === preferredWarehouseId);
      if (match) {
        if (!match.isFullyAvailable) {
          return undefined;
        }
        return { warehouseId: match.warehouseId, name: match.name ?? preferredWarehouseName };
      }
      if (strict) {
        return undefined;
      }
    }

    const firstAvailable = warehouses.find((entry) => entry.isFullyAvailable);
    if (firstAvailable) {
      return { warehouseId: firstAvailable.warehouseId, name: firstAvailable.name ?? preferredWarehouseName };
    }

    return undefined;
  }

  private collectDraftWarehouses(
    info: OzonDraftStatus,
  ): Array<{ warehouseId: number; name?: string; isFullyAvailable?: boolean }> {
    const result: Array<{ warehouseId: number; name?: string; isFullyAvailable?: boolean }> = [];
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
        const state = warehouseInfo?.status?.state;
        const isFullyAvailable = state === 'WAREHOUSE_SCORING_STATUS_FULL_AVAILABLE';
        result.push({ warehouseId, name, isFullyAvailable });
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

  private computeTimeslotUpperBound(): string {
    return toOzonIso(this.computeTimeslotUpperBoundDate());
  }

  private computeTimeslotUpperBoundDate(): Date {
    const upper = addUtcDays(new Date(), this.timeslotWindowMaxDays);
    return endOfUtcDay(upper);
  }

  private computeTimeslotWindow(task: OzonSupplyTask): { dateFromIso: string; dateToIso: string; expired: boolean } {
    const readyInDays = this.resolveReadyInDays(task);
    const from = startOfUtcDay(addUtcDays(new Date(), readyInDays));

    const deadline = parseIsoDate(task.lastDay) ?? this.computeTimeslotUpperBoundDate();
    const to = new Date(deadline.getTime());

    const expired = from.getTime() > to.getTime();

    return {
      dateFromIso: toOzonIso(from),
      dateToIso: toOzonIso(to),
      expired,
    };
  }

  private resolveReadyInDays(task: OzonSupplyTask): number {
    const direct = this.normalizeReadyInDays(task.readyInDays);
    if (direct !== undefined) {
      return direct;
    }

    const fallback = this.normalizeReadyInDays(this.estimateReadyInDaysFromLastDay(task.lastDay));
    if (fallback !== undefined) {
      return fallback;
    }

    return 2;
  }

  private normalizeReadyInDays(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined;
    }
    const rounded = Math.floor(value);
    if (rounded <= 0) {
      return 0;
    }
    if (rounded >= this.timeslotWindowMaxDays) {
      return this.timeslotWindowMaxDays;
    }
    return rounded;
  }

  private estimateReadyInDaysFromLastDay(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }

    const baseline = startOfUtcDay(new Date());
    const diffMs = parsed.getTime() - baseline.getTime();
    if (!Number.isFinite(diffMs)) {
      return undefined;
    }

    const diffDays = Math.ceil(diffMs / this.dayMs);
    if (!Number.isFinite(diffDays)) {
      return undefined;
    }

    return diffDays;
  }

  private getDraftThrottleKey(credentials?: OzonCredentials): string {
    const raw = credentials?.clientId?.trim();
    return raw && raw.length ? raw : 'default';
  }

  private async throttleDraftRequests(credentials: OzonCredentials | undefined, abortSignal?: AbortSignal): Promise<void> {
    const key = this.getDraftThrottleKey(credentials);
    while (true) {
      this.ensureNotAborted(abortSignal);
      const now = Date.now();
      const entry = this.draftRequestHistory.get(key) ?? { minute: [], hour: [] };

      entry.minute = entry.minute.filter((ts) => now - ts < this.draftMinuteWindowMs);
      entry.hour = entry.hour.filter((ts) => now - ts < this.draftHourWindowMs);

      const minuteExceeded = entry.minute.length >= this.draftMinuteLimit;
      const hourExceeded = entry.hour.length >= this.draftHourLimit;

      const sinceLast = typeof entry.lastTs === 'number' ? now - entry.lastTs : Infinity;
      const secondExceeded = sinceLast < this.draftSecondIntervalMs;

      if (!minuteExceeded && !hourExceeded && !secondExceeded) {
        entry.minute.push(now);
        entry.hour.push(now);
        entry.lastTs = now;
        this.draftRequestHistory.set(key, entry);
        return;
      }

      const waitCandidates: number[] = [];
      if (minuteExceeded && entry.minute.length) {
        waitCandidates.push(entry.minute[0] + this.draftMinuteWindowMs);
      }
      if (hourExceeded && entry.hour.length) {
        waitCandidates.push(entry.hour[0] + this.draftHourWindowMs);
      }
      if (secondExceeded && typeof entry.lastTs === 'number') {
        waitCandidates.push(entry.lastTs + this.draftSecondIntervalMs);
      }

      if (!waitCandidates.length) {
        entry.minute = [];
        entry.hour = [];
        this.draftRequestHistory.set(key, entry);
        continue;
      }

      const waitUntil = Math.min(...waitCandidates);
      const delay = Math.max(waitUntil - now, 250);
      this.logger.debug(
        `Draft request throttled for ${delay}ms (key=${key}, minute=${entry.minute.length}/${this.draftMinuteLimit}, hour=${entry.hour.length}/${this.draftHourLimit})`,
      );
      await this.sleep(delay, abortSignal);
    }
  }

  private cloneTask(task: OzonSupplyTask): OzonSupplyTask {
    return {
      ...task,
      items: task.items.map((item) => ({ ...item })),
    };
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
