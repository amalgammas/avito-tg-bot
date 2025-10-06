import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  OzonApiService,
  OzonCredentials,
  OzonDraftTimeslot,
  OzonCluster,
} from '../config/ozon-api.service';
import {
  OzonSupplyProcessOptions,
  OzonSupplyProcessResult,
  OzonSupplyTask,
  OzonSupplyTaskMap,
} from './ozon-supply.types';
import { OzonSheetService } from './ozon-sheet.service';

interface PrepareTasksOptions {
  credentials?: OzonCredentials;
  spreadsheet?: string;
}

@Injectable()
export class OzonSupplyService {
  private readonly logger = new Logger(OzonSupplyService.name);
  private readonly dropOffPointWarehouseId: string;
  private readonly defaultSpreadsheetId: string;
  private readonly pollIntervalMs: number;
  private readonly draftTtlMs = 55 * 60 * 1000; // 55 минут
  private readonly draftCache = new Map<
    string,
    { operationId: string; draftId?: number; expiresAt: number }
  >();
  private lastClusters: OzonCluster[] = [];

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

  async prepareTasks(options: PrepareTasksOptions = {}): Promise<OzonSupplyTaskMap> {
    const credentials = options.credentials;
    const tasks = await this.sheetService.loadTasks(options.spreadsheet);
    const clusters = await this.ozonApi.listClusters({}, credentials);
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

    while (taskMap.size) {
      for (const [taskId, state] of Array.from(taskMap.entries())) {
        try {
          const result = await this.processSingleTask(state, credentials);
          await options.onEvent?.({ task: state, event: result.event, message: result.message });

          if (state.orderFlag === 1) {
            this.logger.log(`[${taskId}] Поставка создана, удаляем из очереди`);
            taskMap.delete(taskId);
            continue;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[${taskId}] Ошибка обработки: ${message}`);
          await options.onEvent?.({ task: state, event: 'error', message });
        }

        await this.sleep(delayBetweenCalls);
      }
    }
  }

  getPollIntervalMs(): number {
    return this.pollIntervalMs;
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
    credentials?: OzonCredentials,
  ): Promise<OzonSupplyProcessResult> {
    if (!credentials && !this.ozonApiDefaultCredentialsAvailable()) {
      return { task, event: 'noCredentials', message: 'Не заданы ключи Ozon' };
    }

    if (!task.clusterId) {
      return { task, event: 'error', message: 'Не удалось определить cluster_id' };
    }

    if (!task.warehouseId) {
      return { task, event: 'error', message: 'Не удалось определить warehouse_id' };
    }

    const creds = credentials ?? this.ozonApiDefaultCredentials();

    if (task.draftOperationId) {
      return this.handleExistingDraft(task, creds);
    }

    return this.createDraft(task, creds);
  }

  hasDefaultSpreadsheet(): boolean {
    return Boolean(this.defaultSpreadsheetId);
  }

  private async handleExistingDraft(
    task: OzonSupplyTask,
    credentials: OzonCredentials,
  ): Promise<OzonSupplyProcessResult> {
    const info = await this.ozonApi.getDraftInfo(task.draftOperationId, credentials);

    if (info.status === 'CALCULATION_STATUS_SUCCESS') {
      task.draftId = info.draft_id ?? task.draftId;
      this.rememberDraft(task, info.draft_id ?? task.draftId);
      const timeslot = await this.pickTimeslot(task, credentials);

      if (!timeslot) {
        return { task, event: 'timeslotMissing', message: 'Свободных таймслотов нет' };
      }

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
        return {
          task,
          event: 'supplyCreated',
          message: `Создана поставка, operation_id=${operationId}`,
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
  ): Promise<OzonSupplyProcessResult> {
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

    const operationId = await this.ozonApi.createDraft(
      {
        clusterIds: [task.clusterId!],
        dropOffPointWarehouseId: this.dropOffPointWarehouseId,
        items: task.items,
        type: 'CREATE_TYPE_CROSSDOCK',
      },
      credentials,
    );

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
  ): Promise<OzonDraftTimeslot | undefined> {
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
      .sort((a, b) => a.sku - b.sku)
      .map((item) => `${item.sku}:${item.quantity}`)
      .join('|');
    return `${task.clusterId ?? 'x'}-${task.warehouseId ?? 'x'}-${itemsHash}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
