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
import {
  SupplyWizardStore,
  SupplyWizardState,
  SupplyWizardDropOffOption,
  SupplyWizardDraftWarehouseOption,
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
  private latestDraftWarehouses: SupplyWizardDraftWarehouseOption[] = [];
  private latestDraftId?: number;
  private latestDraftOperationId?: string;

  constructor(
    private readonly credentialsStore: UserCredentialsStore,
    private readonly sheetService: OzonSheetService,
    private readonly supplyService: OzonSupplyService,
    private readonly ozonApi: OzonApiService,
    private readonly wizardStore: SupplyWizardStore,
    private readonly adminNotifier: AdminNotifierService,
    private readonly view: SupplyWizardViewService,
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
    const credentials = this.resolveCredentials(chatId);
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
            orders: previousState?.orders ?? current.orders,
            pendingApiKey: undefined,
            pendingClientId: undefined,
          };
        }) ?? baseState;

      if (!credentials) {
        await this.view.updatePrompt(
          ctx,
          chatId,
          state,
          this.view.renderAuthWelcome(),
          this.view.buildAuthWelcomeKeyboard(),
        );
        await this.notifyAdmin(ctx, 'wizard.start', [`stage: ${state.stage}`]);
        return;
      }

      await this.view.updatePrompt(
        ctx,
        chatId,
        state,
        this.view.renderLanding(state),
        this.view.buildLandingKeyboard(state),
      );
      await this.notifyAdmin(ctx, 'wizard.start', [`stage: ${state.stage}`]);
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

    this.credentialsStore.set(chatId, { clientId, apiKey });

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

    const credentials = this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /start <CLIENT_ID> <API_KEY>.');
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

    const parsed = Number(text.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      await ctx.reply('Введите неотрицательное число дней.');
      return;
    }

    const readyInDays = Math.floor(parsed);
    await this.startSupplyProcessing(ctx, chatId, state, readyInDays);
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

    if (!state.selectedClusterId || !state.selectedWarehouseId || !state.selectedDropOffId) {
      await ctx.reply('Должны быть выбраны кластер, склад и пункт сдачи. Запустите мастер заново.');
      this.wizardStore.clear(chatId);
      return;
    }

    const credentials = this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /start.');
      return;
    }

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: 'processing',
        readyInDays,
      };
    });

    if (!updated) {
      await ctx.reply('Мастер закрыт. Запустите заново.');
      return;
    }

    const clonedTask = this.cloneTask(task);
    clonedTask.clusterId = updated.selectedClusterId;
    clonedTask.city = updated.selectedClusterName ?? '';
    clonedTask.warehouseId = updated.selectedWarehouseId;
    clonedTask.warehouseName = updated.selectedWarehouseName ?? '';
    clonedTask.selectedTimeslot = updated.selectedTimeslot?.data ?? clonedTask.selectedTimeslot;
    if (updated.draftOperationId) {
      clonedTask.draftOperationId = updated.draftOperationId;
    }
    if (typeof updated.draftId === 'number') {
      clonedTask.draftId = updated.draftId;
    }

    const summaryLines = [
      `Кластер: ${updated.selectedClusterName ?? '—'}`,
      `Склад: ${updated.selectedWarehouseName ?? updated.selectedWarehouseId ?? '—'}`,
      `Пункт сдачи: ${updated.selectedDropOffName ?? updated.selectedDropOffId ?? '—'}`,
    ];
    if (updated.selectedTimeslot) {
      summaryLines.push(`Таймслот: ${updated.selectedTimeslot.label}.`);
    }
    if (readyInDays > 0) {
      summaryLines.push(`Готовность к отгрузке через: ${readyInDays} дн.`);
    } else {
    summaryLines.push('Автоматически будет выбран первый доступный временной слот.');
    }
    summaryLines.push('', 'Создаю поставку...');

    await this.view.updatePrompt(ctx, chatId, updated, summaryLines.join('\n'));
    await this.notifyAdmin(ctx, 'wizard.supplyProcessing', summaryLines);

    let supplyResult: OzonSupplyProcessResult | undefined;

    try {
      await this.supplyService.runSingleTask(clonedTask, {
        credentials,
        readyInDays,
        dropOffWarehouseId: updated.selectedDropOffId,
        skipDropOffValidation: true,
        onEvent: async (result) => {
          if (result.event === 'supplyCreated') {
            supplyResult = result;
          }
          await this.sendSupplyEvent(ctx, result);
        },
      });
      await this.handleSupplySuccess(ctx, chatId, updated, clonedTask, supplyResult);
    } catch (error) {
      await this.view.updatePrompt(ctx, chatId, updated, 'Мастер завершён с ошибкой ❌');
      await ctx.reply(`❌ Ошибка при обработке: ${this.describeError(error)}`);
      await this.view.sendErrorDetails(ctx, this.extractErrorPayload(error));
      await this.notifyAdmin(ctx, 'wizard.supplyError', [this.describeError(error)]);
    }
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
      case 'clusterStart':
        await this.onClusterStart(ctx, chatId, state);
        return;
      case 'cluster':
        await this.onClusterSelect(ctx, chatId, state, rest[0]);
        return;
      case 'warehouse':
        await this.onWarehouseSelect(ctx, chatId, state, rest[0]);
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
    const state =
      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          stage: 'landing',
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
    const warehouse = state.selectedWarehouseName ?? state.selectedDropOffName ?? state.selectedWarehouseId?.toString();

    const items: SupplyWizardSupplyItem[] = task.items.map((item) => ({
      article: item.article,
      quantity: item.quantity,
      sku: item.sku,
    }));

    const entry: SupplyWizardOrderSummary = {
      id: operationId,
      arrival: arrival ?? undefined,
      warehouse: warehouse ?? undefined,
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
    const credentials = this.resolveCredentials(chatId);
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

    const hasDropOffSelection = Boolean(state.selectedDropOffId);

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: hasDropOffSelection ? 'draftWarehouseSelect' : 'dropOffSelect',
        selectedClusterId: cluster.id,
        selectedClusterName: cluster.name,
        selectedWarehouseId: hasDropOffSelection ? current.selectedWarehouseId : undefined,
        selectedWarehouseName: hasDropOffSelection ? current.selectedWarehouseName : undefined,
        draftWarehouses: hasDropOffSelection ? current.draftWarehouses : [],
        draftTimeslots: hasDropOffSelection ? current.draftTimeslots : [],
        selectedTimeslot: hasDropOffSelection ? current.selectedTimeslot : undefined,
        draftStatus: 'idle',
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
        draftError: undefined,
        tasks: (current.tasks ?? []).map((task) => ({
          ...task,
          clusterId: cluster.id,
          warehouseId: hasDropOffSelection
            ? (current.selectedWarehouseId ?? task.warehouseId ?? 0)
            : task.warehouseId,
          warehouseName: hasDropOffSelection
            ? (current.selectedWarehouseName ?? current.selectedDropOffName ?? task.warehouseName ?? `Пункт ${task.taskId}`)
            : task.warehouseName,
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
      const dropOffLabelForPrompt =
        updated.selectedDropOffName ??
        (updated.selectedDropOffId ? String(updated.selectedDropOffId) : '—');

      await this.view.updatePrompt(
        ctx,
        chatId,
        updated,
        [
          `Кластер выбран: ${cluster.name}.`,
          `Пункт сдачи: ${dropOffLabelForPrompt}.`,
          'Получаю рекомендованные склады...',
        ].join('\n'),
        this.view.withCancel(),
      );

      await this.ensureDraftCreated(ctx, chatId, updated);
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
    payload: string | undefined,
  ): Promise<void> {
    if (state.stage !== 'warehouseSelect') {
      await this.safeAnswerCbQuery(ctx, chatId, 'Используйте список складов из черновика ниже');
      return;
    }

    const warehouseId = Number(payload);
    if (!Number.isFinite(warehouseId)) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Некорректный склад');
      return;
    }

    const selectedClusterId = state.selectedClusterId;
    if (!selectedClusterId) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Сначала выберите кластер');
      return;
    }

    const clusterWarehouses = state.warehouses[selectedClusterId] ?? [];
    const warehouse = clusterWarehouses.find((item) => item.warehouse_id === warehouseId);

    if (!warehouse) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Склад не найден');
      return;
    }

    const hasDropOffSelection = Boolean(state.selectedDropOffId);

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: hasDropOffSelection ? 'draftWarehouseSelect' : 'dropOffSelect',
        selectedWarehouseId: warehouse.warehouse_id,
        selectedWarehouseName: warehouse.name,
        ...(hasDropOffSelection
          ? {}
          : {
              selectedDropOffId: undefined,
              selectedDropOffName: undefined,
            }),
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
          clusterId: (current.selectedClusterId ?? task.clusterId) ?? undefined,
          warehouseId: warehouse.warehouse_id,
          warehouseName: warehouse.name ?? task.warehouseName,
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
      const dropOffLabel =
        updated.selectedDropOffName ??
        (updated.selectedDropOffId ? String(updated.selectedDropOffId) : '—');

      await this.view.updatePrompt(
        ctx,
        chatId,
        updated,
        [
          `Склад выбран: ${warehouse.name} (${warehouse.warehouse_id}).`,
          `Пункт сдачи: ${dropOffLabel}.`
        ].join('\n'),
        this.view.withCancel(),
      );
    } else {
      await this.view.updatePrompt(
        ctx,
        chatId,
        updated,
        [
          `Склад выбран: ${warehouse.name} (${warehouse.warehouse_id}).`,
          'Выберите пункт сдачи (drop-off), где оформим поставку.',
        ].join('\n'),
        this.view.buildDropOffKeyboard(updated),
      );
    }

    if (updated.stage === 'draftWarehouseSelect' || updated.stage === 'awaitReadyDays') {
      await this.ensureDraftCreated(ctx, chatId, updated);
    }

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
        stage: hasClusterSelection ? 'draftWarehouseSelect' : 'clusterPrompt',
        selectedDropOffId: option.warehouse_id,
        selectedDropOffName: option.name,
        selectedWarehouseId: option.warehouse_id,
        selectedWarehouseName: option.name,
        draftWarehouses: hasClusterSelection ? current.draftWarehouses : [],
        draftTimeslots: hasClusterSelection ? current.draftTimeslots : [],
        selectedTimeslot: hasClusterSelection ? current.selectedTimeslot : undefined,
        draftStatus: 'idle',
        draftOperationId: undefined,
        draftId: undefined,
        draftCreatedAt: undefined,
        draftExpiresAt: undefined,
        draftError: undefined,
        tasks: (current.tasks ?? []).map((task) => ({
          ...task,
          clusterId: current.selectedClusterId ?? task.clusterId,
          warehouseId: option.warehouse_id,
          warehouseName: option.name ?? task.warehouseName ?? `Пункт ${option.warehouse_id}`,
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
      const lines = [
        `Пункт сдачи выбран: ${option.name} (${option.warehouse_id}).`,
      ];
      if (option.address) {
        lines.push(`Адрес: ${option.address}.`);
      }
      if (updated.selectedClusterName || updated.selectedClusterId) {
        lines.push(
          `Кластер: ${updated.selectedClusterName ?? updated.selectedClusterId}.`,
        );
      }
      if (updated.selectedWarehouseName || updated.selectedWarehouseId) {
        lines.push(
          `Склад: ${updated.selectedWarehouseName ?? updated.selectedWarehouseId}.`,
        );
      }
      lines.push('Получаю рекомендованные склады...');

      await this.view.updatePrompt(
        ctx,
        chatId,
        updated,
        lines.join('\n'),
        this.view.withCancel(),
      );

      await this.ensureDraftCreated(ctx, chatId, updated);
    } else {
      const lines = [
        `Пункт сдачи выбран: ${option.name} (${option.warehouse_id}).`,
      ];
      if (option.address) {
        lines.push(`Адрес: ${option.address}.`);
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
  ): Promise<void> {
    const summaryLines = this.view.describeWarehouseSelection(option, state);

    await this.notifyAdmin(ctx, 'wizard.warehouseSelected', summaryLines);

    await this.view.updatePrompt(
      ctx,
      chatId,
      state,
      [...summaryLines, '', 'Получаю доступные таймслоты...'].join('\n'),
      this.view.withCancel(),
    );

    const credentials = this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /start <CLIENT_ID> <API_KEY>.');
      return;
    }

    const draftId = state.draftId ?? this.latestDraftId;
    if (!draftId) {
      await ctx.reply('Черновик ещё не готов — подождите пару секунд, я пересоздам и повторю попытку.');
      this.resetDraftStateForRetry(chatId);
      const freshState = this.wizardStore.get(chatId);
      if (freshState) {
        await this.ensureDraftCreated(ctx, chatId, freshState);
      }
      return;
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
      return;
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
      return;
    }

    if (!limited.length) {
      await this.view.updatePrompt(
        ctx,
        chatId,
        stored,
        [
          ...summaryLines,
          '',
          'Свободных таймслотов для этого склада нет.',
          'Выберите другой склад или попробуйте позже.',
        ].join('\n'),
        this.view.buildDraftWarehouseKeyboard(stored),
      );
      return;
    }

    const selectedTimeslot = stored.selectedTimeslot;

    const promptLines = [
      ...summaryLines,
      '',
      'Доступные таймслоты:',
      ...this.view.formatTimeslotSummary(limited),
    ];
    if (truncated) {
      promptLines.push(`… Показаны первые ${limited.length} из ${timeslotOptions.length} вариантов.`);
    }
    if (selectedTimeslot) {
      promptLines.push('', `Выбрали первый таймслот: ${selectedTimeslot.label}.`);
    }
    promptLines.push('', 'Начинаю оформление поставки...');

    await this.view.updatePrompt(
      ctx,
      chatId,
      stored,
      promptLines.join('\n'),
      this.view.withCancel(),
    );

    if (selectedTimeslot) {
      await this.notifyAdmin(ctx, 'wizard.timeslotSelected', [`timeslot: ${selectedTimeslot.label}`]);
    }

    await this.startSupplyProcessing(ctx, chatId, stored, 0);
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

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      const tasks = (current.tasks ?? []).map((task) => ({
        ...task,
        selectedTimeslot: option.data,
      }));

      return {
        ...current,
        stage: 'awaitReadyDays',
        selectedTimeslot: option,
        draftTimeslots: current.draftTimeslots,
        tasks,
      };
    });

    if (!updated) {
      await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
      return;
    }

    await this.notifyAdmin(ctx, 'wizard.timeslotSelected', [`timeslot: ${option.label}`]);

    await this.safeAnswerCbQuery(ctx, chatId, 'Таймслот выбран');
    await this.startSupplyProcessing(ctx, chatId, updated, 0);
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
    const from = this.toOzonIso(now);
    const to = this.toOzonIso(this.addUtcDays(now, 28));
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
    const state = this.wizardStore.get(chatId);
    if (!state) {
      return;
    }

    await this.notifyAdmin(ctx, 'wizard.callbackExpired', [`stage: ${state.stage}`]);

    const knownOperationId = this.resolveKnownDraftOperationId(state);
    const knownDraftId = state.draftId ?? this.latestDraftId;

    this.resetDraftStateForRetry(chatId);
    let freshState = this.wizardStore.get(chatId);

    if (freshState && knownOperationId) {
      this.latestDraftOperationId = knownOperationId;
      if (knownDraftId) {
        this.latestDraftId = knownDraftId;
      }

      const restored = this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          draftOperationId: knownOperationId,
          draftId: knownDraftId ?? current.draftId,
          tasks: (current.tasks ?? []).map((task) => ({
            ...task,
            draftOperationId: knownOperationId,
            draftId: knownDraftId ?? task.draftId,
          })),
        };
      });

      freshState = restored ?? this.wizardStore.get(chatId);
    }

    if (freshState) {
      await this.ensureDraftCreated(ctx, chatId, freshState);
      await this.view.updatePrompt(
        ctx,
        chatId,
        freshState,
        '⚠️ Выберите склад доставки',
        this.view.withCancel(),
      );
    } else {
      await this.view.updatePrompt(
        ctx,
        chatId,
        state,
        '⚠️ Выберите склад доставки',
        this.view.withCancel(),
      );
    }
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

    const credentials = this.resolveCredentials(chatId);
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

  private resolveCredentials(chatId: string): OzonCredentials | undefined {
    const stored = this.credentialsStore.get(chatId);
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
