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
  addMoscowDays,
  endOfMoscowDay,
  parseIsoDate,
  startOfMoscowDay,
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
  private readonly timeslotRetryDelayMs = 5_000;
  private readonly dayMs = 24 * 60 * 60 * 1000;
  private readonly draftMinuteLimit = 2;
  private readonly draftHourLimit = 50;
  private readonly draftSecondIntervalMs = 30_000;
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

  private resolveSupplyType(task: OzonSupplyTask): 'CREATE_TYPE_CROSSDOCK' | 'CREATE_TYPE_DIRECT' {
    return task.supplyType === 'CREATE_TYPE_DIRECT' ? 'CREATE_TYPE_DIRECT' : 'CREATE_TYPE_CROSSDOCK';
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
      task.supplyType = task.supplyType ?? 'CREATE_TYPE_CROSSDOCK';
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
    const abortSignal = options.abortSignal;
    let runtimeCredentials = options.credentials;

    this.ensureNotAborted(abortSignal);

    const requiresDropOff = Array.from(taskMap.values()).some(
      (task) => this.resolveSupplyType(task) === 'CREATE_TYPE_CROSSDOCK',
    );
    const dropOffWarehouseId = requiresDropOff ? options.dropOffWarehouseId ?? this.getDefaultDropOffId() : undefined;

    if (requiresDropOff) {
      if (!dropOffWarehouseId) {
        throw new Error('Пункт сдачи (drop-off) не задан. Укажите его в мастере или через OZON_SUPPLY_DROP_OFF_ID.');
      }
      if (!options.skipDropOffValidation) {
        await this.ensureDropOffWarehouseAvailable(dropOffWarehouseId, runtimeCredentials, abortSignal);
      }
    }
    const seenUnavailableWarehouses = new Set<number>();

    const handleProcessResult = async (state: OzonSupplyTask, result: OzonSupplyProcessResult, credentials: OzonCredentials | undefined): Promise<boolean> => {
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
        return true;
      }
      return false;
    };

    while (taskMap.size) {
      this.ensureNotAborted(abortSignal);

      for (const [taskId, state] of Array.from(taskMap.entries())) {
        this.ensureNotAborted(abortSignal);
        try {
          const result = await this.processSingleTask(state, runtimeCredentials, dropOffWarehouseId, abortSignal);
          const shouldRemoveTask = await handleProcessResult(state, result, runtimeCredentials);
          if (shouldRemoveTask) {
            this.logger.log(`[${taskId}] Поставка создана, удаляем из очереди`);
            taskMap.delete(taskId);
            continue;
          }
        } catch (error) {
          if (this.isMissingRoleError(error)) {
            const refreshedCredentials = await this.resolveCredentialsOnRoleError(options.getCredentials, runtimeCredentials);
            if (refreshedCredentials) {
              runtimeCredentials = refreshedCredentials;
              this.logger.warn(`[${taskId}] Обновили ключи после role error и повторяем попытку`);
              try {
                const retryResult = await this.processSingleTask(state, runtimeCredentials, dropOffWarehouseId, abortSignal);
                const shouldRemoveTask = await handleProcessResult(state, retryResult, runtimeCredentials);
                if (shouldRemoveTask) {
                  this.logger.log(`[${taskId}] Поставка создана, удаляем из очереди`);
                  taskMap.delete(taskId);
                  continue;
                }
                continue;
              } catch (retryError) {
                const retryMessage = this.describeProcessError(retryError);
                this.logger.error(`[${taskId}] Ошибка обработки после обновления ключей: ${retryMessage}`);
                await this.emitEvent(options.onEvent, {
                  task: state,
                  event: { type: OzonSupplyEventType.Error },
                  message: retryMessage,
                });
                continue;
              }
            } else {
              this.logger.warn(`[${taskId}] Role error detected, but no new credentials were found for retry`);
            }
          }
          const message = this.describeProcessError(error);
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

  private isMissingRoleError(error: unknown): boolean {
    const source = error as any;
    const status = source?.response?.status;
    const code = source?.response?.data?.code;
    const responseMessage = source?.response?.data?.message;
    const fallbackMessage = source?.message;
    const normalized = (
      (typeof responseMessage === 'string' ? responseMessage : undefined) ??
      (typeof fallbackMessage === 'string' ? fallbackMessage : '')
    ).toLowerCase();

    return status === 403 && (code === 7 || normalized.includes('missing a required role'));
  }

  private async resolveCredentialsOnRoleError(
    resolver: OzonSupplyProcessOptions['getCredentials'] | undefined,
    current: OzonCredentials | undefined,
  ): Promise<OzonCredentials | undefined> {
    if (!resolver) {
      return undefined;
    }

    try {
      const fresh = await resolver();
      if (fresh?.clientId && fresh?.apiKey && !this.isSameCredentials(current, fresh)) {
        return fresh;
      }
    } catch (error) {
      this.logger.warn(`getCredentials failed on role error: ${this.describeUnknownError(error)}`);
    }

    return undefined;
  }

  private isSameCredentials(
    left: OzonCredentials | undefined,
    right: OzonCredentials | undefined,
  ): boolean {
    if (!left || !right) {
      return false;
    }
    return left.clientId === right.clientId && left.apiKey === right.apiKey;
  }

  private describeProcessError(error: unknown): string {
    const source = error as any;
    const status = source?.response?.status;
    const code = source?.response?.data?.code;
    const responseMessage = source?.response?.data?.message;
    const fallback =
      typeof source?.message === 'string' && source.message.trim().length
        ? source.message.trim()
        : this.describeUnknownError(error);
    const detailParts: string[] = [];

    if (typeof status === 'number') {
      detailParts.push(`status=${status}`);
    }
    if (typeof code === 'number') {
      detailParts.push(`code=${code}`);
    }
    if (typeof responseMessage === 'string' && responseMessage.trim().length) {
      detailParts.push(responseMessage.trim());
    }

    if (!detailParts.length) {
      return fallback;
    }

    return `${fallback}; ${detailParts.join(', ')}`;
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
    const upperBound = this.computeTimeslotUpperBoundDate();
    const parsedDeadline = parseIsoDate(task.lastDay);
    const normalizedDeadline = parsedDeadline
      ? new Date(Math.min(parsedDeadline.getTime(), upperBound.getTime()))
      : upperBound;
    cloned.lastDay = toOzonIso(endOfMoscowDay(normalizedDeadline));
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
    dropOffWarehouseId: number | undefined,
    abortSignal?: AbortSignal,
  ): Promise<OzonSupplyProcessResult> {
    this.ensureNotAborted(abortSignal);

    if (!credentials && !this.ozonApiDefaultCredentialsAvailable()) {
      return { task, event: { type: OzonSupplyEventType.NoCredentials }, message: 'Не заданы ключи Ozon' };
    }

    if (!task.clusterId) {
      return { task, event: { type: OzonSupplyEventType.Error }, message: 'Не удалось определить cluster_id' };
    }

    const window = this.computeTimeslotWindow(task);
    if (window.expired) {
      task.orderFlag = 1;
      const message = window.preparationExpired
        ? 'Недостаточно времени на подготовку: крайняя дата раньше, чем выбранное время на готовность.'
        : 'Временной диапазон для поиска таймслотов истёк.';
      return { task, event: { type: OzonSupplyEventType.WindowExpired }, message };
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
    const strictWarehouse = task.warehouseAutoSelect === false && typeof task.warehouseId === 'number';

    if (strictWarehouse && task.strictWarehouseConfirmed && task.draftId) {
      const result = await this.tryCreateSupplyOnWarehouse(
        task,
        credentials,
        this.createDraftInfoStub(task),
        { warehouseId: task.warehouseId!, name: task.warehouseName },
        abortSignal,
      );
      if (result) {
        return result;
      }
      return { task, event: { type: OzonSupplyEventType.TimeslotMissing }, message: 'Свободных таймслотов нет' };
    }

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

    if (
      info.status === 'CALCULATION_STATUS_SUCCESS' ||
      info.status === 'CALCULATION_STATUS_SUCCEEDED' ||
      info.status === 'SUCCESS'
    ) {
      const infoMacro = this.extractMacrolocalClusterId(info);
      if (infoMacro) {
        task.macrolocalClusterId = infoMacro;
      }
      const warehouses = this.collectDraftWarehouses(info);

      if (!warehouses.length) {
        if (task.supplyType !== 'CREATE_TYPE_DIRECT') {
          const message = task.warehouseSelectionPendingNotified
            ? undefined
            : 'Черновик пока не содержит доступных складов. Ждём появления маршрута и обновления расчёта.';
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

      if (strictWarehouse) {
        const warehouseChoice = this.findWarehouseInCluster(
          info,
          task.warehouseId!,
          task.macrolocalClusterId ?? task.clusterId,
          task.warehouseName,
        );

        if (!warehouseChoice) {
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

        task.strictWarehouseConfirmed = true;
        const result = await this.tryCreateSupplyOnWarehouse(task, credentials, info, warehouseChoice, abortSignal);
        if (result) {
          return result;
        }

        return { task, event: { type: OzonSupplyEventType.TimeslotMissing }, message: 'Свободных таймслотов нет' };
      }

      const warehouseChoice = this.resolveWarehouseFromDraft(info, task.warehouseId, task.warehouseName);
      const prioritizedEntries = warehouseChoice
        ? [
            ...warehouses.filter((entry) => entry.warehouseId === warehouseChoice.warehouseId),
            ...warehouses.filter((entry) => entry.warehouseId !== warehouseChoice.warehouseId),
          ]
        : warehouses;

      const result = await this.tryWarehousesSequentially(
        task,
        credentials,
        info,
        prioritizedEntries,
        abortSignal,
      );

      if (result) {
        return result;
      }

      return { task, event: { type: OzonSupplyEventType.TimeslotMissing }, message: 'Свободных таймслотов нет' };
    }

    if (info.code === 5) {
      task.draftOperationId = '';
      task.draftId = 0;
      return { task, event: { type: OzonSupplyEventType.DraftExpired }, message: 'Черновик устарел, создадим заново' };
    }

    if (info.status === 'CALCULATION_STATUS_FAILED' || info.status === 'FAILED') {
      task.draftOperationId = '';
      task.draftId = 0;
      return {
        task,
        event: { type: OzonSupplyEventType.DraftInvalid },
        message: 'Черновик отклонён или отсутствует, создаём заново',
      };
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
    dropOffWarehouseId: number | undefined,
    abortSignal?: AbortSignal,
  ): Promise<OzonSupplyProcessResult> {
    this.ensureNotAborted(abortSignal);
    const ozonItems = await this.buildOzonItems(task, credentials);
    this.ensureNotAborted(abortSignal);
    await this.throttleDraftRequests(credentials, abortSignal);

    const supplyType = this.resolveSupplyType(task);
    if (supplyType === 'CREATE_TYPE_CROSSDOCK' && !dropOffWarehouseId) {
      return {
        task,
        event: { type: OzonSupplyEventType.Error },
        message: 'Пункт сдачи не выбран для кросс-докинг поставки',
      };
    }
    const operationId = await this.ozonApi.createDraft(
      {
        clusterIds: [task.clusterId!],
        macrolocalClusterId: this.resolveMacrolocalClusterId(task.clusterId),
        items: ozonItems,
        ...(supplyType === 'CREATE_TYPE_CROSSDOCK' ? { dropOffPointWarehouseId: dropOffWarehouseId! } : {}),
        type: supplyType === 'CREATE_TYPE_DIRECT' ? 'DIRECT' : 'CROSSDOCK',
      },
      credentials,
      abortSignal,
    );
    this.ensureNotAborted(abortSignal);

    if (!operationId) {
      return { task, event: { type: OzonSupplyEventType.Error }, message: 'Черновик не создан: пустой operation_id' };
    }

    const resolvedMacro = this.resolveMacrolocalClusterId(task.clusterId);
    if (resolvedMacro) {
      task.macrolocalClusterId = resolvedMacro;
    }

    task.draftOperationId = operationId;
    const draftIdFromOperation = this.parseLocalDraftOperationId(operationId);
    if (draftIdFromOperation) {
      task.draftId = draftIdFromOperation;
    }

    return { task, event: { type: OzonSupplyEventType.DraftCreated }, message: `Создан черновик ${operationId}` };
  }

  private async pickTimeslot(
    task: OzonSupplyTask,
    credentials: OzonCredentials,
    window: { dateFromIso: string; dateToIso: string },
    abortSignal?: AbortSignal,
  ): Promise<OzonDraftTimeslot | undefined> {
    const fromHour = task.timeslotFirstAvailable ? undefined : task.timeslotFromHour;
    const toHour = task.timeslotFirstAvailable ? undefined : task.timeslotToHour;
    const windowFrom = parseIsoDate(window.dateFromIso);
    const windowTo = parseIsoDate(window.dateToIso);

    if (task.selectedTimeslot) {
      const fitsWindow = this.isTimeslotWithinWindow(task.selectedTimeslot, windowFrom, windowTo, {
        fromHour,
        toHour,
      });
      if (fitsWindow) {
        return task.selectedTimeslot;
      }
      this.logger.warn(
        `[timeslotWindow] preset timeslot is outside allowed window, ignoring (task=${task.taskId ?? 'n/a'}) slot=${this.describeTimeslotForLog(task.selectedTimeslot)}`,
      );
      task.selectedTimeslot = undefined;
    }

    if (!task.draftId) {
      return undefined;
    }

    let response: ReturnType<OzonApiService['getDraftTimeslots']> extends Promise<infer R> ? R : never;
    const requestDateFrom = this.toOzonDate(window.dateFromIso);
    const requestDateTo = this.toOzonDate(window.dateToIso);
    const requestWarehouseIds =
      typeof task.warehouseId === 'number' && task.warehouseId > 0 ? [task.warehouseId] : [];
    try {
      response = await this.ozonApi.getDraftTimeslots(
        {
          draftId: task.draftId,
          warehouseIds: requestWarehouseIds,
          dateFrom: requestDateFrom,
          dateTo: requestDateTo,
          supplyType: task.supplyType === 'CREATE_TYPE_DIRECT' ? 'DIRECT' : 'CROSSDOCK',
          ...this.buildSelectedClusterWarehouses(task),
        },
        credentials,
        abortSignal,
      );
    } catch (error) {
      const axiosError = error as AxiosError<any>;
      const status = axiosError?.response?.status;
      const code = (axiosError?.response?.data as any)?.code;
      if (status === 404 && code === 5) {
        task.draftId = 0;
        task.draftOperationId = '';
        throw this.createDraftExpiredError();
      }
      throw error;
    }
    this.ensureNotAborted(abortSignal);
    this.logTimeslotResponseSummary(task, response, requestDateFrom, requestDateTo);

    for (const warehouse of response.drop_off_warehouse_timeslots ?? []) {
      for (const day of warehouse.days ?? []) {
        for (const slot of day.timeslots ?? []) {
          if (slot.from_in_timezone && slot.to_in_timezone) {
            const fitsWindow = this.isTimeslotWithinWindow(slot, windowFrom, windowTo, {
              fromHour,
              toHour,
            });
            if (!fitsWindow) {
              this.logger.debug(
                `[timeslotWindow] skip slot outside window (task=${task.taskId ?? 'n/a'} warehouse=${task.warehouseId ?? 'n/a'}) slot=${this.describeTimeslotForLog(slot)}`,
              );
              continue;
            }
            return slot;
          }
        }
      }
    }

    return undefined;
  }

  private logTimeslotResponseSummary(
    task: OzonSupplyTask,
    response: ReturnType<OzonApiService['getDraftTimeslots']> extends Promise<infer R> ? R : never,
    dateFromIso: string,
    dateToIso: string,
  ): void {
    let dayCount = 0;
    let slotCount = 0;
    let firstSlot: OzonDraftTimeslot | undefined;

    for (const warehouse of response.drop_off_warehouse_timeslots ?? []) {
      for (const day of warehouse.days ?? []) {
        dayCount += 1;
        for (const slot of day.timeslots ?? []) {
          slotCount += 1;
          if (!firstSlot && slot?.from_in_timezone && slot?.to_in_timezone) {
            firstSlot = slot;
          }
        }
      }
    }

    this.logger.debug(
      `[timeslot] task=${task.taskId ?? 'n/a'} draftId=${task.draftId ?? 0} supplyType=${
        task.supplyType === 'CREATE_TYPE_DIRECT' ? 'DIRECT' : 'CROSSDOCK'
      } warehouse=${task.warehouseId ?? 'n/a'} range=${dateFromIso}..${dateToIso} days=${dayCount} slots=${slotCount} first=${
        firstSlot ? `${firstSlot.from_in_timezone}..${firstSlot.to_in_timezone}` : 'none'
      }`,
    );
  }

  private toOzonDate(value: string): string {
    const parsed = parseIsoDate(value);
    if (!parsed) {
      return value.split('T')[0] ?? value;
    }
    return parsed.toISOString().slice(0, 10);
  }

  private createDraftExpiredError(): Error {
    const error = new Error('DraftExpired');
    error.name = 'DraftExpired';
    return error;
  }

  private isDraftExpiredError(error: unknown): boolean {
    return error instanceof Error && error.name === 'DraftExpired';
  }

  private createDraftInfoStub(task: OzonSupplyTask): OzonDraftStatus {
    return {
      status: 'SUCCESS',
      draft_id: task.draftId,
      clusters: [],
    };
  }

  private findWarehouseInCluster(
    info: OzonDraftStatus,
    warehouseId: number,
    clusterId: string | number | undefined,
    preferredName?: string,
  ): { warehouseId: number; name?: string; state?: string; isFullyAvailable?: boolean } | undefined {
    if (!warehouseId) {
      return undefined;
    }

    const targetClusterId = this.parseClusterId(clusterId);

    for (const cluster of info.clusters ?? []) {
      const currentClusterId = this.parseClusterId(cluster.cluster_id ?? (cluster as any).macrolocal_cluster_id);
      if (targetClusterId !== undefined && currentClusterId !== targetClusterId) {
        continue;
      }

      for (const warehouseInfo of cluster.warehouses ?? []) {
        const parsedId = this.parseWarehouseId(
          warehouseInfo?.supply_warehouse?.warehouse_id ??
            warehouseInfo?.storage_warehouse?.warehouse_id ??
            (warehouseInfo as any)?.warehouse_id,
        );
        if (parsedId !== warehouseId) {
          continue;
        }

        const name =
          warehouseInfo?.supply_warehouse?.name?.trim() ??
          warehouseInfo?.storage_warehouse?.name?.trim() ??
          preferredName;
        const state = warehouseInfo?.status?.state ?? warehouseInfo?.availability_status?.state;
        const isFullyAvailable =
          state === 'WAREHOUSE_SCORING_STATUS_FULL_AVAILABLE' ||
          state === 'FULL_AVAILABLE';
        return { warehouseId: parsedId, name, state, isFullyAvailable };
      }
    }

    return undefined;
  }

  private resolveWarehouseFromDraft(
    info: OzonDraftStatus,
    preferredWarehouseId: number | undefined,
    preferredWarehouseName: string | undefined,
    options: { strict?: boolean } = {},
  ): { warehouseId: number; name?: string; state?: string; isFullyAvailable?: boolean } | undefined {
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
        return {
          warehouseId: match.warehouseId,
          name: match.name ?? preferredWarehouseName,
          state: match.state,
          isFullyAvailable: match.isFullyAvailable,
        };
      }
      if (strict) {
        return undefined;
      }
    }

    const firstAvailable = warehouses.find((entry) => entry.isFullyAvailable);
    if (firstAvailable) {
      return {
        warehouseId: firstAvailable.warehouseId,
        name: firstAvailable.name ?? preferredWarehouseName,
        state: firstAvailable.state,
        isFullyAvailable: firstAvailable.isFullyAvailable,
      };
    }

    return undefined;
  }

  private parseClusterId(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.round(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.round(parsed);
      }
    }
    return undefined;
  }

  private async tryWarehousesSequentially(
    task: OzonSupplyTask,
    credentials: OzonCredentials,
    info: OzonDraftStatus,
    entries: Array<{ warehouseId: number; name?: string; state?: string; isFullyAvailable?: boolean }>,
    abortSignal?: AbortSignal,
  ): Promise<OzonSupplyProcessResult | undefined> {
    const availableEntries = entries.filter((entry) => entry.isFullyAvailable);
    if (!availableEntries.length) {
      task.warehouseSelectionPendingNotified = true;
      return {
        task,
        event: { type: OzonSupplyEventType.WarehousePending },
        message: 'Черновик не содержит складов со статусом FULL_AVAILABLE. Ждём обновления.',
      };
    }

    while (true) {
      for (const entry of availableEntries) {
        this.ensureNotAborted(abortSignal);
        const result = await this.tryCreateSupplyOnWarehouse(task, credentials, info, entry, abortSignal);
        if (result) {
          return result;
        }
      }
      this.ensureNotAborted(abortSignal);
      await this.sleep(this.timeslotRetryDelayMs, abortSignal);
    }
  }

  private async tryCreateSupplyOnWarehouse(
    task: OzonSupplyTask,
    credentials: OzonCredentials,
    info: OzonDraftStatus,
    entry: { warehouseId: number; name?: string; state?: string; isFullyAvailable?: boolean },
    abortSignal?: AbortSignal,
  ): Promise<OzonSupplyProcessResult | undefined> {
    if (entry.isFullyAvailable !== true) {
      const message = task.warehouseAutoSelect === false
        ? `Ждём склад ${entry.warehouseId}. Ozon вернул статус ${entry.state ?? 'n/a'}, нужен FULL_AVAILABLE.`
        : undefined;
      task.warehouseSelectionPendingNotified = true;
      return {
        task,
        event: { type: OzonSupplyEventType.WarehousePending },
        message,
      };
    }

    const previousWarehouseId = typeof task.warehouseId === 'number' ? task.warehouseId : undefined;
    const previousWarehouseName = task.warehouseName;
    const selectedWarehouseId = entry.warehouseId;
    const selectedWarehouseName = entry.name ?? task.warehouseName;
    const warehouseChanged =
      typeof previousWarehouseId === 'number' && previousWarehouseId !== selectedWarehouseId;

    task.warehouseId = selectedWarehouseId;
    task.warehouseName = selectedWarehouseName;
    task.draftId = info.draft_id ?? task.draftId;
    this.ensureNotAborted(abortSignal);

    const window = this.computeTimeslotWindow(task);
    if (window.expired) {
      task.orderFlag = 1;
      const message = window.preparationExpired
        ? 'Недостаточно времени на подготовку: крайняя дата раньше, чем выбранное время на готовность.'
        : 'Временной диапазон для поиска таймслотов истёк.';
      return {
        task,
        event: { type: OzonSupplyEventType.WindowExpired },
        message,
      };
    }

    let timeslot: OzonDraftTimeslot | undefined;
    try {
      timeslot = await this.pickTimeslot(task, credentials, window, abortSignal);
    } catch (error) {
      if (this.isDraftExpiredError(error)) {
        task.draftId = 0;
        task.draftOperationId = '';
        return {
          task,
          event: { type: OzonSupplyEventType.DraftExpired },
          message: 'Черновик не найден, создаём заново',
        };
      }
      throw error;
    }

    if (!timeslot) {
      task.warehouseId = previousWarehouseId;
      task.warehouseName = previousWarehouseName;
      return undefined;
    }

    task.selectedTimeslot = timeslot;
    task.warehouseSelectionPendingNotified = false;
    const createSupplySelection = this.buildSelectedClusterWarehouses(task).selectedClusterWarehouses;
    if (!createSupplySelection?.length) {
      return {
        task,
        event: { type: OzonSupplyEventType.Error },
        message: 'Не удалось определить selected_cluster_warehouses для создания поставки',
      };
    }

    const operationId = await this.ozonApi.createSupply(
      {
        draftId: task.draftId,
        selectedClusterWarehouses: createSupplySelection,
        timeslot,
        supplyType: task.supplyType === 'CREATE_TYPE_DIRECT' ? 'DIRECT' : 'CROSSDOCK',
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

  private collectDraftWarehouses(
    info: OzonDraftStatus,
  ): Array<{ warehouseId: number; name?: string; state?: string; isFullyAvailable?: boolean }> {
    const result: Array<{ warehouseId: number; name?: string; state?: string; isFullyAvailable?: boolean }> = [];
    for (const cluster of info.clusters ?? []) {
      for (const warehouseInfo of cluster.warehouses ?? []) {
        const rawId =
          warehouseInfo?.supply_warehouse?.warehouse_id ??
          warehouseInfo?.storage_warehouse?.warehouse_id ??
          (warehouseInfo as any)?.warehouse_id ??
          undefined;
        const warehouseId = this.parseWarehouseId(rawId);
        if (!warehouseId) {
          continue;
        }
        const name =
          warehouseInfo?.supply_warehouse?.name?.trim() ??
          warehouseInfo?.storage_warehouse?.name?.trim();
        const state = warehouseInfo?.status?.state ?? warehouseInfo?.availability_status?.state;
        const isFullyAvailable =
          state === 'WAREHOUSE_SCORING_STATUS_FULL_AVAILABLE' ||
          state === 'FULL_AVAILABLE';
        result.push({ warehouseId, name, state, isFullyAvailable });
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

  private extractHourFromIso(value?: string): number | undefined {
    if (!value) {
      return undefined;
    }
    const match = value.match(/T(\d{2}):(\d{2})/);
    if (!match) {
      return undefined;
    }
    const hour = Number(match[1]);
    return Number.isFinite(hour) ? hour : undefined;
  }

  private isTimeslotInHourRange(hour: number | undefined, fromHour?: number, toHour?: number): boolean {
    if (typeof hour !== 'number') {
      return true;
    }
    if (typeof fromHour === 'number' && hour < fromHour) {
      return false;
    }
    if (typeof toHour === 'number' && hour > toHour) {
      return false;
    }
    return true;
  }

  private isTimeslotWithinWindow(
    slot: OzonDraftTimeslot | undefined,
    windowFrom: Date | undefined,
    windowTo: Date | undefined,
    options: { fromHour?: number; toHour?: number },
  ): boolean {
    if (!slot?.from_in_timezone || !slot?.to_in_timezone || !windowFrom || !windowTo) {
      return false;
    }

    const fromDate = parseIsoDate(slot.from_in_timezone);
    const toDate = parseIsoDate(slot.to_in_timezone);
    if (!fromDate || !toDate) {
      return false;
    }

    const slotHour = this.extractHourFromIso(slot.from_in_timezone);
    if (!this.isTimeslotInHourRange(slotHour, options.fromHour, options.toHour)) {
      return false;
    }

    const fromMs = fromDate.getTime();
    const toMs = toDate.getTime();
    return fromMs >= windowFrom.getTime() && toMs <= windowTo.getTime();
  }

  private describeTimeslotForLog(slot: OzonDraftTimeslot | undefined): string {
    if (!slot?.from_in_timezone || !slot?.to_in_timezone) {
      return 'n/a';
    }
    return `${slot.from_in_timezone}..${slot.to_in_timezone}`;
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

  private computeTimeslotUpperBoundDate(): Date {
    const upper = addMoscowDays(new Date(), this.timeslotWindowMaxDays);
    return endOfMoscowDay(upper);
  }

  private computeTimeslotWindow(task: OzonSupplyTask): {
    dateFromIso: string;
    dateToIso: string;
    expired: boolean;
    preparationExpired: boolean;
  } {
    const readyInDays = this.resolveReadyInDays(task);
    const from = addMoscowDays(new Date(), readyInDays);

    const upperBound = this.computeTimeslotUpperBoundDate();
    const parsedDeadline = parseIsoDate(task.lastDay);
    const deadline = parsedDeadline ? new Date(Math.min(parsedDeadline.getTime(), upperBound.getTime())) : upperBound;
    const to = endOfMoscowDay(deadline);

    const preparationThreshold = endOfMoscowDay(addMoscowDays(startOfMoscowDay(deadline), -readyInDays));
    const preparationExpired = Date.now() > preparationThreshold.getTime();
    const expired = preparationExpired || from.getTime() > to.getTime();

    const window = {
      dateFromIso: toOzonIso(from),
      dateToIso: toOzonIso(to),
      expired,
      preparationExpired,
    };

    this.logger.debug(
      `[timeslotWindow] task=${task.taskId ?? 'n/a'} readyInDays=${readyInDays} lastDay=${task.lastDay ?? 'n/a'} from=${window.dateFromIso} to=${window.dateToIso} expired=${expired} prepExpired=${preparationExpired}`,
    );

    return window;
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

    return 1;
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

    const baseline = startOfMoscowDay(new Date());
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
      selectedTimeslot: task.selectedTimeslot ? { ...task.selectedTimeslot } : undefined,
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

  private resolveMacrolocalClusterId(clusterId: string | number | undefined): number | undefined {
    if (typeof clusterId !== 'number' || !Number.isFinite(clusterId) || clusterId <= 0) {
      return undefined;
    }

    const cluster = this.lastClusters.find((entry) => entry.id === clusterId);
    const macrolocal = cluster?.macrolocal_cluster_id;
    if (typeof macrolocal === 'number' && Number.isFinite(macrolocal) && macrolocal > 0) {
      return Math.trunc(macrolocal);
    }

    return undefined;
  }

  private extractMacrolocalClusterId(info: OzonDraftStatus): number | undefined {
    for (const cluster of info.clusters ?? []) {
      const raw = (cluster as any)?.macrolocal_cluster_id;
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return Math.trunc(raw);
      }
      if (typeof raw === 'string') {
        const parsed = Number(raw.trim());
        if (Number.isFinite(parsed) && parsed > 0) {
          return Math.trunc(parsed);
        }
      }
    }
    return undefined;
  }

  private parseLocalDraftOperationId(operationId: string | undefined): number | undefined {
    if (!operationId) {
      return undefined;
    }
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

  private buildSelectedClusterWarehouses(task: OzonSupplyTask): { selectedClusterWarehouses?: Array<{ macrolocal_cluster_id: number; storage_warehouse_id: number }> } {
    const macrolocalClusterId = task.macrolocalClusterId ?? this.resolveMacrolocalClusterId(task.clusterId);
    const warehouseId =
      typeof task.warehouseId === 'number' && task.warehouseId > 0
        ? task.warehouseId
        : task.supplyType === 'CREATE_TYPE_DIRECT'
        ? undefined
        : 0;

    if (!macrolocalClusterId || typeof warehouseId !== 'number' || warehouseId < 0) {
      return {};
    }

    return {
      selectedClusterWarehouses: [
        {
          macrolocal_cluster_id: macrolocalClusterId,
          storage_warehouse_id: warehouseId,
        },
      ],
    };
  }
}
