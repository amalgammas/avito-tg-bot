import { BadRequestException, Injectable } from '@nestjs/common';
import { addMoscowDays, endOfMoscowDay, startOfMoscowDay, toOzonIso } from '@bot/utils/time.utils';

import { WizardFlowService } from '../../bot/services/wizard-flow.service';
import { UserCredentialsStore } from '../../bot/user-credentials.store';
import { OzonSupplyService } from '../../ozon/ozon-supply.service';
import { SupplyProcessService } from '../../bot/services/supply-process.service';
import { SupplyProcessingCoordinatorService } from '../../bot/services/supply-processing-coordinator.service';
import { SupplyTaskAbortService } from '../../bot/services/supply-task-abort.service';
import { SupplyOrderStore } from '../../storage/supply-order.store';
import { OzonSupplyEventType } from '../../ozon/ozon-supply.types';
import type { WebSessionUser } from '../common/web-auth.types';
import type { SubmitWebDraftDto } from '../dto/submit-web-draft.dto';
import { WebWizardDraftStore } from '../drafts/web-wizard-draft.store';
import type {
  WebWizardClusterOption,
  WebWizardClusterType,
  WebWizardDraftPayload,
  WebWizardDropOffOption,
  WebWizardWarehouseOption,
} from '../drafts/web-wizard-draft.types';
import { WebTaskEmailService } from './web-task-email.service';

@Injectable()
export class WebWizardService {
  private readonly draftPollMaxAttempts = 15;
  private readonly draftPollDelayMs = 1_000;
  private readonly draftRecreateMaxAttempts = 1;
  private readonly draftInfoNetworkRetryAttempts = 3;

  constructor(
    private readonly credentialsStore: UserCredentialsStore,
    private readonly supplyService: OzonSupplyService,
    private readonly process: SupplyProcessService,
    private readonly wizardFlow: WizardFlowService,
    private readonly draftStore: WebWizardDraftStore,
    private readonly orderStore: SupplyOrderStore,
    private readonly processing: SupplyProcessingCoordinatorService,
    private readonly taskAbortService: SupplyTaskAbortService,
    private readonly webTaskEmail: WebTaskEmailService,
  ) {}

  async parseSpreadsheet(
    user: WebSessionUser,
    input: { spreadsheetUrl?: string; buffer?: Buffer; label?: string },
  ) {
    const actorId = `web:${user.id}`;
    const credentials = await this.credentialsStore.get(actorId);
    if (!credentials) {
      throw new BadRequestException('Сначала подключите Ozon ключи.');
    }

    if (!input.buffer && !input.spreadsheetUrl?.trim()) {
      throw new BadRequestException('Нужен .xlsx файл или ссылка на Google Sheets.');
    }

    const taskMap = await this.supplyService.prepareTasks({
      credentials,
      buffer: input.buffer,
      spreadsheet: input.spreadsheetUrl?.trim(),
    });

    const tasks = [...taskMap.values()];
    if (!tasks.length) {
      throw new BadRequestException('В документе не найдены товары.');
    }

    const task = {
      ...tasks[0],
      items: tasks[0].items.map((item) => ({ ...item })),
      selectedTimeslot: undefined,
      clusterId: undefined,
      warehouseId: undefined,
      draftId: tasks[0].draftId ?? 0,
      draftOperationId: tasks[0].draftOperationId ?? '',
      orderFlag: tasks[0].orderFlag ?? 0,
    };

    await this.process.resolveSkus(task, credentials);

    const draft = await this.draftStore.create(actorId, {
      stage: 'parsed',
      source: input.label ?? input.spreadsheetUrl ?? 'spreadsheet',
      task,
      supplyType: task.supplyType ?? 'CREATE_TYPE_CROSSDOCK',
      dropOffOptions: [],
      clusterOptions: [],
      warehouseOptions: [],
    });

    return this.toDraftResponse(draft);
  }

  async getDraft(user: WebSessionUser, draftId: string) {
    return this.toDraftResponse(await this.draftStore.get(`web:${user.id}`, draftId));
  }

  async updateSupplyType(user: WebSessionUser, draftId: string, supplyType: 'CREATE_TYPE_CROSSDOCK' | 'CREATE_TYPE_DIRECT') {
    const draft = await this.draftStore.update(`web:${user.id}`, draftId, (current) => ({
      ...current,
      supplyType,
      task: {
        ...current.task,
        supplyType,
      },
      stage: supplyType === 'CREATE_TYPE_DIRECT' ? 'clusterTypeSelect' : 'awaitDropOffQuery',
      clusterType: undefined,
      dropOffSearchQuery: undefined,
      dropOffOptions: [],
      clusterOptions: [],
      warehouseOptions: [],
      selectedDropOffId: undefined,
      selectedDropOffName: undefined,
      selectedClusterId: undefined,
      selectedClusterName: undefined,
      selectedWarehouseId: undefined,
      selectedWarehouseName: undefined,
      autoWarehouseSelection: false,
    }));

    return this.toDraftResponse(draft);
  }

  async searchDropOffs(user: WebSessionUser, draftId: string, queryRaw: string) {
    const actorId = `web:${user.id}`;
    const credentials = await this.requireCredentials(actorId);
    const query = queryRaw.trim();
    if (!query) {
      throw new BadRequestException('Введите запрос для поиска drop-off.');
    }

    const items = await this.wizardFlow.searchDropOffs(query, credentials);
    const options = items
      .map<WebWizardDropOffOption | undefined>((item) => {
        const warehouseId = Number(item.warehouse_id);
        if (!Number.isFinite(warehouseId)) {
          return undefined;
        }
        return {
          warehouseId,
          name: item.name?.trim() || `Пункт ${warehouseId}`,
          address: item.address?.trim() || undefined,
          type: item.warehouse_type?.trim() || undefined,
        };
      })
      .filter((item): item is WebWizardDropOffOption => Boolean(item))
      .slice(0, 10);

    const draft = await this.draftStore.update(actorId, draftId, (current) => ({
      ...current,
      stage: 'dropOffSelect',
      dropOffSearchQuery: query,
      dropOffOptions: options,
      selectedDropOffId: undefined,
      selectedDropOffName: undefined,
      clusterOptions: [],
      warehouseOptions: [],
      selectedClusterId: undefined,
      selectedClusterName: undefined,
      selectedWarehouseId: undefined,
      selectedWarehouseName: undefined,
      autoWarehouseSelection: false,
    }));

    return this.toDraftResponse(draft);
  }

  async selectDropOff(user: WebSessionUser, draftId: string, dropOffId: number) {
    const actorId = `web:${user.id}`;
    const draft = await this.draftStore.get(actorId, draftId);
    const option = draft.dropOffOptions.find((item) => item.warehouseId === Number(dropOffId));

    if (!option) {
      throw new BadRequestException('Выбранный drop-off не найден в текущем списке.');
    }

    const updated = await this.draftStore.update(actorId, draftId, (current) => ({
      ...current,
      selectedDropOffId: option.warehouseId,
      selectedDropOffName: option.name,
      clusterType: undefined,
      clusterOptions: [],
      warehouseOptions: [],
      selectedClusterId: undefined,
      selectedClusterName: undefined,
      selectedWarehouseId: undefined,
      selectedWarehouseName: undefined,
      autoWarehouseSelection: false,
      stage: 'clusterTypeSelect',
    }));

    return this.toDraftResponse(updated);
  }

  async updateClusterType(user: WebSessionUser, draftId: string, clusterType: WebWizardClusterType) {
    const actorId = `web:${user.id}`;
    const credentials = await this.requireCredentials(actorId);
    const response = await this.wizardFlow.listClusters({ clusterType }, credentials);
    const clusterOptions = this.mapClusters(response.clusters);

    const updated = await this.draftStore.update(actorId, draftId, (current) => ({
      ...current,
      clusterType,
      clusterOptions,
      warehouseOptions: [],
      selectedClusterId: undefined,
      selectedClusterName: undefined,
      selectedWarehouseId: undefined,
      selectedWarehouseName: undefined,
      autoWarehouseSelection: false,
      stage: 'clusterSelect',
    }));

    return this.toDraftResponse(updated);
  }

  async selectCluster(user: WebSessionUser, draftId: string, clusterId: number) {
    const actorId = `web:${user.id}`;
    const credentials = await this.requireCredentials(actorId);
    const draft = await this.draftStore.get(actorId, draftId);
    const clusterType = draft.clusterType ?? 'CLUSTER_TYPE_OZON';

    const response = await this.wizardFlow.listClusters(
      { clusterIds: [clusterId], clusterType },
      credentials,
    );

    const clusterOptions = this.mapClusters(response.clusters);
    const selectedCluster =
      clusterOptions.find((item) => item.id === Number(clusterId)) ??
      draft.clusterOptions.find((item) => item.id === Number(clusterId));

    if (!selectedCluster) {
      throw new BadRequestException('Кластер не найден.');
    }

    const warehouseOptions = this.mapWarehouses(response.clusters, selectedCluster.id);

    const updated = await this.draftStore.update(actorId, draftId, (current) => ({
      ...current,
      clusterType,
      clusterOptions: current.clusterOptions.length ? current.clusterOptions : clusterOptions,
      selectedClusterId: selectedCluster.id,
      selectedClusterName: selectedCluster.name,
      warehouseOptions,
      selectedWarehouseId: undefined,
      selectedWarehouseName: undefined,
      autoWarehouseSelection: false,
      stage: 'warehouseSelect',
      task: {
        ...current.task,
        clusterId: selectedCluster.id,
        macrolocalClusterId: selectedCluster.macrolocalClusterId,
        city: selectedCluster.name,
      },
    }));

    return this.toDraftResponse(updated);
  }

  async selectWarehouse(user: WebSessionUser, draftId: string, payload: { warehouseId?: number; autoSelect?: boolean }) {
    const actorId = `web:${user.id}`;
    const draft = await this.draftStore.get(actorId, draftId);

    const requestedAuto = payload.autoSelect === true;
    const warehouse = requestedAuto
      ? draft.warehouseOptions[0]
      : draft.warehouseOptions.find((item) => item.warehouseId === Number(payload.warehouseId));

    if (!warehouse) {
      throw new BadRequestException('Склад не найден.');
    }

    const updated = await this.draftStore.update(actorId, draftId, (current) => ({
      ...current,
      selectedWarehouseId: requestedAuto ? undefined : warehouse.warehouseId,
      selectedWarehouseName: requestedAuto ? undefined : warehouse.name,
      autoWarehouseSelection: requestedAuto,
      stage: 'readyDaysPending',
      readyInDays: undefined,
      lastDay: undefined,
      selectedTimeslotLabel: undefined,
      task: {
        ...current.task,
        warehouseId: requestedAuto ? undefined : warehouse.warehouseId,
        warehouseName: requestedAuto ? current.task.warehouseName : warehouse.name,
        warehouseAutoSelect: requestedAuto,
        selectedTimeslot: undefined,
      },
    }));

    return this.toDraftResponse(updated);
  }

  async submitDraft(user: WebSessionUser, draftId: string, body: SubmitWebDraftDto) {
    const actorId = `web:${user.id}`;
    const credentials = await this.requireCredentials(actorId);
    const draft = await this.draftStore.get(actorId, draftId);
    const readyInDays = this.normalizeReadyInDays(body.readyInDays);
    const lastDay = this.normalizeDeadlineInput(body.lastDay, readyInDays);
    const timeWindow = this.normalizeTimeslotWindow(body);
    const supplyType = draft.supplyType ?? 'CREATE_TYPE_CROSSDOCK';
    const requiresDropOff = supplyType === 'CREATE_TYPE_CROSSDOCK';
    const hasWarehouse = Boolean(draft.selectedWarehouseId) || draft.autoWarehouseSelection === true;

    if (!draft.selectedClusterId || !hasWarehouse || (requiresDropOff && !draft.selectedDropOffId)) {
      throw new BadRequestException('Мастер заполнен не полностью.');
    }

    let preparedDraft: WebWizardDraftPayload;
    try {
      preparedDraft = await this.prepareDraftAndTimeslot(
        actorId,
        draft,
        credentials,
        draft.selectedWarehouseId ?? undefined,
        readyInDays,
        lastDay,
      );
    } catch (error) {
      throw this.toPublicPreparationError(error);
    }

    const task = {
      ...preparedDraft.task,
      items: preparedDraft.task.items.map((item) => ({ ...item })),
      clusterId: preparedDraft.selectedClusterId,
      macrolocalClusterId: preparedDraft.task.macrolocalClusterId,
      city: preparedDraft.selectedClusterName ?? preparedDraft.task.city,
      warehouseId: preparedDraft.selectedWarehouseId ?? undefined,
      warehouseName: preparedDraft.autoWarehouseSelection
        ? preparedDraft.task.warehouseName
        : preparedDraft.selectedWarehouseName ?? preparedDraft.task.warehouseName,
      readyInDays,
      lastDay,
      supplyType,
      warehouseAutoSelect: preparedDraft.autoWarehouseSelection === true,
      warehouseSelectionPendingNotified: false,
      timeslotFirstAvailable: timeWindow.firstAvailable,
      timeslotFromHour: timeWindow.fromHour,
      timeslotToHour: timeWindow.toHour,
    };

    await this.orderStore.saveTask(actorId, {
      task,
      clusterId: preparedDraft.selectedClusterId!,
      clusterName: preparedDraft.selectedClusterName,
      warehouseId: preparedDraft.selectedWarehouseId ?? undefined,
      warehouseName: preparedDraft.autoWarehouseSelection ? 'Первый доступный склад' : preparedDraft.selectedWarehouseName ?? undefined,
      dropOffId: preparedDraft.selectedDropOffId ?? undefined,
      dropOffName: preparedDraft.selectedDropOffName ?? undefined,
      readyInDays,
      timeslotLabel: this.process.describeTimeslot(task.selectedTimeslot),
      warehouseAutoSelect: preparedDraft.autoWarehouseSelection === true,
      timeslotAutoSelect: true,
    });

    const updated = await this.draftStore.update(actorId, draftId, (current) => ({
      ...current,
      readyInDays,
      lastDay,
      stage: 'processingStarted',
      task,
    }));

    const abortController = new AbortController();
    this.taskAbortService.register(actorId, task.taskId, abortController);

    void this.processing.run({
      task,
      credentials,
      credentialsResolver: () => this.credentialsStore.get(actorId),
      readyInDays,
      dropOffWarehouseId: requiresDropOff ? preparedDraft.selectedDropOffId ?? undefined : undefined,
      abortController,
      callbacks: {
        onEvent: async (result) => {
          if (result.event?.type === OzonSupplyEventType.SupplyCreated) {
            await this.handleSupplyCreated(actorId, updated, result.operationId, result.task, credentials);
            return;
          }
          if (result.event?.type === OzonSupplyEventType.WindowExpired) {
            await this.orderStore.deleteByTaskId(actorId, task.taskId);
          }
        },
        onError: async (error) => {
          await this.orderStore.markFailedWithoutOrderId(actorId, task.draftOperationId, {
            status: 'failed_no_order_id',
            failureReason: 'web-processing-error',
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        },
        onFinally: async () => {
          this.taskAbortService.clear(task.taskId);
        },
      },
    });

    return this.toDraftResponse(updated);
  }

  private async requireCredentials(actorId: string) {
    const credentials = await this.credentialsStore.get(actorId);
    if (!credentials) {
      throw new BadRequestException('Сначала подключите Ozon ключи.');
    }
    return credentials;
  }

  private toDraftResponse(draft: WebWizardDraftPayload) {
    return {
      id: draft.id,
      stage: draft.stage,
      source: draft.source,
      supplyType: draft.supplyType ?? 'CREATE_TYPE_CROSSDOCK',
      clusterType: draft.clusterType ?? null,
      dropOffSearchQuery: draft.dropOffSearchQuery ?? null,
      dropOffOptions: draft.dropOffOptions,
      clusterOptions: draft.clusterOptions,
      warehouseOptions: draft.warehouseOptions,
      selectedDropOffId: draft.selectedDropOffId ?? null,
      selectedDropOffName: draft.selectedDropOffName ?? null,
      selectedClusterId: draft.selectedClusterId ?? null,
      selectedClusterName: draft.selectedClusterName ?? null,
      selectedWarehouseId: draft.selectedWarehouseId ?? null,
      selectedWarehouseName: draft.selectedWarehouseName ?? null,
      autoWarehouseSelection: draft.autoWarehouseSelection ?? false,
      readyInDays: draft.readyInDays ?? null,
      lastDay: draft.lastDay ?? null,
      selectedTimeslotLabel: draft.selectedTimeslotLabel ?? this.process.describeTimeslot(draft.task.selectedTimeslot) ?? null,
      task: {
        taskId: draft.task.taskId,
        supplyType: draft.task.supplyType ?? 'CREATE_TYPE_CROSSDOCK',
        items: draft.task.items,
        itemCount: draft.task.items.length,
        totalQuantity: draft.task.items.reduce((sum, item) => sum + item.quantity, 0),
      },
    };
  }

  private mapClusters(clusters: Array<any>): WebWizardClusterOption[] {
    return clusters
      .map<WebWizardClusterOption | undefined>((cluster) => {
        const id = Number(cluster?.id);
        if (!Number.isFinite(id)) {
          return undefined;
        }
        return {
          id,
          name: cluster?.name?.trim?.() || `Кластер ${id}`,
          macrolocalClusterId:
            typeof cluster?.macrolocal_cluster_id === 'number' && Number.isFinite(cluster.macrolocal_cluster_id)
              ? Math.trunc(cluster.macrolocal_cluster_id)
              : undefined,
        };
      })
      .filter((item): item is WebWizardClusterOption => Boolean(item))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru', { sensitivity: 'base' }));
  }

  private mapWarehouses(clusters: Array<any>, clusterId: number): WebWizardWarehouseOption[] {
    const target = clusters.find((item) => Number(item?.id) === Number(clusterId));
    if (!target) {
      return [];
    }

    const items: WebWizardWarehouseOption[] = [];
    for (const logistic of target.logistic_clusters ?? []) {
      for (const warehouse of logistic.warehouses ?? []) {
        const warehouseId = Number(warehouse?.warehouse_id);
        if (!Number.isFinite(warehouseId)) {
          continue;
        }
        items.push({
          warehouseId,
          name: warehouse?.name?.trim?.() || `Склад ${warehouseId}`,
        });
      }
    }

    const unique = new Map<number, WebWizardWarehouseOption>();
    for (const item of items) {
      if (!unique.has(item.warehouseId)) {
        unique.set(item.warehouseId, item);
      }
    }

    return [...unique.values()].sort((left, right) =>
      left.name.localeCompare(right.name, 'ru', { sensitivity: 'base' }),
    );
  }

  private normalizeReadyInDays(value: number): number {
    const numeric = Math.floor(Number(value));
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 28) {
      throw new BadRequestException('readyInDays должен быть числом от 0 до 28.');
    }
    return numeric;
  }

  private normalizeDeadlineInput(value: string, readyInDays: number): string {
    const normalizedText = value?.trim();
    if (!normalizedText) {
      throw new BadRequestException('Укажите крайнюю дату поиска слота.');
    }

    const parsed = normalizedText.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (parsed) {
      const [, year, month, day] = parsed;
      const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0));
      const normalized = this.normalizeDeadlineDate(candidate, readyInDays);
      if (normalized) {
        return normalized;
      }
    }

    const fallback = this.normalizeDeadlineDate(new Date(normalizedText), readyInDays);
    if (!fallback) {
      throw new BadRequestException('Крайняя дата должна быть не раньше готовности и не позже чем через 28 дней.');
    }

    return fallback;
  }

  private normalizeDeadlineDate(date: Date, readyInDays: number): string | undefined {
    if (Number.isNaN(date.getTime())) {
      return undefined;
    }

    const todayMoscow = startOfMoscowDay(new Date());
    const targetMoscow = startOfMoscowDay(date);
    const diffMs = targetMoscow.getTime() - todayMoscow.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

    if (diffDays < readyInDays || diffDays > 28) {
      return undefined;
    }

    return toOzonIso(endOfMoscowDay(targetMoscow));
  }

  private normalizeTimeslotWindow(body: SubmitWebDraftDto): {
    firstAvailable: boolean;
    fromHour?: number;
    toHour?: number;
  } {
    if (body.timeslotFirstAvailable !== false) {
      return { firstAvailable: true };
    }

    const fromHour = this.normalizeHour(body.timeslotFromHour, 'timeslotFromHour');
    const toHour = typeof body.timeslotToHour === 'number'
      ? this.normalizeHour(body.timeslotToHour, 'timeslotToHour')
      : undefined;

    if (toHour !== undefined && toHour < fromHour) {
      throw new BadRequestException('Конец диапазона слотов должен быть не раньше начала.');
    }

    return {
      firstAvailable: false,
      fromHour,
      toHour,
    };
  }

  private normalizeHour(value: number | undefined, field: string): number {
    const numeric = Math.floor(Number(value));
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 23) {
      throw new BadRequestException(`${field} должен быть числом от 0 до 23.`);
    }
    return numeric;
  }

  private async prepareDraftAndTimeslot(
    actorId: string,
    draft: WebWizardDraftPayload,
    credentials: Awaited<ReturnType<WebWizardService['requireCredentials']>>,
    warehouseId: number | undefined,
    readyInDays: number,
    lastDay: string,
  ): Promise<WebWizardDraftPayload> {
    let nextDraft = draft;
    let operationId = '';
    let draftInfo: any;

    for (let attempt = 0; attempt <= this.draftRecreateMaxAttempts; attempt += 1) {
      operationId = await this.ensureDraftOperation(nextDraft, credentials);

      try {
        draftInfo = await this.waitForDraftSuccess(operationId, credentials);
        break;
      } catch (error) {
        if (!this.shouldRecreateDraft(error) || attempt >= this.draftRecreateMaxAttempts) {
          throw error;
        }

        nextDraft = await this.draftStore.update(actorId, draft.id, (current) => ({
          ...current,
          selectedTimeslotLabel: undefined,
          task: {
            ...current.task,
            draftId: 0,
            draftOperationId: '',
            selectedTimeslot: undefined,
          },
        }));
      }
    }

    const effectiveDraftId =
      draftInfo?.draft_id ??
      this.parseLocalDraftOperationId(operationId) ??
      nextDraft.task.draftId;

    if (!effectiveDraftId) {
      throw new BadRequestException('Ozon не вернул draft_id для черновика.');
    }

    const selectedClusterWarehouses = this.buildSelectedClusterWarehouses(nextDraft, warehouseId);
    const response = await this.wizardFlow.fetchDraftTimeslots(
      effectiveDraftId,
      warehouseId ? [warehouseId] : [],
      this.buildTimeslotRequestWindow(readyInDays, lastDay),
      nextDraft.supplyType === 'CREATE_TYPE_DIRECT' ? 'DIRECT' : 'CROSSDOCK',
      selectedClusterWarehouses,
      credentials,
    );
    const selectedTimeslot = this.wizardFlow.pickFirstTimeslot(response);

    if (!selectedTimeslot) {
      throw new BadRequestException('Ozon не вернул доступные таймслоты для выбранных параметров.');
    }

    return this.draftStore.update(actorId, draft.id, (current) => ({
      ...current,
      stage: 'readyDaysPending',
      selectedTimeslotLabel: this.process.describeTimeslot(selectedTimeslot),
      task: {
        ...current.task,
        draftId: effectiveDraftId,
        draftOperationId: operationId,
        macrolocalClusterId: this.extractMacrolocalClusterId(draftInfo) ?? current.task.macrolocalClusterId,
        selectedTimeslot,
      },
    }));
  }

  private async ensureDraftOperation(
    draft: WebWizardDraftPayload,
    credentials: Awaited<ReturnType<WebWizardService['requireCredentials']>>,
  ): Promise<string> {
    if (draft.task.draftOperationId?.trim()) {
      return draft.task.draftOperationId.trim();
    }

    const items = this.process.buildDraftItems(draft.task);
    const type = draft.supplyType === 'CREATE_TYPE_DIRECT' ? 'DIRECT' : 'CROSSDOCK';
    const operationId = await this.wizardFlow.createDraft(
      {
        clusterIds: [draft.selectedClusterId!],
        dropOffPointWarehouseId: type === 'CROSSDOCK' ? draft.selectedDropOffId ?? undefined : undefined,
        items,
        type,
      },
      credentials,
    );

    if (!operationId) {
      throw new BadRequestException('Ozon не вернул operation_id для черновика.');
    }

    return operationId;
  }

  private async waitForDraftSuccess(
    operationId: string,
    credentials: Awaited<ReturnType<WebWizardService['requireCredentials']>>,
  ) {
    for (let attempt = 0; attempt < this.draftPollMaxAttempts; attempt += 1) {
      const info = await this.getDraftInfoWithNetworkRetry(operationId, credentials);
      const status = info?.status;
      if (status === 'CALCULATION_STATUS_SUCCESS' || status === 'CALCULATION_STATUS_SUCCEEDED' || status === 'SUCCESS') {
        return info;
      }
      if (status === 'CALCULATION_STATUS_FAILED') {
        throw new BadRequestException('Ozon отклонил создание черновика.');
      }
      if (status === 'CALCULATION_STATUS_EXPIRED') {
        throw new BadRequestException('Черновик истёк до завершения создания.');
      }
      await this.sleep(this.draftPollDelayMs);
    }

    throw new BadRequestException('Черновик не успел перейти в статус «готов» в отведённое время.');
  }

  private async getDraftInfoWithNetworkRetry(
    operationId: string,
    credentials: Awaited<ReturnType<WebWizardService['requireCredentials']>>,
  ) {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.draftInfoNetworkRetryAttempts; attempt += 1) {
      try {
        return await this.wizardFlow.getDraftInfo(operationId, credentials);
      } catch (error) {
        lastError = error;
        if (!this.isTransientOzonError(error) || attempt >= this.draftInfoNetworkRetryAttempts - 1) {
          throw error;
        }
        await this.sleep(this.draftPollDelayMs);
      }
    }

    throw lastError;
  }

  private buildSelectedClusterWarehouses(
    draft: WebWizardDraftPayload,
    warehouseId: number | undefined,
  ): Array<{ macrolocal_cluster_id: number; storage_warehouse_id: number }> | undefined {
    const macrolocalClusterId = draft.task.macrolocalClusterId;
    const normalizedWarehouseId =
      typeof warehouseId === 'number' && warehouseId > 0
        ? warehouseId
        : draft.supplyType === 'CREATE_TYPE_DIRECT'
          ? undefined
          : 0;

    if (!macrolocalClusterId || typeof normalizedWarehouseId !== 'number') {
      return undefined;
    }

    return [
      {
        macrolocal_cluster_id: macrolocalClusterId,
        storage_warehouse_id: normalizedWarehouseId,
      },
    ];
  }

  private extractMacrolocalClusterId(info: any): number | undefined {
    for (const cluster of info?.clusters ?? []) {
      const raw = cluster?.macrolocal_cluster_id;
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return Math.trunc(raw);
      }
    }
    return undefined;
  }

  private buildTimeslotRequestWindow(readyInDays: number, lastDay: string): { dateFromIso: string; dateToIso: string } {
    const from = addMoscowDays(new Date(), readyInDays);
    const parsedDeadline = new Date(lastDay);
    const to = Number.isNaN(parsedDeadline.getTime()) ? addMoscowDays(new Date(), readyInDays) : parsedDeadline;

    return {
      dateFromIso: toOzonIso(from),
      dateToIso: toOzonIso(to),
    };
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

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toPublicPreparationError(error: unknown): BadRequestException {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();

    if (
      normalized.includes('socket hang up') ||
      normalized.includes('timeout') ||
      normalized.includes('network') ||
      normalized.includes('econnreset') ||
      normalized.includes('eai_again')
    ) {
      return new BadRequestException('Ozon временно не ответил при подготовке черновика и таймслота. Попробуйте запустить задачу ещё раз.');
    }

    if (error instanceof BadRequestException) {
      return error;
    }

    return new BadRequestException(`Не удалось подготовить черновик и таймслот: ${message}`);
  }

  private shouldRecreateDraft(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return normalized.includes('отклонил создание черновика') || normalized.includes('черновик истёк');
  }

  private isTransientOzonError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return (
      normalized.includes('socket hang up') ||
      normalized.includes('timeout') ||
      normalized.includes('network') ||
      normalized.includes('econnreset') ||
      normalized.includes('eai_again')
    );
  }

  private async handleSupplyCreated(
    actorId: string,
    draft: WebWizardDraftPayload,
    operationId: string | undefined,
    task: WebWizardDraftPayload['task'],
    credentials: Awaited<ReturnType<WebWizardService['requireCredentials']>>,
  ) {
    const taskId = task.taskId;
    const resolvedOperationId = operationId ?? `draft-${task.draftId ?? taskId}`;
    const resolveResult = await this.process.resolveOrderIdWithRetries(resolvedOperationId, credentials, {
      attempts: 5,
      delayMs: 1000,
    });
    const orderId = resolveResult.orderId;
    const orderDetails = orderId ? await this.process.fetchSupplyOrderDetails(orderId, credentials) : undefined;

    const entity = await this.orderStore.completeTask(actorId, {
      taskId,
      operationId: resolvedOperationId,
      orderId,
      arrival: orderDetails?.timeslotLabel ?? this.process.describeTimeslot(task.selectedTimeslot),
      warehouse: orderDetails?.storageWarehouseName ?? draft.selectedWarehouseName,
      warehouseName: orderDetails?.storageWarehouseName ?? draft.selectedWarehouseName,
      warehouseId: orderDetails?.storageWarehouseId ?? draft.selectedWarehouseId ?? undefined,
      dropOffName: orderDetails?.dropOffName ?? draft.selectedDropOffName ?? undefined,
      dropOffId: orderDetails?.dropOffId ?? draft.selectedDropOffId ?? undefined,
      timeslotFrom: orderDetails?.timeslotFrom ?? task.selectedTimeslot?.from_in_timezone,
      timeslotTo: orderDetails?.timeslotTo ?? task.selectedTimeslot?.to_in_timezone,
      items: this.process.mapTaskItems(task.items),
      task,
    });

    await this.webTaskEmail.sendSupplyCreated(actorId, entity);
  }
}
