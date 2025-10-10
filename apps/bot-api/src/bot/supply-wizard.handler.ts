import axios from 'axios';
import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';

import { OzonApiService, OzonCluster, OzonCredentials, OzonAvailableWarehouse } from '../config/ozon-api.service';
import { OzonSheetService } from '../ozon/ozon-sheet.service';
import { OzonSupplyService } from '../ozon/ozon-supply.service';
import { OzonSupplyTask } from '../ozon/ozon-supply.types';
import { UserCredentialsStore } from './user-credentials.store';
import {
  SupplyWizardStore,
  SupplyWizardState,
  SupplyWizardClusterOption,
  SupplyWizardWarehouseOption,
  SupplyWizardDropOffOption,
} from './supply-wizard.store';
import { underline } from "telegraf/format";

@Injectable()
export class SupplyWizardHandler {
  private readonly logger = new Logger(SupplyWizardHandler.name);

  constructor(
    private readonly credentialsStore: UserCredentialsStore,
    private readonly sheetService: OzonSheetService,
    private readonly supplyService: OzonSupplyService,
    private readonly ozonApi: OzonApiService,
    private readonly wizardStore: SupplyWizardStore,
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

    const credentials = this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /ozon_auth <CLIENT_ID> <API_KEY>.');
      return;
    }

    try {
      const state = this.wizardStore.start(chatId, {
        clusters: [],
        warehouses: {},
        dropOffs: [],
      });
      const prompt = await ctx.reply(
        [
          'Пришлите Excel-файл или ссылку на Google Sheets со списком позиций.',
          'Формат: первый лист, колонки «Артикул» и «Количество».',
        ].join('\n'),
      );

      this.wizardStore.update(chatId, (current) => {
        if (!current) return undefined;
        return { ...state, promptMessageId: (prompt as any)?.message_id ?? state.promptMessageId };
      });
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
      await ctx.reply('Сначала запустите мастер командой /ozon_supply.');
      return;
    }

    const document = (ctx.message as any)?.document;
    if (!document) return;

    if (!/\.xlsx$/i.test(document.file_name ?? '')) {
      await ctx.reply('Принимаю только файлы .xlsx.');
      return;
    }

    try {
      await ctx.reply('Получаю файл, подождите...');
      const buffer = await this.downloadTelegramFile(ctx, document.file_id);
      await this.processSpreadsheet(ctx, chatId, state, { buffer, label: document.file_name ?? 'файл' });
    } catch (error) {
      this.logger.error(`handleDocument failed: ${this.describeError(error)}`);
      await ctx.reply(`❌ Не удалось обработать файл: ${this.describeError(error)}`);
      await ctx.reply('Пришлите Excel-файл (Артикул, Количество) повторно.');
    }
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
      await ctx.reply('Запустите мастер командой /ozon_supply и загрузите файл.');
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      await ctx.reply('Пришлите ссылку на Google Sheets или документ .xlsx.');
      return;
    }

    try {
      await ctx.reply('Загружаю таблицу, подождите...');
      await this.processSpreadsheet(ctx, chatId, state, { spreadsheet: trimmed, label: trimmed });
    } catch (error) {
      this.logger.error(`handleSpreadsheetLink failed: ${this.describeError(error)}`);
      await ctx.reply(`❌ Не удалось обработать таблицу: ${this.describeError(error)}`);
    }
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
      await ctx.reply('🔐 Сначала сохраните ключи через /ozon_auth.');
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
    clonedTask.clusterId = state.selectedClusterId;
    clonedTask.city = state.selectedClusterName ?? '';
    clonedTask.warehouseId = state.selectedWarehouseId;
    clonedTask.warehouseName = state.selectedWarehouseName ?? '';

    await this.updatePrompt(ctx, chatId, updated, [
      `Кластер: ${state.selectedClusterName ?? '—'}`,
      `Склад: ${state.selectedWarehouseName ?? state.selectedWarehouseId ?? '—'}`,
      `Пункт сдачи: ${state.selectedDropOffName ?? state.selectedDropOffId ?? '—'}`,
      `Готовность к отгрузке через: ${readyInDays} дн.`,
      '',
      'Запускаю создание черновика и поиск слотов...'
    ].join('\n'));

    try {
      await this.supplyService.runSingleTask(clonedTask, {
        credentials,
        readyInDays,
        dropOffWarehouseId: state.selectedDropOffId,
        onEvent: async (result) => this.sendSupplyEvent(ctx, result),
      });
      await this.updatePrompt(ctx, chatId, updated, 'Мастер завершён ✅');
      await ctx.reply('✅ Поставка создана.');
    } catch (error) {
      await this.updatePrompt(ctx, chatId, updated, 'Мастер завершён с ошибкой ❌');
      await ctx.reply(`❌ Ошибка при обработке: ${this.describeError(error)}`);
      await this.safeSendErrorDetails(ctx, error);
    } finally {
      this.wizardStore.clear(chatId);
    }
  }

  async handleCallback(ctx: Context, data: string): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) return;

    const state = this.wizardStore.get(chatId);
    if (!state) {
      await ctx.answerCbQuery('Мастер не запущен');
      return;
    }

    const [, action, payload] = data.split(':');

    switch (action) {
      case 'clusterStart':
        await this.onClusterStart(ctx, chatId, state);
        return;
      case 'cluster':
        await this.onClusterSelect(ctx, chatId, state, payload);
        return;
      case 'warehouse':
        await this.onWarehouseSelect(ctx, chatId, state, payload);
        return;
      case 'dropoff':
        await this.onDropOffSelect(ctx, chatId, state, payload);
        return;
      case 'cancel':
        this.wizardStore.clear(chatId);
        await ctx.answerCbQuery('Мастер отменён');
        await this.updatePrompt(ctx, chatId, state, 'Мастер отменён.');
        return;
      default:
        await ctx.answerCbQuery('Неизвестное действие');
        return;
    }
  }

  private async processSpreadsheet(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    source: { buffer?: Buffer; spreadsheet?: string; label: string },
  ): Promise<void> {
    const credentials = this.resolveCredentials(chatId);
    if (!credentials) {
      await ctx.reply('🔐 Сначала сохраните ключи через /ozon_auth.');
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

    await this.resolveSkus(clonedTasks[0], credentials);

    const summary = this.formatItemsSummary(clonedTasks[0]);

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

    const options = this.buildOptions(clusters);

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: 'clusterPrompt',
        spreadsheet: source.label,
        tasks: clonedTasks,
        selectedTaskId: clonedTasks[0]?.taskId,
        clusters: options.clusters,
        warehouses: options.warehouses,
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

    await ctx.reply(summary, {
      reply_markup: {
        inline_keyboard: this.buildClusterStartKeyboard(),
      } as any,
    });

    await this.updatePrompt(
      ctx,
      chatId,
      updated,
      'Файл обработан. Проверьте список товаров и нажмите «Выбрать кластер и склад», чтобы продолжить.',
      this.withCancel(),
    );
  }

  private async onClusterStart(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
  ): Promise<void> {
    if (state.stage !== 'clusterPrompt') {
      await ctx.answerCbQuery('Выбор недоступен.');
      return;
    }

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: 'clusterSelect',
        selectedClusterId: undefined,
        selectedClusterName: undefined,
        selectedWarehouseId: undefined,
        selectedWarehouseName: undefined,
        selectedDropOffId: undefined,
        selectedDropOffName: undefined,
      };
    });

    if (!updated) {
      await ctx.answerCbQuery('Мастер закрыт');
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

    await this.updatePrompt(
      ctx,
      chatId,
      updated,
      'Выберите кластер, в который планируете вести поставку.',
      this.buildClusterKeyboard(updated),
    );

    await ctx.answerCbQuery('Продолжаем');
  }

  private async onClusterSelect(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    payload: string | undefined,
  ): Promise<void> {

    if (state.stage !== 'clusterSelect') {
      await ctx.answerCbQuery('Сначала загрузите файл');
      return;
    }

    const clusterId = Number(payload);
    if (!Number.isFinite(clusterId)) {
      await ctx.answerCbQuery('Некорректный кластер');
      return;
    }

    const cluster = state.clusters.find((item) => item.id === clusterId);
    if (!cluster) {
      await ctx.answerCbQuery('Кластер не найден');
      return;
    }

    const warehouses = state.warehouses[clusterId] ?? [];
    if (!warehouses.length) {
      await ctx.answerCbQuery('В кластере нет складов');
      return;
    }

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: 'warehouseSelect',
        selectedClusterId: cluster.id,
        selectedClusterName: cluster.name,
        selectedWarehouseId: undefined,
        selectedWarehouseName: undefined,
        selectedDropOffId: undefined,
        selectedDropOffName: undefined,
      };
    });

    if (!updated) {
      await ctx.answerCbQuery('Мастер закрыт');
      return;
    }

    await this.updatePrompt(
      ctx,
      chatId,
      updated,
      [
        `Кластер выбран: ${cluster.name}.`,
        'Выберите склад обработки заказа (куда везём товар).',
      ].join('\n'),
      this.buildWarehouseKeyboard(updated, cluster.id),
    );

    await ctx.answerCbQuery('Кластер выбран');
  }

  private async onWarehouseSelect(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    payload: string | undefined,
  ): Promise<void> {
    if (state.stage !== 'warehouseSelect') {
      await ctx.answerCbQuery('Сначала выберите кластер');
      return;
    }

    const warehouseId = Number(payload);
    if (!Number.isFinite(warehouseId)) {
      await ctx.answerCbQuery('Некорректный склад');
      return;
    }

    const selectedClusterId = state.selectedClusterId;
    if (!selectedClusterId) {
      await ctx.answerCbQuery('Сначала выберите кластер');
      return;
    }

    const clusterWarehouses = state.warehouses[selectedClusterId] ?? [];
    const warehouse = clusterWarehouses.find((item) => item.warehouse_id === warehouseId);

    if (!warehouse) {
      await ctx.answerCbQuery('Склад не найден');
      return;
    }

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: 'dropOffSelect',
        selectedWarehouseId: warehouse.warehouse_id,
        selectedWarehouseName: warehouse.name,
        selectedDropOffId: undefined,
        selectedDropOffName: undefined,
      };
    });

    if (!updated) {
      await ctx.answerCbQuery('Мастер закрыт');
      return;
    }

    await this.updatePrompt(
      ctx,
      chatId,
      updated,
      [
        `Склад выбран: ${warehouse.name} (${warehouse.warehouse_id}).`,
        'Выберите пункт сдачи (drop-off), где оформим поставку.',
      ].join('\n'),
      this.buildDropOffKeyboard(updated),
    );

    await ctx.answerCbQuery('Склад выбран');
  }

  private async onDropOffSelect(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    payload: string | undefined,
  ): Promise<void> {
    if (state.stage !== 'dropOffSelect') {
      await ctx.answerCbQuery('Сначала выберите склад');
      return;
    }

    const dropOffId = Number(payload);
    if (!Number.isFinite(dropOffId)) {
      await ctx.answerCbQuery('Некорректный пункт сдачи');
      return;
    }

    const option = state.dropOffs.find((item) => item.id === dropOffId);
    if (!option) {
      await ctx.answerCbQuery('Пункт сдачи не найден');
      return;
    }

    const updated = this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        stage: 'awaitReadyDays',
        selectedDropOffId: option.id,
        selectedDropOffName: option.name,
      };
    });

    if (!updated) {
      await ctx.answerCbQuery('Мастер закрыт');
      return;
    }

    await this.updatePrompt(
      ctx,
      chatId,
      updated,
      [
        `Пункт сдачи выбран: ${option.name} (${option.id}).`,
        'Укажите, через сколько дней готовы к отгрузке (число).',
      ].join('\n'),
      this.withCancel(),
    );

    await ctx.answerCbQuery('Пункт сдачи выбран');
  }

  private buildOptions(
    clusters: OzonCluster[]
  ): {
    clusters: SupplyWizardClusterOption[];
    warehouses: Record<number, SupplyWizardWarehouseOption[]>;
  } {
    const clusterOptions: SupplyWizardClusterOption[] = [];
    const clusterWarehouses = new Map<number, SupplyWizardWarehouseOption[]>();

    for (const cluster of clusters) {
      if (typeof cluster.id !== 'number') continue;
      const clusterId = Number(cluster.id);
      const clusterName = cluster.name?.trim() || `Кластер ${clusterId}`;

      const rawWarehouses: SupplyWizardWarehouseOption[] = [];
      for (const logistic of cluster.logistic_clusters ?? []) {
        for (const warehouse of logistic.warehouses ?? []) {
          if (typeof warehouse?.warehouse_id !== 'number') continue;
          const warehouseId = Number(warehouse.warehouse_id);
          if (!Number.isFinite(warehouseId)) continue;

          rawWarehouses.push({
            warehouse_id: warehouseId,
            name: warehouse.name?.trim() || `Склад ${warehouseId}`
          });
        }
      }

      const uniqueWarehouses = this.deduplicateWarehouseOptions(rawWarehouses);
      clusterWarehouses.set(clusterId, uniqueWarehouses);

      clusterOptions.push({
        id: clusterId,
        name: clusterName,
        logistic_clusters: {
          warehouses: uniqueWarehouses.map((item) => ({ ...item })),
        },
      });
    }

    const sortedClusters = clusterOptions.sort((a, b) =>
      a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }),
    );

    // const sortedDropOffs = [...dropOffs].sort((a, b) =>
    //   a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }),
    // );

    const warehousesByCluster = Object.fromEntries(
      clusterWarehouses.entries(),
    ) as Record<number, SupplyWizardWarehouseOption[]>;

    return {
      clusters: sortedClusters,
      warehouses: warehousesByCluster
    };
  }

  private extractDropOffOptions(raw: OzonAvailableWarehouse[]): SupplyWizardDropOffOption[] {
    const map = new Map<number, SupplyWizardDropOffOption>();
    for (const warehouse of raw ?? []) {
      if (typeof warehouse?.warehouse_id !== 'number') continue;
      const id = Number(warehouse.warehouse_id);
      if (!Number.isFinite(id)) continue;
      if (map.has(id)) continue;
      map.set(id, {
        id,
        name: warehouse.name?.trim() || `Drop-off ${id}`,
      });
    }
    return [...map.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }),
    );
  }

  private buildClusterStartKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
    return [[{ text: 'Выбрать кластер и склад', callback_data: 'wizard:clusterStart' }]];
  }

  private deduplicateWarehouseOptions(
    options: SupplyWizardWarehouseOption[],
  ): SupplyWizardWarehouseOption[] {
    const map = new Map<number, SupplyWizardWarehouseOption>();
    for (const option of options) {
      if (!map.has(option.warehouse_id)) {
        map.set(option.warehouse_id, { ...option });
      }
    }
    return [...map.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }),
    );
  }

  private buildClusterKeyboard(state: SupplyWizardState): Array<Array<{ text: string; callback_data: string }>> {
    const rows = state.clusters.map((cluster) => [
      {
        text: cluster.name,
        callback_data: `wizard:cluster:${cluster.id}`,
      },
    ]);

    return this.withCancel(rows);
  }

  private buildWarehouseKeyboard(
    state: SupplyWizardState,
    clusterId: number,
  ): Array<Array<{ text: string; callback_data: string }>> {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    const warehouses = state.warehouses[clusterId] ?? [];
    for (const warehouse of warehouses) {
      rows.push([
        {
          text: `${warehouse.name} (${warehouse.warehouse_id})`,
          callback_data: `wizard:warehouse:${warehouse.warehouse_id}`,
        },
      ]);
    }

    return this.withCancel(rows);
  }

  private buildDropOffKeyboard(
    state: SupplyWizardState,
  ): Array<Array<{ text: string; callback_data: string }>> {
    const rows = state.dropOffs.map((option) => [
      {
        text: `${option.name} (${option.id})`,
        callback_data: `wizard:dropoff:${option.id}`,
      },
    ]);
    return this.withCancel(rows);
  }

  private withCancel(
    rows: Array<Array<{ text: string; callback_data: string }>> = [],
  ): Array<Array<{ text: string; callback_data: string }>> {
    return [...rows, [{ text: 'Отмена', callback_data: 'wizard:cancel' }]];
  }

  private async updatePrompt(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    text: string,
    keyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    const rawChatId = (ctx.callbackQuery as any)?.message?.chat?.id ?? chatId;
    const messageId = state.promptMessageId;
    const replyMarkup = keyboard ? { inline_keyboard: keyboard } : undefined;

    if (messageId) {
      try {
        await ctx.telegram.editMessageText(rawChatId, messageId, undefined, text, {
          reply_markup: replyMarkup,
        });
        return;
      } catch (error) {
        this.logger.debug(`editMessageText failed: ${this.describeError(error)}`);
      }
    }

    const sent = await ctx.reply(text, { reply_markup: replyMarkup as any });
    this.wizardStore.update(chatId, (current) => {
      if (!current) return undefined;
      return { ...current, promptMessageId: (sent as any)?.message_id ?? current.promptMessageId };
    });
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

  private formatItemsSummary(task: OzonSupplyTask): string {
    const lines = task.items.map((item) => `• ${item.article} → SKU ${item.sku} × ${item.quantity}`);

    return ['Товары из файла:', ...lines, '', 'Нажмите кнопку ниже, чтобы выбрать кластер и склад.'].join('\n');
  }

  private async sendSupplyEvent(ctx: Context, result: { task: OzonSupplyTask; event: string; message?: string }): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) return;

    const text = this.formatSupplyEvent(result);
    if (!text) return;

    await ctx.telegram.sendMessage(chatId, text);
  }

  private formatSupplyEvent(result: { task: OzonSupplyTask; event: string; message?: string }): string | undefined {
    const prefix = `[${result.task.taskId}]`;
    switch (result.event) {
      case 'draftCreated':
        return `${prefix} Черновик создан. ${result.message ?? ''}`.trim();
      case 'draftValid':
        return `${prefix} Используем существующий черновик. ${result.message ?? ''}`.trim();
      case 'draftExpired':
        return `${prefix} Черновик устарел, создаём заново.`;
      case 'draftInvalid':
        return `${prefix} Черновик невалидный, пересоздаём.`;
      case 'draftError':
        return `${prefix} Ошибка статуса черновика.${result.message ? ` ${result.message}` : ''}`;
      case 'timeslotMissing':
        return `${prefix} Свободных таймслотов нет.`;
      case 'supplyCreated':
        return `${prefix} ✅ Поставка создана. ${result.message ?? ''}`.trim();
      case 'supplyStatus':
        return `${prefix} ${result.message ?? 'Статус поставки обновлён.'}`.trim();
      case 'noCredentials':
      case 'error':
        return `${prefix} ❌ ${result.message ?? 'Ошибка'}`;
      default:
        return result.message ? `${prefix} ${result.message}` : undefined;
    }
  }

  private async safeSendErrorDetails(ctx: Context, error: unknown): Promise<void> {
    const payload = this.extractErrorPayload(error);
    if (!payload) return;

    const lines = Array.isArray(payload) ? payload : payload.split(/\r?\n/);
    await ctx.reply(['Детали ошибки:', '```', ...lines, '```'].join('\n'), {
      parse_mode: 'Markdown',
    });
  }

  private extractChatId(ctx: Context): string | undefined {
    const chatId = (ctx.chat as any)?.id;
    return typeof chatId === 'undefined' || chatId === null ? undefined : String(chatId);
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
