import axios from 'axios';
import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';

import {
  OzonApiService,
  OzonCluster,
  OzonCredentials,
  OzonFboWarehouseSearchItem,
  OzonDraftStatus,
  OzonDraftTimeslot,
} from '../config/ozon-api.service';

import { OzonSheetService } from '../ozon/ozon-sheet.service';
import { OzonSupplyService } from '../ozon/ozon-supply.service';
import { OzonSupplyProcessResult, OzonSupplyTask } from '../ozon/ozon-supply.types';
import { UserCredentialsStore } from './user-credentials.store';
import { SupplyOrderStore } from '../storage/supply-order.store';

import {
  SupplyWizardStore,
  SupplyWizardState,
  SupplyWizardDropOffOption,
  SupplyWizardDraftWarehouseOption,
  SupplyWizardWarehouseOption,
  SupplyWizardTimeslotOption,
  SupplyWizardOrderSummary,
  SupplyWizardSupplyItem,
} from './supply-wizard.store';

import { AdminNotifierService } from './admin-notifier.service';
import { SupplyWizardViewService } from './supply-wizard/view.service';

@Injectable()
export class SupplyWizardHandler {
  private readonly logger = new Logger(SupplyWizardHandler.name);
  private readonly dropOffOptionsLimit = 10;
  private readonly draftPollIntervalMs = 10_000;
  private readonly draftPollMaxAttempts = 1_000;
  private readonly draftRecreateMaxAttempts = 1_000;
  private readonly draftLifetimeMs = 30 * 60 * 1000;
  private readonly readyDaysMin = 2;
  private readonly readyDaysMax = 28;
  private readonly warehousePageSize = 10;
  private latestDraftWarehouses: SupplyWizardDraftWarehouseOption[] = [];
  private latestDraftId?: number;
  private latestDraftOperationId?: string;
  private readonly taskAbortControllers = new Map<string, { controller: AbortController; taskId: string }>();

  constructor(
    private readonly credentialsStore: UserCredentialsStore,
    private readonly sheetService: OzonSheetService,
    private readonly supplyService: OzonSupplyService,
    private readonly ozonApi: OzonApiService,
    private readonly wizardStore: SupplyWizardStore,
    private readonly adminNotifier: AdminNotifierService,
    private readonly view: SupplyWizardViewService,
    private readonly orderStore: SupplyOrderStore,
  ) {}

  getState(chatId: string): SupplyWizardState | undefined {
    return this.wizardStore.get(chatId);
  }

  async start(ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
      return;
    }

    const previousState = this.wizardStore.get(chatId);
    const persistedOrders = await this.orderStore.list(chatId);
    const credentials = await this.resolveCredentials(chatId);
    const initialStage = credentials ? 'landing' : 'authWelcome';

    try {
      const baseState = this.wizardStore.start(
        chatId,
        {
          clusters: previousState?.clusters ?? [],
          warehouses: previousState?.warehouses ?? {},
          dropOffs: [],
        },
        { stage: initialStage },
      );

      const state =
        this.wizardStore.update(chatId, (current) => {
          if (!current) return undefined;
          return {
            ...current,
            orders: persistedOrders,
            pendingApiKey: undefined,
            pendingClientId: undefined,
          };
        }) ?? { ...baseState, orders: persistedOrders };

      await this.syncPendingTasks(chatId);
      const landingState = this.wizardStore.get(chatId) ?? state;

      if (!credentials) {
        await this.view.updatePrompt(
          ctx,
          chatId,
          landingState,
          this.view.renderAuthWelcome(),
          this.view.buildAuthWelcomeKeyboard(),
        );
        await this.notifyAdmin(ctx, 'wizard.start', [`stage: ${landingState.stage}`]);
        return;
      }

      await this.view.updatePrompt(
        ctx,
        chatId,
        landingState,
        this.view.renderLanding(landingState),
        this.view.buildLandingKeyboard(landingState),
      );
      await this.notifyAdmin(ctx, 'wizard.start', [`stage: ${landingState.stage}`]);
    } catch (error) {
      this.logger.error(`start wizard failed: ${this.describeError(error)}`);
      await ctx.reply(`❌ Не удалось инициализировать мастер: ${this.describeError(error)}`);
    }
  }

  async handleDocument(ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
      return;
    }

    let state = this.wizardStore.get(chatId);
    if (!state) {
      await this.start(ctx);
      state = this.wizardStore.get(chatId);
    }

    if (!state || state.stage !== 'awaitSpreadsheet') {
      await ctx.reply('Сначала запустите мастер командой /start.');
      return;
    }

    const document = (ctx.message as any)?.document;
    if (!document) return;

    if (!/\.xlsx$/i.test(document.file_name ?? '')) {
      await ctx.reply('Принимаю только файлы .xlsx.');
      return;
    }

    try {
      await this.view.updatePrompt(
        ctx,
        chatId,
        state,
        'Получаю файл, подождите...',
        this.view.buildUploadKeyboard(),
      );
      const buffer = await this.downloadTelegramFile(ctx, document.file_id);
      await this.processSpreadsheet(ctx, chatId, state, { buffer, label: document.file_name ?? 'файл' });
      await this.notifyAdmin(ctx, 'wizard.documentUploaded', [
        `file: ${document.file_name ?? 'unknown'}`,
        document.file_size ? `size: ${document.file_size} bytes` : undefined,
      ]);
    } catch (error) {
      this.logger.error(`handleDocument failed: ${this.describeError(error)}`);
      await ctx.reply(`❌ Не удалось обработать файл: ${this.describeError(error)}`);
      await ctx.reply('Пришлите Excel-файл (Артикул, Количество) повторно.');
      await this.notifyAdmin(ctx, 'wizard.documentError', [this.describeError(error)]);
    }
  }

  async handleAuthApiKeyInput(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    text: string,
  ): Promise<void> {
    const apiKey = text.trim();
    if (!apiKey) {
      await ctx.reply('API Key не должен быть пустым. Попробуйте ещё раз.');
      return;
    }

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        pendingApiKey: apiKey,
        stage: 'authClientId',
      };
    });

    if (!updated) {
      await ctx.reply('Мастер закрыт. Запустите /start заново.');
      return;
    }

    await this.view.updatePrompt(
      ctx,
      chatId,
      updated,
      this.view.renderAuthClientIdPrompt(this.maskSecret(apiKey)),
      this.view.buildAuthClientIdKeyboard(),
    );
  }

  async handleAuthClientIdInput(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    text: string,
  ): Promise<void> {
    const clientId = text.trim();
    if (!clientId) {
      await ctx.reply('Client ID не должен быть пустым. Попробуйте ещё раз.');
      return;
    }

    const apiKey = state.pendingApiKey;
    if (!apiKey) {
      await ctx.reply('Сначала введите API Key.');
      await this.showAuthApiKey(ctx, chatId, state);
      return;
    }

    await this.credentialsStore.set(chatId, { clientId, apiKey });

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        pendingApiKey: undefined,
        pendingClientId: undefined,
        stage: 'landing',
      };
    });

    if (!updated) {
      await ctx.reply('Мастер закрыт. Запустите /start заново.');
      return;
    }

    await this.view.updatePrompt(
      ctx,
      chatId,
      updated,
      this.view.renderLanding(updated),
      this.view.buildLandingKeyboard(updated),
    );

    await this.notifyAdmin(ctx, 'wizard.authCompleted', [
      `client_id: ${this.maskSecret(clientId)}`,
    ]);
  }

  async handleSpreadsheetLink(ctx: Context, text: string): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) return;
    let state = this.wizardStore.get(chatId);
    if (!state) {
      await this.start(ctx);
      state = this.wizardStore.get(chatId);
    }

    if (!state || state.stage !== 'awaitSpreadsheet') {
      await ctx.reply('Запустите мастер командой /start и загрузите файл.');
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      await ctx.reply('Пришлите ссылку на Google Sheets или документ .xlsx.');
      return;
    }

    try {
      await this.view.updatePrompt(
        ctx,
        chatId,
        state,
        'Загружаю таблицу, подождите...',
        this.view.buildUploadKeyboard(),
      );
      await this.processSpreadsheet(ctx, chatId, state, { spreadsheet: trimmed, label: trimmed });
      await this.notifyAdmin(ctx, 'wizard.spreadsheetLink', [`link: ${trimmed}`]);
    } catch (error) {
      this.logger.error(`handleSpreadsheetLink failed: ${this.describeError(error)}`);
      await ctx.reply(`❌ Не удалось обработать таблицу: ${this.describeError(error)}`);
      await this.notifyAdmin(ctx, 'wizard.spreadsheetError', [this.describeError(error)]);
    }
  }

  async handleDropOffSearch(ctx: Context, text: string): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) return;

    const state = this.wizardStore.get(chatId);
    if (
      !state ||
      !['awaitDropOffQuery', 'dropOffSelect', 'clusterPrompt', 'draftWarehouseSelect'].includes(state.stage)
    ) {
      await ctx.reply('Сначала загрузите файл и дождитесь запроса на выбор пункта сдачи.');
      return;
    }

    const query = text.trim();
    if (!query) {
      await ctx.reply('Введите название города или адрес пункта сдачи.');
      return;
    }

    const credentials = await this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /start.');
      return;
    }

    let warehouses: OzonFboWarehouseSearchItem[] = [];
    try {
      warehouses = await this.ozonApi.searchFboWarehouses(
        { search: query, supplyTypes: ['CREATE_TYPE_CROSSDOCK'] },
        credentials,
      );
    } catch (error) {
      this.logger.error(`searchFboWarehouses failed: ${this.describeError(error)}`);
      await ctx.reply(`Не удалось получить пункты сдачи: ${this.describeError(error)}`);
      return;
    }

    const options = this.mapDropOffSearchResults(warehouses);
    if (!options.length) {
      const hasExistingSelection = Boolean(state.selectedDropOffId);
      const updated = this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          stage: hasExistingSelection ? 'clusterPrompt' : 'awaitDropOffQuery',
          dropOffs: [],
          dropOffSearchQuery: query,
          draftWarehouses: [],
          draftTimeslots: [],
          selectedTimeslot: undefined,
          ...(hasExistingSelection
            ? {}
            : { selectedDropOffId: undefined, selectedDropOffName: undefined }),
        };
      });

      const targetState = updated ?? state;
      await this.view.updatePrompt(
        ctx,
        chatId,
        targetState,
        `По запросу «${query}» ничего не найдено. Попробуйте уточнить название города или адреса.`,
        this.view.withCancel(),
      );
      return;
    }

    const limited = options.slice(0, this.dropOffOptionsLimit);
    const truncated = limited.length < options.length;

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: 'dropOffSelect',
        dropOffs: limited,
        dropOffSearchQuery: query,
        selectedDropOffId: undefined,
        selectedDropOffName: undefined,
        draftWarehouses: [],
        draftTimeslots: [],
        selectedTimeslot: undefined,
        draftStatus: 'idle',
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
        draftError: undefined,
        tasks: (current.tasks ?? []).map((task) => ({
          ...task,
          draftOperationId: '',
          draftId: 0,
        })),
      };
    });

    if (!updated) {
      await ctx.reply('Мастер закрыт. Запустите /start, чтобы начать заново.');
      return;
    }

    const lines = limited.map((option, index) => {
      const address = option.address ? ` — ${option.address}` : '';
      return `${index + 1}. ${option.name} (${option.warehouse_id})${address}`;
    });

    const summaryParts = [
      `Найдены пункты сдачи по запросу «${query}»:`,
      ...lines,
    ];

    if (truncated) {
      summaryParts.push(
        `… Показаны первые ${limited.length} из ${options.length} результатов. Уточните запрос, чтобы сузить список.`,
      );
    }

    const promptText = [
      ...summaryParts,
      '',
      'Выберите пункт сдачи кнопкой ниже или введите новый запрос, чтобы найти другой вариант.',
    ].join('\n');

    await this.view.updatePrompt(
      ctx,
      chatId,
      updated,
      promptText,
      this.view.buildDropOffKeyboard(updated),
    );
  }

  async handleReadyDays(ctx: Context, text: string): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) return;

    const state = this.wizardStore.get(chatId);
    if (!state || state.stage !== 'awaitReadyDays') {
      await ctx.reply('Сначала загрузите файл и выберите склад/пункт сдачи.');
      return;
    }

    await ctx.reply('Готовность к отгрузке теперь выбирается автоматически — ждать ничего не нужно.');
  }

  private buildReadyContext(state: SupplyWizardState): string[] {
    const lines: string[] = [];

    if (state.selectedClusterName || state.selectedClusterId) {
      lines.push(`Кластер: ${state.selectedClusterName ?? state.selectedClusterId}.`);
    }

    if (state.autoWarehouseSelection) {
      lines.push('Склад: Первый доступный (определю автоматически).');
    } else if (state.selectedWarehouseName || state.selectedWarehouseId) {
      lines.push(`Склад: ${state.selectedWarehouseName ?? state.selectedWarehouseId}.`);
    }

    if (state.selectedDropOffName || state.selectedDropOffId) {
      lines.push(`Пункт сдачи: ${state.selectedDropOffName ?? state.selectedDropOffId}.`);
    }

    if (state.selectedTimeslot?.label) {
      lines.push(`Таймслот: ${state.selectedTimeslot.label}.`);
    }

    return lines;
  }

  private async startSupplyProcessing(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    readyInDays: number,
  ): Promise<void> {
    const task = state.tasks?.[0];
    if (!task) {
      await ctx.reply('Не найдены товары для обработки. Запустите мастер заново.');
      this.wizardStore.clear(chatId);
      return;
    }
    if (!task.taskId) {
      await ctx.reply('Не удалось определить идентификатор задачи. Запустите мастер заново.');
      this.wizardStore.clear(chatId);
      return;
    }

    if (
      !state.selectedClusterId ||
      !state.selectedDropOffId ||
      (!state.selectedWarehouseId && !state.autoWarehouseSelection)
    ) {
      await ctx.reply('Должны быть выбраны кластер, склад и пункт сдачи. Запустите мастер заново.');
      this.wizardStore.clear(chatId);
      return;
    }

    const credentials = await this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /start.');
      return;
    }

    const abortController = this.registerAbortController(chatId, task.taskId);

    const wasAutoWarehouseSelection = typeof state.selectedWarehouseId !== 'number';
    const effectiveTask = this.cloneTask(task);

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: 'landing',
        readyInDays,
        autoWarehouseSelection: current.autoWarehouseSelection,
        warehouseSearchQuery: undefined,
        warehousePage: 0,
      };
    });

    if (!updated) {
      await ctx.reply('Мастер закрыт. Запустите заново.');
      this.clearAbortController(chatId, task.taskId);
      return;
    }

    effectiveTask.clusterId = updated.selectedClusterId;
    effectiveTask.city = updated.selectedClusterName ?? '';
    effectiveTask.warehouseId = updated.selectedWarehouseId;
    effectiveTask.warehouseName = wasAutoWarehouseSelection
      ? effectiveTask.warehouseName
      : updated.selectedWarehouseName ?? effectiveTask.warehouseName;
    effectiveTask.selectedTimeslot = updated.selectedTimeslot?.data ?? effectiveTask.selectedTimeslot;
    if (updated.draftOperationId) {
      effectiveTask.draftOperationId = updated.draftOperationId;
    }
    if (typeof updated.draftId === 'number') {
      effectiveTask.draftId = updated.draftId;
    }

    const warehouseLabel = wasAutoWarehouseSelection
      ? 'Первый доступный склад'
      : updated.selectedWarehouseName ??
        (typeof updated.selectedWarehouseId === 'number' ? `Склад ${updated.selectedWarehouseId}` : '—');

    const summaryLines = [
      `Кластер: ${updated.selectedClusterName ?? '—'}`,
      `Склад: ${warehouseLabel}`,
      `Пункт сдачи: ${updated.selectedDropOffName ?? updated.selectedDropOffId ?? '—'}`,
    ];
    summaryLines.push(`Готовность к отгрузке: ${readyInDays} дн. (по умолчанию).`);
    summaryLines.push('Таймслот и доступный склад будут выбраны автоматически.');
    summaryLines.push('', 'Создаю поставку...');

    try {
      await this.orderStore.saveTask(chatId, {
        task: effectiveTask,
        clusterId: updated.selectedClusterId!,
        clusterName: updated.selectedClusterName,
        warehouseId: updated.selectedWarehouseId,
        warehouseName:
          wasAutoWarehouseSelection
            ? warehouseLabel
            : updated.selectedWarehouseName ??
              (typeof updated.selectedWarehouseId === 'number'
                ? String(updated.selectedWarehouseId)
                : undefined),
        dropOffId: updated.selectedDropOffId!,
        dropOffName: updated.selectedDropOffName ?? String(updated.selectedDropOffId),
        readyInDays,
        timeslotLabel:
          updated.selectedTimeslot?.label ?? this.describeTimeslot(effectiveTask.selectedTimeslot),
        warehouseAutoSelect: wasAutoWarehouseSelection,
        timeslotAutoSelect: true,
      });

      if (!this.wizardStore.get(chatId)) {
        this.clearAbortController(chatId, task.taskId);
        await this.orderStore.deleteByTaskId(chatId, task.taskId);
        return;
      }

      await this.syncPendingTasks(chatId);

      const landingState = this.wizardStore.get(chatId) ?? updated;
      const landingText = this.view.renderLanding(landingState);
      const promptText = [
        ...summaryLines,
        '',
        'Задача запущена. Проверяйте раздел «Мои задачи».',
        '',
        landingText,
      ].join('\n');

      if (!this.wizardStore.get(chatId)) {
        this.clearAbortController(chatId, task.taskId);
        await this.orderStore.deleteByTaskId(chatId, task.taskId);
        return;
      }

      await this.view.updatePrompt(
        ctx,
        chatId,
        landingState,
        promptText,
        this.view.buildLandingKeyboard(landingState),
      );
      await this.notifyAdmin(ctx, 'wizard.supplyProcessing', summaryLines);
      if (!this.wizardStore.get(chatId)) {
        this.clearAbortController(chatId, task.taskId);
        await this.orderStore.deleteByTaskId(chatId, task.taskId);
        return;
      }
    } catch (error) {
      this.clearAbortController(chatId, task.taskId);
      throw error;
    }

    void this.processSupplyTask({
      ctx,
      chatId,
      state: updated,
      task: effectiveTask,
      readyInDays,
      credentials,
      abortController,
    });
  }

  private async processSupplyTask(params: {
    ctx: Context;
    chatId: string;
    state: SupplyWizardState;
    task: OzonSupplyTask;
    readyInDays: number;
    credentials: OzonCredentials;
    abortController: AbortController;
  }): Promise<void> {
    const { ctx, chatId, state, task, readyInDays, credentials, abortController } = params;

    let supplyResult: OzonSupplyProcessResult | undefined;

    try {
      await this.supplyService.runSingleTask(task, {
        credentials,
        readyInDays,
        dropOffWarehouseId: state.selectedDropOffId,
        skipDropOffValidation: true,
        abortSignal: abortController.signal,
        onEvent: async (result) => {
          if (result.event === 'supplyCreated') {
            supplyResult = result;
          }
          await this.sendSupplyEvent(ctx, result);
        },
      });
      await this.handleSupplySuccess(ctx, chatId, state, task, supplyResult);
    } catch (error) {
      if (this.isAbortError(error)) {
        this.logger.log(`[${chatId}] обработка поставки отменена пользователем`);
        return;
      }

      this.logger.error(`processSupplyTask failed: ${this.describeError(error)}`);
      await this.view.updatePrompt(ctx, chatId, state, 'Мастер завершён с ошибкой ❌');
      await ctx.reply(`❌ Ошибка при обработке: ${this.describeError(error)}`);
      await this.view.sendErrorDetails(ctx, this.extractErrorPayload(error));
      await this.notifyAdmin(ctx, 'wizard.supplyError', [this.describeError(error)]);
    } finally {
      this.clearAbortController(chatId, task.taskId);
    }
  }

  private async syncPendingTasks(chatId: string): Promise<SupplyWizardOrderSummary[]> {
    const pending = await this.orderStore.listTaskSummaries(chatId);
    this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        pendingTasks: pending,
      };
    });
    return pending;
  }

  private async cancelPendingTask(ctx: Context, chatId: string, taskId: string): Promise<void> {
    this.abortActiveTask(chatId, taskId);
    await this.orderStore.deleteByTaskId(chatId, taskId);
    await this.syncPendingTasks(chatId);
    this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        tasks: current.tasks?.filter((task) => task.taskId !== taskId),
        selectedTaskId: current.selectedTaskId === taskId ? undefined : current.selectedTaskId,
        autoWarehouseSelection: false,
      };
    });
    await this.notifyAdmin(ctx, 'wizard.taskCancelled', [`task: ${taskId}`]);
  }

  async handleCallback(ctx: Context, data: string): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) return;

    const state = this.wizardStore.get(chatId);
    if (!state) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Мастер не запущен');
      return;
    }

    const [, action, ...rest] = data.split(':');

    switch (action) {
      case 'auth':
        await this.onAuthCallback(ctx, chatId, state, rest);
        return;
      case 'landing':
        await this.onLandingCallback(ctx, chatId, state, rest);
        return;
      case 'orders':
        await this.onOrdersCallback(ctx, chatId, state, rest);
        return;
      case 'tasks':
        await this.onTasksCallback(ctx, chatId, state, rest);
        return;
      case 'ready':
        await this.onReadyCallback(ctx, chatId, state, rest);
        return;
      case 'clusterStart':
        await this.onClusterStart(ctx, chatId, state);
        return;
      case 'cluster':
        await this.onClusterSelect(ctx, chatId, state, rest[0]);
        return;
      case 'warehouse':
        await this.onWarehouseSelect(ctx, chatId, state, rest);
        return;
      case 'dropoff':
        await this.onDropOffSelect(ctx, chatId, state, rest[0]);
        return;
      case 'draftWarehouse':
        await this.onDraftWarehouseSelect(ctx, chatId, state, rest[0]);
        return;
      case 'timeslot':
        await this.onTimeslotSelect(ctx, chatId, state, rest[0]);
        return;
      case 'cancel':
        this.abortActiveTask(chatId);
        if (state.tasks?.length) {
          await Promise.all(
            state.tasks
              .map((task) => task?.taskId)
              .filter((taskId): taskId is string => Boolean(taskId))
              .map((taskId) => this.orderStore.deleteByTaskId(chatId, taskId)),
          );
          await this.syncPendingTasks(chatId);
        }
        this.wizardStore.clear(chatId);
        await this.safeAnswerCbQuery(ctx, chatId, 'Мастер отменён');
        await this.view.updatePrompt(ctx, chatId, state, 'Мастер отменён.');
        return;
      default:
        await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
        return;
    }
  }

  private async onAuthCallback(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    parts: string[],
  ): Promise<void> {
    const action = parts[0];

    switch (action) {
      case 'login':
        await this.showAuthApiKey(ctx, chatId, state);
        await this.safeAnswerCbQuery(ctx, chatId);
        return;
      case 'info':
        await this.showAuthInstruction(ctx, chatId, state);
        await this.safeAnswerCbQuery(ctx, chatId);
        return;
      case 'back': {
        const target = parts[1];
        if (target === 'welcome') {
          await this.showAuthWelcome(ctx, chatId, state);
          await this.safeAnswerCbQuery(ctx, chatId);
          return;
        }
        if (target === 'apiKey') {
          await this.showAuthApiKey(ctx, chatId, state, { keepExisting: true });
          await this.safeAnswerCbQuery(ctx, chatId);
          return;
        }
        break;
      }
      default:
        break;
    }

    await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
  }

  private async showAuthWelcome(
    ctx: Context,
    chatId: string,
    fallback: SupplyWizardState,
  ): Promise<void> {
    const state =
      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          stage: 'authWelcome',
        };
      }) ?? fallback;

    await this.view.updatePrompt(
      ctx,
      chatId,
      state,
      this.view.renderAuthWelcome(),
      this.view.buildAuthWelcomeKeyboard(),
    );
  }

  private async showAuthInstruction(
    ctx: Context,
    chatId: string,
    fallback: SupplyWizardState,
  ): Promise<void> {
    const state =
      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          stage: 'authWelcome',
        };
      }) ?? fallback;

    await this.view.updatePrompt(
      ctx,
      chatId,
      state,
      this.view.renderAuthInstruction(),
      this.view.buildAuthInstructionKeyboard(),
    );
  }

  private async showAuthApiKey(
    ctx: Context,
    chatId: string,
    fallback: SupplyWizardState,
    options: { keepExisting?: boolean } = {},
  ): Promise<void> {
    const state =
      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          stage: 'authApiKey',
          pendingApiKey: options.keepExisting ? current.pendingApiKey : undefined,
        };
      }) ?? fallback;

    await this.view.updatePrompt(
      ctx,
      chatId,
      state,
      this.view.renderAuthApiKeyPrompt(),
      this.view.buildAuthApiKeyKeyboard(),
    );
  }

  private async showAuthClientId(
    ctx: Context,
    chatId: string,
    fallback: SupplyWizardState,
  ): Promise<void> {
    const updated =
      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          stage: 'authClientId',
        };
      }) ?? fallback;

    const masked = updated.pendingApiKey ? this.maskSecret(updated.pendingApiKey) : undefined;

    await this.view.updatePrompt(
      ctx,
      chatId,
      updated,
      this.view.renderAuthClientIdPrompt(masked),
      this.view.buildAuthClientIdKeyboard(),
    );
  }

  private maskSecret(value: string): string {
    if (!value) {
      return '***';
    }
    if (value.length <= 4) {
      return '*'.repeat(value.length);
    }
    return `${value.slice(0, 2)}…${value.slice(-2)}`;
  }

  private async onLandingCallback(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    parts: string[],
  ): Promise<void> {
    const action = parts[0];

    switch (action) {
      case 'start':
        await this.presentUploadPrompt(ctx, chatId, state);
        await this.safeAnswerCbQuery(ctx, chatId, 'Жду файл');
        return;
      case 'back':
        await this.showLanding(ctx, chatId, state);
        await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись назад');
        return;
      default:
        await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
        return;
    }
  }

  private async showLanding(
    ctx: Context,
    chatId: string,
    fallback: SupplyWizardState,
  ): Promise<void> {
    await this.syncPendingTasks(chatId);
    const state =
      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          stage: 'landing',
          activeOrderId: undefined,
          activeTaskId: undefined,
        };
      }) ?? fallback;

    await this.view.updatePrompt(
      ctx,
      chatId,
      state,
      this.view.renderLanding(state),
      this.view.buildLandingKeyboard(state),
    );
  }

  private async presentUploadPrompt(
    ctx: Context,
    chatId: string,
    fallback: SupplyWizardState,
  ): Promise<void> {
    const state =
      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          stage: 'awaitSpreadsheet',
          spreadsheet: undefined,
          tasks: undefined,
          selectedTaskId: undefined,
          dropOffs: [],
          dropOffSearchQuery: undefined,
          selectedDropOffId: undefined,
          selectedDropOffName: undefined,
          selectedClusterId: undefined,
          selectedClusterName: undefined,
          selectedWarehouseId: undefined,
          selectedWarehouseName: undefined,
          draftWarehouses: [],
          draftTimeslots: [],
          draftStatus: 'idle',
          draftOperationId: undefined,
          draftId: undefined,
          draftCreatedAt: undefined,
          draftExpiresAt: undefined,
          draftError: undefined,
          selectedTimeslot: undefined,
          readyInDays: undefined,
        };
      }) ?? fallback;

    await this.view.updatePrompt(
      ctx,
      chatId,
      state,
      this.view.renderUploadPrompt(),
      this.view.buildUploadKeyboard(),
    );
  }

  private async onOrdersCallback(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    parts: string[],
  ): Promise<void> {
    const action = parts[0];

    switch (action) {
      case 'list':
        await this.showOrdersList(ctx, chatId, state);
        await this.safeAnswerCbQuery(ctx, chatId);
        return;
      case 'details': {
        const orderId = parts[1];
        await this.showOrderDetails(ctx, chatId, state, orderId);
        await this.safeAnswerCbQuery(ctx, chatId);
        return;
      }
      case 'cancel':
        await this.safeAnswerCbQuery(ctx, chatId, 'Функция отмены скоро появится');
        return;
      case 'back':
        await this.showLanding(ctx, chatId, state);
        await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись назад');
        return;
      default:
        await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
        return;
    }
  }

  private async onTasksCallback(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    parts: string[],
  ): Promise<void> {
    const action = parts[0];

    switch (action) {
      case 'list': {
        await this.syncPendingTasks(chatId);
        const current = this.wizardStore.get(chatId) ?? state;
        const updated =
          this.wizardStore.update(chatId, (existing) => {
            if (!existing) return undefined;
            return {
              ...existing,
              stage: 'tasksList',
              activeTaskId: undefined,
            };
          }) ?? current;

        await this.view.updatePrompt(
          ctx,
          chatId,
          updated,
          this.view.renderTasksList(updated),
          this.view.buildTasksListKeyboard(updated),
        );
        await this.safeAnswerCbQuery(ctx, chatId);
        return;
      }
      case 'details': {
        const taskId = parts[1];
        await this.syncPendingTasks(chatId);
        const current = this.wizardStore.get(chatId) ?? state;
        if (!taskId) {
          await this.safeAnswerCbQuery(ctx, chatId, 'Задача не найдена');
          return;
        }
        const task = current.pendingTasks.find((item) => item.taskId === taskId || item.id === taskId);
        if (!task) {
          await this.safeAnswerCbQuery(ctx, chatId, 'Задача не найдена');
          return;
        }

        const updated =
          this.wizardStore.update(chatId, (existing) => {
            if (!existing) return undefined;
            return {
              ...existing,
              stage: 'taskDetails',
              activeTaskId: taskId,
            };
          }) ?? current;

        await this.view.updatePrompt(
          ctx,
          chatId,
          updated,
          this.view.renderTaskDetails(task),
          this.view.buildTaskDetailsKeyboard(task),
        );
        await this.safeAnswerCbQuery(ctx, chatId);
        return;
      }
      case 'cancel': {
        const taskId = parts[1];
        if (!taskId) {
          await this.safeAnswerCbQuery(ctx, chatId, 'Задача не найдена');
          return;
        }

        await this.cancelPendingTask(ctx, chatId, taskId);
        await this.syncPendingTasks(chatId);
        const current = this.wizardStore.get(chatId) ?? state;
        if (current.pendingTasks.length) {
          const updated =
            this.wizardStore.update(chatId, (existing) => {
              if (!existing) return undefined;
              return {
                ...existing,
                stage: 'tasksList',
                activeTaskId: undefined,
              };
            }) ?? current;

          await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            this.view.renderTasksList(updated),
            this.view.buildTasksListKeyboard(updated),
          );
        } else {
          await this.showLanding(ctx, chatId, current);
        }
        await this.safeAnswerCbQuery(ctx, chatId, 'Задача отменена');
        return;
      }
      case 'back':
        await this.showLanding(ctx, chatId, state);
        await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись назад');
        return;
      default:
        await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
        return;
    }
  }

  private async onReadyCallback(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    parts: string[],
  ): Promise<void> {
    const action = parts[0];

    switch (action) {
      case 'select': {
        await this.safeAnswerCbQuery(ctx, chatId, 'Готовность выбирается автоматически');
        return;
      }
      default:
        await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
        return;
    }
  }

  private async showOrdersList(
    ctx: Context,
    chatId: string,
    fallback: SupplyWizardState,
  ): Promise<void> {
    const state =
      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          stage: 'ordersList',
        };
      }) ?? fallback;

    await this.view.updatePrompt(
      ctx,
      chatId,
      state,
      this.view.renderOrdersList(state),
      this.view.buildOrdersListKeyboard(state),
    );
  }

  private async showOrderDetails(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    orderId?: string,
  ): Promise<void> {
    if (!orderId) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Заявка не найдена');
      return;
    }

    const currentState = this.wizardStore.get(chatId) ?? state;
    const order = currentState.orders.find((item) => item.id === orderId);
    if (!order) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Заявка не найдена');
      return;
    }

    const updated =
      this.wizardStore.update(chatId, (existing) => {
        if (!existing) return undefined;
        return {
          ...existing,
          stage: 'orderDetails',
          activeOrderId: orderId,
        };
      }) ?? currentState;

    await this.view.updatePrompt(
      ctx,
      chatId,
      updated,
      this.view.renderOrderDetails(order),
      this.view.buildOrderDetailsKeyboard(),
    );
  }

  private async handleSupplySuccess(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    task: OzonSupplyTask,
    result?: OzonSupplyProcessResult,
  ): Promise<void> {
    const operationId = result?.operationId ?? this.extractOperationIdFromMessage(result?.message) ?? task.draftOperationId ?? `draft-${task.draftId ?? task.taskId}`;
    const arrival = state.selectedTimeslot?.label ?? this.describeTimeslot(task.selectedTimeslot);
    const warehouse =
      state.selectedWarehouseName ??
      task.warehouseName ??
      (typeof state.selectedWarehouseId === 'number' ? `Склад ${state.selectedWarehouseId}` : undefined) ??
      state.selectedDropOffName ??
      state.selectedDropOffId?.toString();

    const items: SupplyWizardSupplyItem[] = task.items.map((item) => ({
      article: item.article,
      quantity: item.quantity,
      sku: item.sku,
    }));

    const entry: SupplyWizardOrderSummary = {
      id: operationId,
      taskId: task.taskId,
      operationId,
      status: 'supply',
      arrival: arrival ?? undefined,
      warehouse: warehouse ?? undefined,
      dropOffName: state.selectedDropOffName ?? state.selectedDropOffId?.toString(),
      clusterName: state.selectedClusterName,
      timeslotLabel: arrival ?? undefined,
      items,
      createdAt: Date.now(),
    };

    const updated =
      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        const withoutDuplicate = current.orders.filter((order) => order.id !== entry.id);
        return {
          ...current,
          orders: [...withoutDuplicate, entry],
          stage: 'landing',
          tasks: undefined,
          readyInDays: undefined,
          selectedTimeslot: undefined,
          draftTimeslots: [],
          draftWarehouses: [],
          draftStatus: 'idle',
          draftOperationId: undefined,
          draftId: undefined,
          draftCreatedAt: undefined,
          draftExpiresAt: undefined,
          draftError: undefined,
          spreadsheet: undefined,
        };
      }) ?? state;

    await this.orderStore.completeTask(chatId, {
      taskId: task.taskId,
      operationId,
      arrival: entry.arrival,
      warehouse: entry.warehouse,
      dropOffName: entry.dropOffName,
      items,
      task,
    });

    await this.syncPendingTasks(chatId);

    const refreshed = this.wizardStore.get(chatId) ?? updated;
    const successText = this.view.renderSupplySuccess(entry);
    const landingText = this.view.renderLanding(refreshed);
    const promptText = [successText, '', landingText].join('\n');

    await this.view.updatePrompt(
      ctx,
      chatId,
      refreshed,
      promptText,
      this.view.buildLandingKeyboard(refreshed),
    );

    await this.notifyAdmin(ctx, 'wizard.supplyDone', [
      `order: ${entry.id}`,
      entry.arrival ? `arrival: ${entry.arrival}` : undefined,
      entry.warehouse ? `warehouse: ${entry.warehouse}` : undefined,
    ]);
  }

  private extractOperationIdFromMessage(message?: string): string | undefined {
    if (!message) return undefined;
    const match = /operation_id=([\w-]+)/i.exec(message);
    return match ? match[1] : undefined;
  }

  private describeTimeslot(slot?: OzonDraftTimeslot): string | undefined {
    if (!slot) {
      return undefined;
    }

    const from = slot.from_in_timezone;
    const to = slot.to_in_timezone;
    if (!from || !to) {
      return undefined;
    }
    return `${from} — ${to}`;
  }

  private async processSpreadsheet(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    source: { buffer?: Buffer; spreadsheet?: string; label: string },
  ): Promise<void> {
    const credentials = await this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /start.');
      return;
    }

    const taskMap = await this.supplyService.prepareTasks({
      credentials,
      buffer: source.buffer,
      spreadsheet: source.spreadsheet,
    });

    const tasks = [...taskMap.values()];
    if (!tasks.length) {
      await ctx.reply('В документе не найдены товары. Проверьте колонки «Артикул» и «Количество».');
      return;
    }

    const clonedTasks = tasks.map((task) => this.cloneTask(task));

    for (const task of clonedTasks) {
      task.clusterId = undefined;
      task.warehouseId = undefined;
      task.draftId = task.draftId ?? 0;
      task.draftOperationId = task.draftOperationId ?? '';
      task.orderFlag = task.orderFlag ?? 0;
      task.selectedTimeslot = undefined;
    }

    await this.resolveSkus(clonedTasks[0], credentials);

    const summary = this.view.formatItemsSummary(clonedTasks[0]);

    let clusters: OzonCluster[] = [];
    try {
      const response = await this.ozonApi.listClusters({}, credentials);
      clusters = response.clusters;
    } catch (error) {
      this.logger.error(`listClusters failed: ${this.describeError(error)}`);
      await ctx.reply('Не удалось получить список кластеров. Попробуйте позже.');
      return;
    }

    if (!clusters.length) {
      await ctx.reply('Ozon вернул пустой список кластеров. Попробуйте позже.');
      return;
    }

    const options = this.view.buildOptions(clusters);

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: 'awaitDropOffQuery',
        spreadsheet: source.label,
        tasks: clonedTasks,
        selectedTaskId: clonedTasks[0]?.taskId,
        clusters: options.clusters,
        warehouses: options.warehouses,
        dropOffs: [],
        dropOffSearchQuery: undefined,
        draftStatus: 'idle',
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
        draftError: undefined,
        selectedClusterId: undefined,
        selectedClusterName: undefined,
        selectedWarehouseId: undefined,
        selectedWarehouseName: undefined,
        selectedDropOffId: undefined,
        selectedDropOffName: undefined,
      };
    });

    if (!updated) {
      await ctx.reply('Мастер закрыт. Запустите заново.');
      return;
    }

    const promptText = [
      summary,
      '',
      'Файл обработан. Введите город, адрес или название пункта сдачи, чтобы найти место отгрузки.',
      'Можно отправить новый запрос в любой момент или отменить мастера кнопкой ниже.',
    ].join('\n');

    await this.view.updatePrompt(ctx, chatId, updated, promptText, this.view.withCancel());
  }

  private async onClusterStart(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
  ): Promise<void> {
    if (state.stage !== 'clusterPrompt') {
      await this.safeAnswerCbQuery(ctx, chatId, 'Выбор недоступен.');
      return;
    }

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: 'clusterSelect',
        selectedClusterId: undefined,
        selectedClusterName: undefined,
        selectedWarehouseId: current.selectedWarehouseId,
        selectedWarehouseName: current.selectedWarehouseName,
        draftWarehouses: current.draftWarehouses,
        draftTimeslots: [],
        selectedTimeslot: undefined,
        draftStatus: 'idle',
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
        draftError: undefined,
        tasks: (current.tasks ?? []).map((task) => ({
          ...task,
          clusterId: undefined,
          warehouseId: current.selectedWarehouseId ?? task.warehouseId,
          warehouseName: current.selectedWarehouseName ?? task.warehouseName,
          draftOperationId: '',
          draftId: 0,
        })),
      };
    });

    if (!updated) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
      return;
    }

    const message = (ctx.callbackQuery as any)?.message;
    if (message?.chat?.id && message?.message_id) {
      try {
        await ctx.telegram.editMessageReplyMarkup(message.chat.id, message.message_id, undefined, undefined);
      } catch (error) {
        this.logger.debug(`editMessageReplyMarkup failed: ${this.describeError(error)}`);
      }
    }

    await this.view.updatePrompt(
      ctx,
      chatId,
      updated,
      'Выберите кластер, в который планируете вести поставку.',
      this.view.buildClusterKeyboard(updated),
    );

    await this.safeAnswerCbQuery(ctx, chatId, 'Продолжаем');
  }

  private async onClusterSelect(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    payload: string | undefined,
  ): Promise<void> {

    if (state.stage !== 'clusterSelect') {
      await this.safeAnswerCbQuery(ctx, chatId, 'Сначала загрузите файл');
      return;
    }

    const clusterId = Number(payload);
    if (!Number.isFinite(clusterId)) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Некорректный кластер');
      return;
    }

    const cluster = state.clusters.find((item) => item.id === clusterId);
    if (!cluster) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Кластер не найден');
      return;
    }

    const credentials = await this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /start.');
      return;
    }

    let refreshedWarehouses: SupplyWizardWarehouseOption[] | undefined;
    try {
      const response = await this.ozonApi.listClusters(
        { clusterIds: [cluster.id], clusterType: 'CLUSTER_TYPE_OZON' },
        credentials,
      );
      const buildResult = this.view.buildOptions(response.clusters ?? []);
      refreshedWarehouses = buildResult.warehouses[cluster.id] ?? [];
      if (!refreshedWarehouses.length) {
        this.logger.debug(`[${chatId}] listClusters returned empty warehouses for cluster ${cluster.id}`);
      }
    } catch (error) {
      this.logger.warn(
        `[${chatId}] Не удалось обновить склады для кластера ${cluster.id}: ${this.describeError(error)}`,
      );
    }

    const hasDropOffSelection = Boolean(state.selectedDropOffId);

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      const nextWarehouses = { ...current.warehouses };
      if (refreshedWarehouses) {
        nextWarehouses[cluster.id] = refreshedWarehouses;
      }
      return {
        ...current,
        stage: hasDropOffSelection ? 'warehouseSelect' : 'dropOffSelect',
        selectedClusterId: cluster.id,
        selectedClusterName: cluster.name,
        selectedWarehouseId: undefined,
        selectedWarehouseName: undefined,
        draftWarehouses: [],
        draftTimeslots: [],
        selectedTimeslot: undefined,
        draftStatus: 'idle',
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
        draftError: undefined,
        autoWarehouseSelection: false,
        warehouseSearchQuery: undefined,
        warehousePage: 0,
        warehouses: nextWarehouses,
        tasks: (current.tasks ?? []).map((task) => ({
          ...task,
          clusterId: cluster.id,
          draftOperationId: '',
          draftId: 0,
          selectedTimeslot: undefined,
        })),
      };
    });

    if (!updated) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
      return;
    }

    const dropOffLabel = updated.selectedDropOffName ??
      (updated.selectedDropOffId ? String(updated.selectedDropOffId) : undefined);
    await this.notifyAdmin(ctx, 'wizard.clusterSelected', [
      `cluster: ${cluster.name} (${cluster.id})`,
      dropOffLabel ? `drop-off: ${dropOffLabel}` : undefined,
    ]);

    if (hasDropOffSelection) {
      const nextState = this.wizardStore.get(chatId) ?? updated;
      const dropOffLabelForPrompt =
        nextState.selectedDropOffName ??
        (nextState.selectedDropOffId ? String(nextState.selectedDropOffId) : '—');

      await this.showWarehouseSelection(ctx, chatId, nextState, {
        dropOffLabel: dropOffLabelForPrompt,
      });
    } else {
      await this.view.updatePrompt(
        ctx,
        chatId,
        updated,
        [
          `Кластер выбран: ${cluster.name}.`,
          'Теперь выберите пункт сдачи или отправьте новый запрос с городом.',
        ].join('\n'),
        this.view.buildDropOffKeyboard(updated),
      );
    }

    await this.safeAnswerCbQuery(ctx, chatId, 'Кластер выбран');
  }

  private async onWarehouseSelect(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    payloadParts: string[],
  ): Promise<void> {
    if (state.stage !== 'warehouseSelect') {
      await this.safeAnswerCbQuery(ctx, chatId, 'Сначала выберите кластер и пункт сдачи');
      return;
    }

    state = this.wizardStore.get(chatId) ?? state;

    const action = payloadParts?.[0];
    const extra = payloadParts?.[1];

    if (!action) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Склад не найден');
      return;
    }

    if (action === 'noop') {
      await this.safeAnswerCbQuery(ctx, chatId);
      return;
    }

    if (action === 'page') {
      const view = this.computeWarehouseView(chatId, state);
      const delta = extra === 'next' ? 1 : extra === 'prev' ? -1 : 0;
      const target = Math.min(Math.max(0, view.page + delta), Math.max(0, view.pageCount - 1));
      if (target === view.page) {
        await this.safeAnswerCbQuery(ctx, chatId, delta > 0 ? 'Это последняя страница' : 'Это первая страница');
        return;
      }
      const updated =
        this.wizardStore.update(chatId, (current) => {
          if (!current) return undefined;
          if (current.stage !== 'warehouseSelect') {
            return current;
          }
          return {
            ...current,
            warehousePage: target,
          };
        }) ?? this.wizardStore.get(chatId) ?? view.state;

      await this.showWarehouseSelection(ctx, chatId, updated);
      await this.safeAnswerCbQuery(ctx, chatId, 'Страница обновлена');
      return;
    }

    if (action === 'search' && extra === 'clear') {
      const updated =
        this.wizardStore.update(chatId, (current) => {
          if (!current) return undefined;
          if (current.stage !== 'warehouseSelect') {
            return current;
          }
          return {
            ...current,
            warehouseSearchQuery: undefined,
            warehousePage: 0,
          };
        }) ?? this.wizardStore.get(chatId) ?? state;

      await this.showWarehouseSelection(ctx, chatId, updated);
      await this.safeAnswerCbQuery(ctx, chatId, 'Поиск сброшен');
      return;
    }

    const selectedClusterId = state.selectedClusterId;
    if (!selectedClusterId) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Сначала выберите кластер');
      return;
    }

    const baseWarehouses = state.warehouses[selectedClusterId] ?? [];
    const requestedAuto = action === 'auto';

    if (requestedAuto) {
      if (!baseWarehouses.length) {
        await this.safeAnswerCbQuery(ctx, chatId, 'Для автоматического выбора нет доступных складов');
        return;
      }
    }

    const warehouseId = requestedAuto ? baseWarehouses[0]?.warehouse_id : Number(action);
    const warehouse = requestedAuto
      ? baseWarehouses[0]
      : baseWarehouses.find((item) => item.warehouse_id === warehouseId);

    if (!warehouse || !Number.isFinite(warehouse.warehouse_id)) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Склад не найден');
      return;
    }

    const hasDropOffSelection = Boolean(state.selectedDropOffId);

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      const selectedWarehouseId = requestedAuto ? undefined : warehouse.warehouse_id;
      const selectedWarehouseName = requestedAuto ? undefined : warehouse.name;
      return {
        ...current,
        stage: hasDropOffSelection ? 'awaitReadyDays' : 'dropOffSelect',
        selectedWarehouseId,
        selectedWarehouseName,
        readyInDays: undefined,
        draftWarehouses: [],
        draftTimeslots: [],
        selectedTimeslot: undefined,
        draftStatus: 'idle',
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
        draftError: undefined,
        autoWarehouseSelection: requestedAuto,
        tasks: (current.tasks ?? []).map((task) => ({
          ...task,
          clusterId: current.selectedClusterId ?? task.clusterId,
          warehouseId: selectedWarehouseId ?? undefined,
          warehouseName: selectedWarehouseName ?? task.warehouseName,
          draftOperationId: '',
          draftId: 0,
          selectedTimeslot: undefined,
        })),
      };
    });

    if (!updated) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
      return;
    }

    if (hasDropOffSelection) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Склад выбран');
      await this.startSupplyProcessing(ctx, chatId, updated, this.readyDaysMin);
      return;
    }

    const lines: string[] = [
      `Склад выбран: ${warehouse.name} (${warehouse.warehouse_id}).`,
      '',
      'Теперь выберите пункт сдачи (drop-off).',
    ];

    await this.view.updatePrompt(
      ctx,
      chatId,
      updated,
      lines.join('\n'),
      this.view.buildDropOffKeyboard(updated),
    );

    await this.safeAnswerCbQuery(ctx, chatId, 'Склад выбран');
  }

  private async onDropOffSelect(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    payload: string | undefined,
  ): Promise<void> {
    if (state.stage !== 'dropOffSelect') {
      await this.safeAnswerCbQuery(ctx, chatId, 'Сначала выберите склад');
      return;
    }

    const dropOffId = Number(payload);
    if (!Number.isFinite(dropOffId)) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Некорректный пункт сдачи');
      return;
    }

    const option = state.dropOffs.find((item) => item.warehouse_id === dropOffId);
    if (!option) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Пункт сдачи не найден');
      return;
    }

    const hasClusterSelection = Boolean(state.selectedClusterId);

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: hasClusterSelection ? 'warehouseSelect' : 'clusterPrompt',
        selectedDropOffId: option.warehouse_id,
        selectedDropOffName: option.name,
        selectedWarehouseId: undefined,
        selectedWarehouseName: undefined,
        draftWarehouses: [],
        draftTimeslots: [],
        selectedTimeslot: undefined,
        draftStatus: 'idle',
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
        draftError: undefined,
        autoWarehouseSelection: false,
        warehouseSearchQuery: undefined,
        warehousePage: 0,
        tasks: (current.tasks ?? []).map((task) => ({
          ...task,
          clusterId: current.selectedClusterId ?? task.clusterId,
          draftOperationId: '',
          draftId: 0,
          selectedTimeslot: undefined,
        })),
      };
    });

    if (!updated) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
      return;
    }

    await this.notifyAdmin(ctx, 'wizard.dropOffSelected', [
      `drop-off: ${option.name} (${option.warehouse_id})`,
      option.address ? `address: ${option.address}` : undefined,
    ]);

    if (hasClusterSelection) {
      await this.showWarehouseSelection(ctx, chatId, updated, {
        dropOffLabel: option.name,
      });
    } else {
      const lines: string[] = [
        `Пункт сдачи выбран: ${option.name} (${option.warehouse_id}).`,
      ];
      if (option.address) {
        lines.push(`Адрес: ${option.address}.`);
      }
      if (updated.selectedClusterName || updated.selectedClusterId) {
        lines.push(`Кластер: ${updated.selectedClusterName ?? updated.selectedClusterId}.`);
      }
      lines.push(
        'Нажмите «Выбрать кластер», чтобы продолжить.',
        'При необходимости отправьте новый запрос с городом, чтобы сменить пункт сдачи.',
      );

      await this.view.updatePrompt(
        ctx,
        chatId,
        updated,
        lines.join('\n'),
        this.view.withCancel(this.view.buildClusterStartKeyboard()),
      );
    }

    await this.safeAnswerCbQuery(ctx, chatId, 'Пункт сдачи выбран');
  }

  private computeWarehouseView(
    chatId: string,
    state: SupplyWizardState,
  ): {
    state: SupplyWizardState;
    items: SupplyWizardWarehouseOption[];
    total: number;
    filteredTotal: number;
    page: number;
    pageCount: number;
    hasPrev: boolean;
    hasNext: boolean;
    searchQuery?: string;
  } {
    const clusterId = state.selectedClusterId;
    const warehouses = clusterId ? state.warehouses[clusterId] ?? [] : [];
    const searchQuery = state.warehouseSearchQuery?.trim();
    const normalizedSearch = searchQuery ? searchQuery.toLowerCase() : undefined;

    const filtered = normalizedSearch
      ? warehouses.filter((option) => {
          const name = option.name?.toLowerCase() ?? '';
          const idString = String(option.warehouse_id);
          return name.includes(normalizedSearch) || idString.includes(normalizedSearch);
        })
      : warehouses;

    const total = warehouses.length;
    const filteredTotal = filtered.length;
    const pageCount = filteredTotal ? Math.max(1, Math.ceil(filteredTotal / this.warehousePageSize)) : 1;
    let page = state.warehousePage ?? 0;

    if (page >= pageCount) {
      const updated = this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        if (current.stage !== 'warehouseSelect') {
          return current;
        }
        return {
          ...current,
          warehousePage: pageCount - 1,
        };
      });
      if (updated) {
        state = updated;
        page = state.warehousePage ?? 0;
      } else {
        page = Math.max(0, pageCount - 1);
      }
    }

    const start = page * this.warehousePageSize;
    const items = filtered.slice(start, start + this.warehousePageSize);

    return {
      state,
      items,
      total,
      filteredTotal,
      page,
      pageCount,
      hasPrev: page > 0,
      hasNext: page < pageCount - 1,
      searchQuery,
    };
  }

  private async showWarehouseSelection(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    options: { dropOffLabel?: string } = {},
  ): Promise<void> {
    const clusterId = state.selectedClusterId;
    if (!clusterId) {
      return;
    }

    const view = this.computeWarehouseView(chatId, state);
    const nextState = view.state;

    const prompt = this.view.renderWarehouseSelection({
      clusterName: nextState.selectedClusterName,
      dropOffLabel:
        options.dropOffLabel ??
        nextState.selectedDropOffName ??
        (nextState.selectedDropOffId ? String(nextState.selectedDropOffId) : undefined),
      total: view.total,
      filteredTotal: view.filteredTotal,
      page: view.page,
      pageCount: view.pageCount,
      searchQuery: view.searchQuery,
    });

    const keyboard = this.view.buildClusterWarehouseKeyboard({
      items: view.items,
      page: view.page,
      pageCount: view.pageCount,
      hasPrev: view.hasPrev,
      hasNext: view.hasNext,
      includeAuto: view.total > 0,
      searchActive: Boolean(view.searchQuery),
    });

    await this.view.updatePrompt(ctx, chatId, nextState, prompt, keyboard);
  }

  async handleWarehouseSearch(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    text: string,
  ): Promise<void> {
    if (state.stage !== 'warehouseSelect') {
      return;
    }

    const query = text.trim();
    const normalized = query.length ? query : undefined;
    const updated =
      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        if (current.stage !== 'warehouseSelect') {
          return current;
        }
        return {
          ...current,
          warehouseSearchQuery: normalized,
          warehousePage: 0,
        };
      }) ?? this.wizardStore.get(chatId) ?? state;

    await this.showWarehouseSelection(ctx, chatId, updated);
  }

  private async onDraftWarehouseSelect(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    payload: string | undefined,
  ): Promise<void> {
    if (state.stage !== 'draftWarehouseSelect') {
      await this.safeAnswerCbQuery(ctx, chatId, 'Дождитесь формирования списка складов');
      return;
    }

    const warehousesSource = state.draftWarehouses.length
      ? state.draftWarehouses
      : this.latestDraftWarehouses;

    if (!warehousesSource.length) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Список складов ещё формируется, попробуйте чуть позже');
      return;
    }

    const warehouseId = Number(payload);
    if (!Number.isFinite(warehouseId)) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Некорректный склад');
      return;
    }

    const option = warehousesSource.find((item) => item.warehouseId === warehouseId);
    if (!option) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Склад не найден');
      return;
    }

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      const tasks = (current.tasks ?? []).map((task) => ({
        ...task,
        warehouseId: option.warehouseId,
        warehouseName: option.name ?? task.warehouseName,
      }));

      return {
        ...current,
        stage: 'timeslotSelect',
        selectedWarehouseId: option.warehouseId,
        selectedWarehouseName: option.name,
        selectedClusterId: option.clusterId ?? current.selectedClusterId,
        selectedClusterName: option.clusterName ?? current.selectedClusterName,
        draftWarehouses: current.draftWarehouses?.length ? current.draftWarehouses : this.latestDraftWarehouses,
        draftTimeslots: [],
        selectedTimeslot: undefined,
        tasks,
      };
    });

    if (!updated) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
      return;
    }

    await this.presentDraftWarehouseSelection(ctx, chatId, updated, option);

    await this.safeAnswerCbQuery(ctx, chatId, 'Склад выбран');
  }

  private async presentDraftWarehouseSelection(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    option: SupplyWizardDraftWarehouseOption,
    options: { skipReadyPrompt?: boolean } = {},
  ): Promise<SupplyWizardState | undefined> {
    const skipReadyPrompt = options.skipReadyPrompt ?? false;
    const summaryLines = this.view.describeWarehouseSelection(option, state);

    await this.notifyAdmin(ctx, 'wizard.warehouseSelected', summaryLines);

    if (!skipReadyPrompt) {
      await this.view.updatePrompt(
        ctx,
        chatId,
        state,
        [...summaryLines, '', 'Получаю доступные таймслоты...'].join('\n'),
        this.view.withCancel(),
      );
    }

    const credentials = await this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /start.');
      return undefined;
    }

    const draftId = state.draftId ?? this.latestDraftId;
    if (!draftId) {
      await ctx.reply('Черновик ещё не готов — подождите пару секунд, я пересоздам и повторю попытку.');
      this.resetDraftStateForRetry(chatId);
      const freshState = this.wizardStore.get(chatId);
      if (freshState) {
        await this.ensureDraftCreated(ctx, chatId, freshState);
      }
      return undefined;
    }

    let timeslotOptions: SupplyWizardTimeslotOption[] = [];
    try {
      timeslotOptions = await this.fetchTimeslotsForWarehouse({ ...state, draftId }, option, credentials);
    } catch (error) {
      const message = this.describeError(error);
      this.logger.error(`getDraftTimeslots failed: ${message}`);
      await ctx.reply(`Не удалось получить таймслоты: ${message}`);

      const rollback = this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          stage: 'draftWarehouseSelect',
          draftTimeslots: [],
          selectedTimeslot: undefined,
          tasks: (current.tasks ?? []).map((task) => ({
            ...task,
            selectedTimeslot: undefined,
          })),
        };
      });

      if (rollback) {
        await this.view.updatePrompt(
          ctx,
          chatId,
          rollback,
          'Не удалось получить таймслоты. Выберите другой склад или повторите попытку позже.',
          this.view.buildDraftWarehouseKeyboard(rollback),
        );
      }
      return undefined;
    }

    const { limited, truncated } = this.view.limitTimeslotOptions(timeslotOptions);

    const stored = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;

      if (!limited.length) {
        return {
          ...current,
          stage: 'draftWarehouseSelect',
          draftTimeslots: [],
          selectedTimeslot: undefined,
          tasks: (current.tasks ?? []).map((task) => ({
            ...task,
            selectedTimeslot: undefined,
          })),
        };
      }

      const [firstTimeslot] = limited;

      return {
        ...current,
        stage: 'awaitReadyDays',
        draftTimeslots: limited,
        selectedTimeslot: firstTimeslot,
        tasks: (current.tasks ?? []).map((task) => ({
          ...task,
          selectedTimeslot: firstTimeslot.data,
        })),
      };
    });

    if (!stored) {
      return undefined;
    }

    if (!limited.length) {
      const fallbackText = [
        ...summaryLines,
        '',
        'Свободных таймслотов для этого склада нет.',
        'Выберите другой склад или попробуйте позже.',
      ].join('\n');
      if (skipReadyPrompt) {
        await ctx.reply(fallbackText);
      } else {
        await this.view.updatePrompt(
          ctx,
          chatId,
          stored,
          fallbackText,
          this.view.buildDraftWarehouseKeyboard(stored),
        );
      }
      return undefined;
    }

    const selectedTimeslot = stored.selectedTimeslot;

    if (selectedTimeslot) {
      await this.notifyAdmin(ctx, 'wizard.timeslotSelected', [`timeslot: ${selectedTimeslot.label}`]);
    }

    return stored;
  }

  private async onTimeslotSelect(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    payload: string | undefined,
  ): Promise<void> {
    if (state.stage !== 'timeslotSelect') {
      await this.safeAnswerCbQuery(ctx, chatId, 'Таймслоты выбираются автоматически');
      return;
    }

    if (!payload) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Некорректный таймслот');
      return;
    }

    const option = state.draftTimeslots.find((item) => item.id === payload);
    if (!option) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Таймслот не найден');
      return;
    }

    await this.notifyAdmin(ctx, 'wizard.timeslotSelected', [`timeslot: ${option.label}`]);
    await this.safeAnswerCbQuery(ctx, chatId, 'Таймслот выбирается автоматически');
  }

  private async fetchTimeslotsForWarehouse(
    state: SupplyWizardState,
    option: SupplyWizardDraftWarehouseOption,
    credentials: OzonCredentials,
  ): Promise<SupplyWizardTimeslotOption[]> {
    if (!state.draftId) {
      return [];
    }

    const warehouseIds = this.view.collectTimeslotWarehouseIds(state, option);
    if (!warehouseIds.length) {
      return [];
    }

    const { from, to } = this.computeTimeslotWindow();
    const response = await this.ozonApi.getDraftTimeslots(
      {
        draftId: state.draftId,
        warehouseIds,
        dateFrom: from,
        dateTo: to,
      },
      credentials,
    );

    return this.view.mapTimeslotOptions(response);
  }

  private collectTimeslotWarehouseIds(
    state: SupplyWizardState,
    option: SupplyWizardDraftWarehouseOption,
  ): string[] {
    const warehouseId = option?.warehouseId ?? state.selectedWarehouseId;
    return warehouseId ? [String(warehouseId)] : [];
  }

  private computeTimeslotWindow(): { from: string; to: string } {
    const now = new Date();
    const start = this.addUtcDays(now, this.readyDaysMin);
    const end = this.addUtcDays(now, this.readyDaysMax);
    const from = this.toOzonIso(start);
    const to = this.toOzonIso(end);
    return { from, to };
  }

  private addUtcDays(date: Date, days: number): Date {
    const copy = new Date(date.getTime());
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  }

  private toOzonIso(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private findSelectedDraftWarehouse(
    state: SupplyWizardState,
  ): SupplyWizardDraftWarehouseOption | undefined {
    if (!state.selectedWarehouseId) {
      return undefined;
    }
    return state.draftWarehouses.find((item) => item.warehouseId === state.selectedWarehouseId);
  }

  private mapDropOffSearchResults(
    items: OzonFboWarehouseSearchItem[],
  ): SupplyWizardDropOffOption[] {
    const seen = new Set<number>();
    const options: SupplyWizardDropOffOption[] = [];

    for (const item of items ?? []) {
      if (!item || typeof item.warehouse_id !== 'number') {
        continue;
      }

      const warehouse_id = Number(item.warehouse_id);
      if (!Number.isFinite(warehouse_id) || seen.has(warehouse_id)) {
        continue;
      }

      seen.add(warehouse_id);
      options.push({
          warehouse_id,
        name: item.name?.trim() || `Пункт ${warehouse_id}`,
        address: item.address?.trim() || undefined,
        type: item.warehouse_type ?? undefined,
      });
    }

    return options;
  }

  private async pollDraftStatus(
    chatId: string,
    operationId: string,
    credentials: OzonCredentials,
  ): Promise<
    | { status: 'success'; draftId?: number; errorDetails?: string; draftInfo?: OzonDraftStatus }
    | { status: 'failed' | 'expired'; errorDetails?: string; draftInfo?: OzonDraftStatus }
    | { status: 'timeout'; errorDetails?: string; draftInfo?: OzonDraftStatus }
    | { status: 'error'; message?: string; errorDetails?: string; draftInfo?: OzonDraftStatus }
  > {
    let lastInfo: OzonDraftStatus | undefined;

    for (let attempt = 0; attempt < this.draftPollMaxAttempts; attempt++) {
      try {
        const info = await this.ozonApi.getDraftInfo(operationId, credentials);
        lastInfo = info;

        const status = info?.status;
        if (status === 'CALCULATION_STATUS_SUCCESS') {
          return {
            status: 'success',
            draftId: info?.draft_id,
            errorDetails: this.describeDraftErrors(info),
            draftInfo: info,
          };
        }

        if (status === 'CALCULATION_STATUS_FAILED' || info?.code === 1) {
          return {
            status: 'failed',
            errorDetails: this.describeDraftErrors(info),
            draftInfo: info,
          };
        }

        if (status === 'CALCULATION_STATUS_EXPIRED' || info?.code === 5) {
          return {
            status: 'expired',
            errorDetails: this.describeDraftErrors(info),
            draftInfo: info,
          };
        }

        await this.sleep(this.draftPollIntervalMs);
      } catch (error) {
        const message = this.describeError(error);
        this.logger.warn(`getDraftInfo failed для ${operationId}: ${message}`);
        if (attempt === this.draftPollMaxAttempts - 1) {
          return { status: 'error', message, draftInfo: lastInfo };
        }
        await this.sleep(this.draftPollIntervalMs);
      }
    }

    return {
      status: 'timeout',
      errorDetails: this.describeDraftErrors(lastInfo),
      draftInfo: lastInfo,
    };
  }

  private async handleDraftCreationSuccess(
    ctx: Context,
    chatId: string,
    payload: { operationId: string; draftId?: number; taskId: string; draftInfo?: OzonDraftStatus },
  ): Promise<void> {
    const warehouseOptions = this.view.mapDraftWarehouseOptions(payload.draftInfo);
    const { limited: limitedOptions, truncated } = this.view.limitDraftWarehouseOptions(warehouseOptions);
    this.latestDraftWarehouses = limitedOptions;
    this.latestDraftId = payload.draftId ?? this.latestDraftId;
    this.latestDraftOperationId = payload.operationId;

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;

      const createdAt = current.draftCreatedAt ?? Date.now();
      const expiresAt = current.draftExpiresAt ?? createdAt + this.draftLifetimeMs;

      const tasks = (current.tasks ?? []).map((task) => {
        if (task.taskId !== payload.taskId) {
          return { ...task };
        }
        return {
          ...task,
          clusterId: current.selectedClusterId ?? task.clusterId,
          warehouseId: current.selectedWarehouseId ?? task.warehouseId,
          draftOperationId: payload.operationId,
          draftId: payload.draftId ?? task.draftId,
          selectedTimeslot: undefined,
        };
      });

      return {
        ...current,
        tasks,
        stage: limitedOptions.length ? 'draftWarehouseSelect' : 'awaitReadyDays',
        draftStatus: 'success',
        draftOperationId: payload.operationId,
        draftId: payload.draftId ?? current.draftId,
        draftError: undefined,
        draftCreatedAt: createdAt,
        draftExpiresAt: expiresAt,
        draftWarehouses: limitedOptions,
        draftTimeslots: [],
        selectedTimeslot: undefined,
        ...(limitedOptions.length
          ? {
              selectedWarehouseId: undefined,
              selectedWarehouseName: undefined,
            }
          : {}),
      };
    });

    if (!updated || updated.draftOperationId !== payload.operationId) {
      return;
    }

    const headerLines = [
      'Черновик успешно создан ✅',
      `operation_id: ${payload.operationId}`,
    ];
    if (payload.draftId) {
      headerLines.push(`draft_id: ${payload.draftId}`);
    }
    if (updated.draftExpiresAt) {
      headerLines.push(`Действителен примерно до ${this.formatDraftExpiresAt(updated.draftExpiresAt)}.`);
    }

    if (!limitedOptions.length) {
      headerLines.push(
        '',
        'Ozon не вернул список складов. Укажите количество дней до готовности, чтобы продолжить.',
      );
      await this.view.updatePrompt(ctx, chatId, updated, headerLines.join('\n'), this.view.withCancel());
      return;
    }

    const summaryLines = this.view.formatDraftWarehouseSummary(limitedOptions);
    const footerLines = truncated
      ? [`… Показаны первые ${limitedOptions.length} из ${warehouseOptions.length} складов.`]
      : [];

    const promptText = [
      ...headerLines,
      '',
      'Склады, готовые принять поставку (в порядке приоритета):',
      ...summaryLines,
      ...footerLines,
      '',
      'Выберите склад кнопкой ниже, чтобы перейти к выбору даты готовности.',
    ].join('\n');

    await this.view.updatePrompt(
      ctx,
      chatId,
      updated,
      promptText,
      this.view.buildDraftWarehouseKeyboard(updated),
    );
  }

  private resetDraftStateForRetry(chatId: string): void {
    this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        draftStatus: 'idle',
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
        draftError: undefined,
        draftWarehouses: [],
        draftTimeslots: [],
        selectedTimeslot: undefined,
        tasks: (current.tasks ?? []).map((task) => ({
          ...task,
          draftOperationId: '',
          draftId: 0,
          selectedTimeslot: undefined,
        })),
      };
    });
    this.latestDraftOperationId = undefined;
  }

  private async safeAnswerCbQuery(ctx: Context, chatId: string, text?: string): Promise<void> {
    try {
      await ctx.answerCbQuery(text);
    } catch (error) {
      if (this.isExpiredCallbackError(error)) {
        this.logger.warn(`[${chatId}] callback query expired, recreating draft`);
        await this.handleExpiredCallback(ctx, chatId);
      } else {
        this.logger.debug(`[${chatId}] answerCbQuery failed: ${this.describeError(error)}`);
      }
    }
  }

  private isExpiredCallbackError(error: unknown): boolean {
    const description =
      (error as any)?.response?.description ??
      (error as any)?.description ??
      (error as any)?.message ??
      '';
    return typeof description === 'string' && description.includes('query is too old');
  }

  private async handleExpiredCallback(ctx: Context, chatId: string): Promise<void> {
    const current = this.wizardStore.get(chatId);
    if (!current) {
      return;
    }

    await this.notifyAdmin(ctx, 'wizard.callbackExpired', [`stage: ${current.stage}`]);

    if (current.stage === 'warehouseSelect') {
      const view = this.computeWarehouseView(chatId, current);
      const keyboard = this.view.buildClusterWarehouseKeyboard({
        items: view.items,
        page: view.page,
        pageCount: view.pageCount,
        hasPrev: view.hasPrev,
        hasNext: view.hasNext,
        includeAuto: view.filteredTotal > 0,
        searchActive: Boolean(view.searchQuery),
      });
      const prompt = this.view.renderWarehouseSelection({
        clusterName: current.selectedClusterName,
        dropOffLabel: current.selectedDropOffName ?? (current.selectedDropOffId ? String(current.selectedDropOffId) : undefined),
        total: view.total,
        filteredTotal: view.filteredTotal,
        page: view.page,
        pageCount: view.pageCount,
        searchQuery: view.searchQuery,
      });
      await this.view.updatePrompt(ctx, chatId, view.state, prompt, keyboard);
      return;
    }

    await this.view.updatePrompt(
      ctx,
      chatId,
      current,
      '⚠️ Выберите действие',
      this.view.withCancel(),
    );
  }

  private describeDraftErrors(info?: OzonDraftStatus | any): string | undefined {
    if (!info) {
      return undefined;
    }

    const errors = (info as any).errors;
    const parts: string[] = [];

    if (Array.isArray(errors)) {
      for (const error of errors) {
        const baseMessage = error?.error_message ?? error?.message;
        if (baseMessage) {
          parts.push(String(baseMessage));
        }

        const itemsValidation = error?.items_validation;
        if (Array.isArray(itemsValidation)) {
          for (const item of itemsValidation) {
            const sku = item?.sku;
            const reasons = Array.isArray(item?.reasons) ? item.reasons.join(', ') : undefined;
            if (sku && reasons) {
              parts.push(`SKU ${sku}: ${reasons}`);
            } else if (sku) {
              parts.push(`SKU ${sku}: отклонён без причины`);
            } else if (reasons) {
              parts.push(reasons);
            }
          }
        }
      }
    }

    return parts.length ? parts.join('; ') : undefined;
  }

  private async ensureDraftCreated(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    retryAttempt = 0,
  ): Promise<void> {
    if (!['awaitReadyDays', 'draftWarehouseSelect', 'timeslotSelect'].includes(state.stage)) {
      return;
    }

    if (state.draftStatus === 'creating' || (state.draftStatus === 'success' && state.draftOperationId)) {
      return;
    }

    const clusterId = String(state.selectedClusterId);
    const warehouseId = state.selectedWarehouseId;
    const dropOffId = state.selectedDropOffId;
    if (!clusterId || !warehouseId || !dropOffId) {
      return;
    }

    const task = this.getSelectedTask(state);
    if (!task) {
      this.logger.warn(`[${chatId}] ensureDraftCreated: задача не найдена`);
      return;
    }

    const credentials = await this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /start <CLIENT_ID> <API_KEY>.');
      return;
    }

    const existingOperationId = this.resolveKnownDraftOperationId(state);
    if (existingOperationId) {
      const handled = await this.tryReuseExistingDraft(
        ctx,
        chatId,
        task,
        existingOperationId,
        credentials,
        retryAttempt,
      );
      if (handled) {
        return;
      }
    }

    let items: Array<{ sku: number; quantity: number }>;
    try {
      items = this.buildDraftItems(task);
    } catch (error) {
      const message = this.describeError(error);
      await this.handleDraftCreationFailure(ctx, chatId, message);
      return;
    }

    const started = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      if (current.draftStatus === 'creating') {
        return current;
      }
      return {
        ...current,
        draftStatus: 'creating',
        draftError: undefined,
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
      };
    });

    if (!started || started.draftStatus !== 'creating') {
      return;
    }

    await this.view.updatePrompt(
      ctx,
      chatId,
      started,
      'Создаю черновик, подождите...',
      this.view.withCancel(),
    );

    let operationId: string | undefined;
    try {
      operationId = await this.ozonApi.createDraft(
        {
          clusterIds: [clusterId],
          dropOffPointWarehouseId: dropOffId,
          items,
          type: 'CREATE_TYPE_CROSSDOCK',
        },
        credentials,
      );
    } catch (error) {
      const message = this.describeError(error);
      this.logger.error(`createDraft failed: ${message}`);
      await this.handleDraftCreationFailure(ctx, chatId, message);
      return;
    }

    if (!operationId) {
      await this.handleDraftCreationFailure(ctx, chatId, 'Сервис вернул пустой operation_id.');
      return;
    }

    const withOperation = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      if (current.draftStatus !== 'creating') {
        return current;
      }
      return {
        ...current,
        draftOperationId: operationId,
        draftCreatedAt: Date.now(),
        draftExpiresAt: Date.now() + this.draftLifetimeMs,
      };
    });

    if (!withOperation) {
      return;
    }

    this.latestDraftOperationId = operationId;

    const pollResult = await this.pollDraftStatus(chatId, operationId, credentials);
    await this.handleDraftPollResult(ctx, chatId, task, operationId, pollResult, retryAttempt);
  }

  private resolveKnownDraftOperationId(state: SupplyWizardState): string | undefined {
    const fromState = typeof state.draftOperationId === 'string' ? state.draftOperationId.trim() : '';
    if (fromState) {
      return fromState;
    }
    return this.latestDraftOperationId?.trim() || undefined;
  }

  private async tryReuseExistingDraft(
    ctx: Context,
    chatId: string,
    task: OzonSupplyTask,
    operationId: string,
    credentials: OzonCredentials,
    retryAttempt: number,
  ): Promise<boolean> {
    const normalizedOperationId = operationId.trim();
    if (!normalizedOperationId) {
      return false;
    }

    try {
      const info = await this.ozonApi.getDraftInfo(normalizedOperationId, credentials);
      const status = info?.status;

      if (status === 'CALCULATION_STATUS_SUCCESS') {
        await this.handleDraftCreationSuccess(ctx, chatId, {
          operationId: normalizedOperationId,
          draftId: info?.draft_id,
          taskId: task.taskId,
          draftInfo: info,
        });
        return true;
      }

      if (status === 'CALCULATION_STATUS_FAILED' || info?.code === 1) {
        await this.handleDraftPollResult(
          ctx,
          chatId,
          task,
          normalizedOperationId,
          { status: 'failed', errorDetails: this.describeDraftErrors(info), draftInfo: info },
          retryAttempt,
        );
        return true;
      }

      if (status === 'CALCULATION_STATUS_EXPIRED' || info?.code === 5) {
        await this.handleDraftPollResult(
          ctx,
          chatId,
          task,
          normalizedOperationId,
          { status: 'expired', errorDetails: this.describeDraftErrors(info), draftInfo: info },
          retryAttempt,
        );
        return true;
      }

      const pollResult = await this.pollDraftStatus(chatId, normalizedOperationId, credentials);
      await this.handleDraftPollResult(
        ctx,
        chatId,
        task,
        normalizedOperationId,
        pollResult,
        retryAttempt,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `check existing draft ${normalizedOperationId} failed: ${this.describeError(error)}`,
      );
      return false;
    }
  }

  private async handleDraftPollResult(
    ctx: Context,
    chatId: string,
    task: OzonSupplyTask,
    operationId: string,
    pollResult:
      | { status: 'success'; draftId?: number; errorDetails?: string; draftInfo?: OzonDraftStatus }
      | { status: 'failed' | 'expired'; errorDetails?: string; draftInfo?: OzonDraftStatus }
      | { status: 'timeout'; errorDetails?: string; draftInfo?: OzonDraftStatus }
      | { status: 'error'; message?: string; errorDetails?: string; draftInfo?: OzonDraftStatus },
    retryAttempt: number,
  ): Promise<void> {
    const creationAttempt = retryAttempt;

    switch (pollResult.status) {
      case 'success':
        await this.handleDraftCreationSuccess(ctx, chatId, {
          operationId,
          draftId: pollResult.draftId,
          taskId: task.taskId,
          draftInfo: pollResult.draftInfo,
        });
        return;
      case 'failed':
      case 'expired': {
        const attemptMessage = pollResult.status === 'failed'
          ? 'Черновик отклонён сервисом Ozon.'
          : 'Черновик истёк до завершения создания.';
        const errorSummary = pollResult.errorDetails ? ` Причина: ${pollResult.errorDetails}` : '';
        if (creationAttempt < this.draftRecreateMaxAttempts) {
          await ctx.reply(
            [
              `${attemptMessage}${errorSummary}`.trim(),
              `Пробую создать черновик заново (попытка ${creationAttempt + 2}/${this.draftRecreateMaxAttempts + 1}).`,
            ].join('\n'),
          );
          this.resetDraftStateForRetry(chatId);
          const nextState = this.wizardStore.get(chatId);
          if (nextState) {
            await this.sleep(1_000);
            await this.ensureDraftCreated(ctx, chatId, nextState, creationAttempt + 1);
          }
          return;
        }

        await this.handleDraftCreationFailure(
          ctx,
          chatId,
          `${attemptMessage}${errorSummary ? ` ${errorSummary}` : ''}`,
        );
        return;
      }
      case 'error':
        await this.handleDraftCreationFailure(
          ctx,
          chatId,
          pollResult.message ?? 'Не удалось получить статус черновика.',
        );
        return;
      case 'timeout':
        await this.handleDraftCreationFailure(
          ctx,
          chatId,
          'Черновик не успел перейти в статус «готов» в отведённое время.',
        );
        return;
      default:
        return;
    }
  }

  private getSelectedTask(state: SupplyWizardState): OzonSupplyTask | undefined {
    if (!state.tasks || !state.tasks.length) {
      return undefined;
    }
    if (state.selectedTaskId) {
      const match = state.tasks.find((task) => task.taskId === state.selectedTaskId);
      if (match) {
        return match;
      }
    }
    return state.tasks[0];
  }

  private buildDraftItems(task: OzonSupplyTask): Array<{ sku: number; quantity: number }> {
    const items: Array<{ sku: number; quantity: number }> = [];
    for (const item of task.items) {
      if (!item.sku) {
        throw new Error(`Для артикула «${item.article}» не найден SKU.`);
      }
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
        throw new Error(`Количество должно быть положительным числом (артикул ${item.article}).`);
      }
      items.push({ sku: Math.round(item.sku), quantity: Math.round(item.quantity) });
    }
    return items;
  }

  private async handleDraftCreationFailure(
    ctx: Context,
    chatId: string,
    reason: string,
  ): Promise<void> {
    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        draftStatus: 'failed',
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
        draftError: reason,
        draftWarehouses: [],
        draftTimeslots: [],
        selectedTimeslot: undefined,
        tasks: (current.tasks ?? []).map((task) => ({
          ...task,
          draftOperationId: '',
          draftId: 0,
          selectedTimeslot: undefined,
        })),
      };
    });

    if (!updated) {
      return;
    }

    const message = [
      `❌ Не удалось создать черновик: ${reason}`,
      'Попробуйте выбрать другие параметры или повторите попытку позже.',
    ].join('\n');

    await this.view.updatePrompt(ctx, chatId, updated, message, this.view.withCancel());
    await this.notifyAdmin(ctx, 'wizard.draftError', [reason]);
    this.latestDraftOperationId = undefined;
  }

  private formatDraftExpiresAt(timestamp: number): string {
    const formatter = new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    return formatter.format(new Date(timestamp));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async resolveSkus(task: OzonSupplyTask, credentials: OzonCredentials): Promise<void> {
    const unresolvedOffers: string[] = [];

    for (const item of task.items) {
      const article = item.article?.trim();
      if (!article) {
        throw new Error('Есть строки с пустым артикулом. Исправьте файл и загрузите заново.');
      }

      const numericCandidate = Number(article);
      if (Number.isFinite(numericCandidate) && numericCandidate > 0) {
        item.sku = Math.round(numericCandidate);
        continue;
      }

      unresolvedOffers.push(article);
    }

    if (unresolvedOffers.length) {
      const skuMap = await this.ozonApi.getProductsByOfferIds(unresolvedOffers, credentials);
      const missing: string[] = [];

      for (const article of unresolvedOffers) {
        const sku = skuMap.get(article);
        if (!sku) {
          missing.push(article);
          continue;
        }

        const target = task.items.find((entry) => entry.article.trim() === article);
        if (target) {
          target.sku = sku;
        }
      }

      if (missing.length) {
        throw new Error(`Не удалось найти SKU в Ozon для артикулов: ${missing.join(', ')}`);
      }
    }
  }

  private async sendSupplyEvent(ctx: Context, result: OzonSupplyProcessResult): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) return;

    const text = this.view.formatSupplyEvent({
      taskId: result.task.taskId,
      event: result.event,
      message: result.message,
    });
    if (!text) {
      return;
    }

    await this.notifyAdmin(ctx, `wizard.${result.event}`, [text]);
  }

  private extractChatId(ctx: Context): string | undefined {
    const chatId = (ctx.chat as any)?.id;
    return typeof chatId === 'undefined' || chatId === null ? undefined : String(chatId);
  }

  private async notifyAdmin(ctx: Context, event: string, lines: Array<string | undefined> = []): Promise<void> {
    if (!this.adminNotifier.isEnabled()) {
      return;
    }

    const filtered = lines.filter((value): value is string => Boolean(value && value.trim().length));
    try {
      await this.adminNotifier.notifyWizardEvent({ ctx, event, lines: filtered });
    } catch (error) {
      this.logger.debug(`Admin notification failed (${event}): ${this.describeError(error)}`);
    }
  }

  private async resolveCredentials(chatId: string): Promise<OzonCredentials | undefined> {
    const stored = await this.credentialsStore.get(chatId);
    if (stored) {
      return { clientId: stored.clientId, apiKey: stored.apiKey };
    }

    const envClientId = process.env.OZON_CLIENT_ID;
    const envApiKey = process.env.OZON_API_KEY;
    if (envClientId && envApiKey) {
      return { clientId: envClientId, apiKey: envApiKey };
    }

    return undefined;
  }

  private registerAbortController(chatId: string, taskId: string): AbortController {
    const existing = this.taskAbortControllers.get(chatId);
    if (existing) {
      existing.controller.abort();
    }
    const controller = new AbortController();
    this.taskAbortControllers.set(chatId, { controller, taskId });
    return controller;
  }

  private abortActiveTask(chatId: string, taskId?: string): void {
    const entry = this.taskAbortControllers.get(chatId);
    if (!entry) {
      return;
    }
    if (taskId && entry.taskId !== taskId) {
      return;
    }
    entry.controller.abort();
    this.taskAbortControllers.delete(chatId);
  }

  private clearAbortController(chatId: string, taskId?: string): void {
    const entry = this.taskAbortControllers.get(chatId);
    if (!entry) {
      return;
    }
    if (taskId && entry.taskId !== taskId) {
      return;
    }
    this.taskAbortControllers.delete(chatId);
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private cloneTask(task: OzonSupplyTask): OzonSupplyTask {
    return {
      ...task,
      items: task.items.map((item) => ({ ...item })),
      selectedTimeslot: task.selectedTimeslot ? { ...task.selectedTimeslot } : undefined,
    };
  }

  private async downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
    const link = await ctx.telegram.getFileLink(fileId);
    const url = typeof link === 'string' ? link : link.href ?? link.toString();
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
    });
    return Buffer.from(response.data);
  }

  private describeError(error: unknown): string {
    if (!error) return 'unknown error';
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private extractErrorPayload(error: unknown): string[] | string | undefined {
    const isAxios = (err: any) => err?.isAxiosError && (err.response || err.config);
    if (isAxios(error)) {
      const axiosError = error as any;
      const responseData = this.stringifySafe(axiosError.response?.data);
      const requestData = this.stringifySafe(axiosError.config?.data);
      const meta = [
        `url: ${axiosError.config?.url ?? 'n/a'}`,
        `method: ${axiosError.config?.method ?? 'n/a'}`,
        `status: ${axiosError.response?.status ?? 'n/a'}`,
        requestData ? `request: ${requestData}` : undefined,
        responseData ? `response: ${responseData}` : undefined,
      ]
        .filter(Boolean)
        .join('\n');
      return meta.split('\n');
    }

    if (error instanceof Error) {
      return error.stack ? error.stack.split('\n') : error.message;
    }

    return undefined;
  }

  private stringifySafe(value: unknown): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === 'string') {
      return value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
    }

    try {
      const json = JSON.stringify(value, null, 2);
      return json.length > 1200 ? `${json.slice(0, 1200)}…` : json;
    } catch (error) {
      return undefined;
    }
  }
}
