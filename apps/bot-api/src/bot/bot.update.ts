import { Command, Ctx, Hears, Help, Message, On, Start, Update } from 'nestjs-telegraf';
import { Logger } from '@nestjs/common';
import { Context } from 'telegraf';

import { OzonApiService, OzonCredentials, OzonCluster } from '../config/ozon-api.service';
import { OzonSupplyService } from '../ozon/ozon-supply.service';
import { OzonSupplyProcessResult, OzonSupplyTask } from '../ozon/ozon-supply.types';
import { BotSessionStore, ClusterOption, FlowState } from './bot-session.store';
import { UserCredentialsStore } from './user-credentials.store';

@Update()
export class BotUpdate {
  private readonly logger = new Logger(BotUpdate.name);
  private readonly helpMessage = [
    'Привет! Я бот, который помогает автоматизировать поставки Ozon.',
    'Доступные команды:',
    ' /start — приветствие и главное меню',
    ' /help — показать эту подсказку',
    ' /ping — проверка доступности (кнопка «Проверить связь»)',
    ' /id — показать chat_id и user_id',
    ' /ozon_auth <CLIENT_ID> <API_KEY> — сохранить ключи',
    ' /ozon_clear — удалить сохранённые ключи',
    ' /ozon_run [ссылка] — запуск цикла поиска таймслотов и создание поставок (можно указать ссылку на конкретный файл)',
    ' /ozon_load <ссылка> — загрузить шаблон, выбрать кластеры и запустить обработку',
    ' /ozon_preview <ссылка> — показать задачи и товары из таблицы',
    ' /ozon_keys — показать сохранённые ключи (значения маскированы)',
    ' /ozon_clusters — вывести список доступных кластеров и складов',
    '',
    'Если ключей нет — нажми «Ввести ключи» в меню.',
  ].join('\n');

  constructor(
    private readonly ozon: OzonApiService,
    private readonly supplyService: OzonSupplyService,
    private readonly credentialsStore: UserCredentialsStore,
    private readonly sessionStore: BotSessionStore,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    const hasCredentials = chatId ? this.credentialsStore.has(chatId) : false;

    const intro = hasCredentials
      ? 'Ключи найдены. Выберите действие:'
      : 'Сначала введите Client ID и API Key Ozon — используйте кнопку ниже или команду /ozon_auth.';

    await ctx.reply(intro, {
      reply_markup: {
        inline_keyboard: this.buildMenu(hasCredentials, chatId),
      },
    });
  }

  @Help()
  async onHelp(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(this.helpMessage);
  }

  @Command('ping')
  async onPing(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply('pong 🏓');
  }

  @Command('id')
  async onId(@Ctx() ctx: Context): Promise<void> {
    const chatId = (ctx.chat as any)?.id;
    const userId = (ctx.from as any)?.id;
    await ctx.reply(`chat_id: ${chatId}\nuser_id: ${userId}`);
  }

  @Command('ozon_auth')
  async onOzonAuth(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
      return;
    }

    const args = this.parseCommandArgs(ctx);
    if (args.length < 2) {
      await ctx.reply('Использование: /ozon_auth <CLIENT_ID> <API_KEY>');
      return;
    }

    const [clientId, apiKey] = args;
    const credentials: OzonCredentials = { clientId, apiKey };

    this.credentialsStore.set(chatId, credentials);

    await ctx.reply(
      [
        '✅ Ключи сохранены.',
        'Чтобы убедиться, что всё на месте, используйте `/ozon_keys` или сразу запускайте `/ozon_run`.',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );

    await this.prefetchClusters(ctx, chatId, credentials);
  }

  @Command('ozon_clear')
  async onOzonClear(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
      return;
    }

    if (!this.credentialsStore.has(chatId)) {
      await ctx.reply('Сохранённых ключей нет.');
      return;
    }

    this.credentialsStore.clear(chatId);
    await ctx.reply('✅ Ключи удалены из памяти бота (RAM).');
  }

  @Command('ozon_keys')
  async onOzonKeys(@Ctx() ctx: Context): Promise<void> {
    const entries = this.credentialsStore.entries();
    if (!entries.length) {
      await ctx.reply('Хранилище пустое. Добавьте ключи через /ozon_auth.');
      return;
    }

    const lines = entries.map(({ chatId, credentials }) => {
      const updated = credentials.verifiedAt.toISOString();
      return `• chat_id: ${chatId}, client_id: ${this.maskValue(credentials.clientId)}, api_key: ${this.maskValue(credentials.apiKey)}, updated: ${updated}`;
    });

    await this.replyLines(ctx, ['Сохранённые ключи (маскированы):', ...lines]);
  }

  @Command('ozon_clusters')
  async onOzonClusters(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    const stored = chatId ? this.credentialsStore.get(chatId) : undefined;
    const hasEnv = await this.hasEnvCredentials();

    if (!stored && !hasEnv) {
      await ctx.reply(
        'Сначала сохраните ключи через /ozon_auth <CLIENT_ID> <API_KEY> или задайте переменные .env.',
      );
      return;
    }

    try {
      const clusters = await this.ozon.listClusters({}, stored ?? undefined);
      if (!clusters.length) {
        await ctx.reply('Кластеры не найдены.');
        return;
      }

      this.updateStoredClusters(chatId, clusters);

      const lines = clusters.map((cluster) => {
        const warehouses = (cluster.logistic_clusters ?? [])
          .flatMap((lc) => lc.warehouses ?? [])
          .map((wh) => wh.name)
          .filter(Boolean)
          .slice(0, 5);
        const suffix = warehouses.length
          ? ` — склады: ${warehouses.join(', ')}${
              (cluster.logistic_clusters ?? [])
                .flatMap((lc) => lc.warehouses ?? []).length > warehouses.length
                ? ', …'
                : ''
            }`
          : '';
        return `• ${cluster.name ?? 'Без названия'} (ID: ${cluster.id})${suffix}`;
      });

      await this.replyLines(ctx, ['Доступные кластеры:', ...lines]);
    } catch (error) {
      await ctx.reply(`❌ Не удалось получить список кластеров: ${this.formatError(error)}`);
      await this.safeSendErrorPayload(ctx, error);
    }
  }

  @Command('ozon_run')
  async onOzonRun(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Попробуйте в приватном диалоге с ботом.');
      return;
    }

    const args = this.parseCommandArgs(ctx);
    const spreadsheetOverride = args[0];

    const storedCreds = this.credentialsStore.get(chatId);
    const hasEnv = await this.hasEnvCredentials();
    if (!storedCreds && !hasEnv) {
      await ctx.reply(
        '🔐 Сначала задайте ключи: используйте /ozon_auth <CLIENT_ID> <API_KEY> или заполните переменные .env.',
      );
      return;
    }

    const credentials = storedCreds ?? undefined;
    const credsSource = storedCreds ? 'chat' : 'env';
    const sheetMsg = spreadsheetOverride ? `, таблица: ${spreadsheetOverride}` : '';

    if (!spreadsheetOverride && !this.supplyService.hasDefaultSpreadsheet()) {
      await ctx.reply(
        'Не указан файл с товарами. Передайте ссылку командой `/ozon_run <ссылка>` либо задайте `OZON_SUPPLY_SPREADSHEET_ID` в .env.',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    await ctx.reply(
      `Запускаю обработку задач (ключи: ${credsSource}${sheetMsg}). Это может занять время.`,
    );

    try {
      const tasks = await this.supplyService.prepareTasks({
        credentials,
        spreadsheet: spreadsheetOverride,
      });
      if (!tasks.size) {
        await ctx.reply('Нет активных задач в таблице.');
        return;
      }

      const clusterLines = this.supplyService.getClustersOverview(tasks);
      this.updateStoredClusters(chatId, this.supplyService.getCachedClusters());
      if (clusterLines.length) {
        await this.replyLines(ctx, ['Активные кластеры/склады:', ...clusterLines]);
      }

      await ctx.reply(`Загружено задач: ${tasks.size}. Начинаю опрос.`);

      await this.supplyService.processTasks(tasks, {
        credentials,
        onEvent: async (result) => this.sendSupplyEvent(ctx, result),
        delayBetweenCallsMs: this.supplyService.getPollIntervalMs(),
      });

      await ctx.reply('✅ Все задачи обработаны.');
    } catch (error) {
      await ctx.reply(`❌ Ошибка при запуске обработки: ${this.formatError(error)}`);
      await this.safeSendErrorPayload(ctx, error);
    }
  }

  @Command('ozon_load')
  async onOzonLoad(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
      return;
    }

    const args = this.parseCommandArgs(ctx);
    if (!args.length) {
      await ctx.reply('Использование: /ozon_load <ссылка или ID Google Sheets>');
      return;
    }

    const spreadsheet = args[0];
    const storedCreds = this.credentialsStore.get(chatId);
    const hasEnv = await this.hasEnvCredentials();

    if (!storedCreds && !hasEnv) {
      await ctx.reply(
        '🔐 Сначала сохраните ключи через /ozon_auth <CLIENT_ID> <API_KEY> или задайте переменные .env.',
      );
      return;
    }

    await ctx.reply('Загружаю шаблон, подождите пару секунд...');

    try {
      const tasks = await this.supplyService.prepareTasks({
        credentials: storedCreds ?? undefined,
        spreadsheet,
      });

      const { validTasks, clusterOptions, missingCluster, missingWarehouse } = this.prepareFlowFromTasks(
        tasks,
        this.supplyService.getCachedClusters(),
      );

      if (!validTasks.length) {
        await ctx.reply(
          'В таблице нет задач с определёнными кластером и складом. Проверьте заполнение колонок city и warehouse_name.',
        );
        return;
      }

      const state = this.sessionStore.setFlowState(chatId, {
        spreadsheet,
        tasks: this.cloneTasks(validTasks),
        clusterOptions,
        selectedClusterIds: new Set<number>(),
        selectionMessageId: undefined,
      });

      const view = this.buildClusterSelectionView(state);
      const sent = await ctx.reply(view.text, {
        reply_markup: { inline_keyboard: view.keyboard },
      });

      this.sessionStore.updateFlowState(chatId, (current) => {
        if (!current) return undefined;
        return { ...current, selectionMessageId: (sent as any)?.message_id ?? current.selectionMessageId };
      });

      await this.reportSkippedTasks(ctx, missingCluster, missingWarehouse);
    } catch (error) {
      await ctx.reply(`❌ Ошибка при загрузке шаблона: ${this.formatError(error)}`);
      await this.safeSendErrorPayload(ctx, error);
    }
  }

  private async safeSendErrorPayload(ctx: Context, error: unknown): Promise<void> {
    const payload = this.extractErrorPayload(error);
    if (!payload) {
      return;
    }

    const payloadLines = payload.split(/\r?\n/);
    await this.replyLines(ctx, ['Детали ошибки:', '```', ...payloadLines, '```'], {
      parse_mode: 'Markdown',
    }, 'error-details');
  }

  @Command('ozon_preview')
  async onOzonPreview(@Ctx() ctx: Context): Promise<void> {
    const args = this.parseCommandArgs(ctx);
    if (!args.length) {
      await ctx.reply('Использование: /ozon_preview <ссылка или ID Google Sheets>');
      return;
    }

    const spreadsheet = args[0];
    const chatId = this.extractChatId(ctx);
    const storedCreds = chatId ? this.credentialsStore.get(chatId) : undefined;
    const hasEnv = await this.hasEnvCredentials();

    if (!storedCreds && !hasEnv) {
      await ctx.reply(
        '🔐 Для чтения данных нужны ключи Ozon. Сначала выполните /ozon_auth или задайте переменные .env.',
      );
      return;
    }

    await ctx.reply('Загружаю таблицу, это займёт пару секунд...');

    try {
      const tasks = await this.supplyService.prepareTasks({
        credentials: storedCreds ?? undefined,
        spreadsheet,
      });

      if (!tasks.size) {
        await ctx.reply('В таблице не найдено задач.');
        return;
      }

      const clusterLines = this.supplyService.getClustersOverview(tasks);
      const messages = this.formatTasksPreview(tasks, clusterLines);
      for (const message of messages) {
        await ctx.reply(message, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      await ctx.reply(`❌ Не удалось распарсить таблицу: ${this.formatError(error)}`);
      await this.safeSendErrorPayload(ctx, error);
    }
  }

  @On('callback_query')
  async onCallback(@Ctx() ctx: Context): Promise<void> {
    const data = (ctx.callbackQuery as any)?.data as string | undefined;
    if (!data) return;

    if (data.startsWith('flow:')) {
      await this.handleFlowCallback(ctx, data);
      return;
    }

    switch (data) {
      case 'action:enter_creds':
        await ctx.answerCbQuery();
        await ctx.reply(
          'Отправьте команду `/ozon_auth <CLIENT_ID> <API_KEY>`\n' +
            'Пример: `/ozon_auth 123456 abcdef...`',
          { parse_mode: 'Markdown' },
        );
        break;
      case 'action:run':
        await ctx.answerCbQuery();
        if (!this.credentialsStore.has(this.extractChatId(ctx) ?? '')) {
          await ctx.reply('Сначала сохраните ключи через /ozon_auth <CLIENT_ID> <API_KEY>.');
          break;
        }
        await this.onOzonRun(ctx);
        break;
      case 'action:keys':
        await ctx.answerCbQuery();
        await this.onOzonKeys(ctx);
        break;
      case 'action:clusters':
        await ctx.answerCbQuery();
        await this.onOzonClusters(ctx);
        break;
      case 'action:load':
        await ctx.answerCbQuery();
        await ctx.reply(
          'Отправьте ссылку на Google Sheets командой `/ozon_load <ссылка>` — бот загрузит шаблон и предложит выбрать кластеры.',
          { parse_mode: 'Markdown' },
        );
        break;
      case 'action:ping':
        await ctx.answerCbQuery('pong 🏓');
        await ctx.reply('pong 🏓');
        break;
      case 'action:help':
        await ctx.answerCbQuery();
        await this.onHelp(ctx);
        break;
      default:
        await ctx.answerCbQuery('Неизвестное действие');
        break;
    }
  }

  private async handleFlowCallback(ctx: Context, rawData: string): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.answerCbQuery('Не удалось определить чат');
      return;
    }

    const messageId = (ctx.callbackQuery as any)?.message?.message_id;
    const action = rawData.split(':')[1];
    if (!action) {
      await ctx.answerCbQuery('Некорректное действие');
      return;
    }

    switch (action) {
      case 'cluster': {
        const payload = rawData.split(':')[2];
        const clusterId = Number(payload);
        if (!payload || Number.isNaN(clusterId)) {
          await ctx.answerCbQuery('Некорректный кластер');
          return;
        }

        const updated = this.sessionStore.updateFlowState(chatId, (current) => {
          if (!current) return undefined;
          const selected = new Set<number>(current.selectedClusterIds);
          if (selected.has(clusterId)) {
            selected.delete(clusterId);
          } else {
            selected.add(clusterId);
          }
          return { ...current, selectedClusterIds: selected, selectionMessageId: messageId ?? current.selectionMessageId };
        });

        if (!updated) {
          await ctx.answerCbQuery('Сессия устарела');
          return;
        }

        await this.refreshClusterSelectionMessage(ctx, chatId, updated, messageId);
        await ctx.answerCbQuery(
          updated.selectedClusterIds.has(clusterId) ? 'Кластер добавлен' : 'Кластер исключён',
        );
        return;
      }
      case 'select_all': {
        const updated = this.sessionStore.updateFlowState(chatId, (current) => {
          if (!current) return undefined;
          const all = current.clusterOptions.map((option) => option.id);
          return {
            ...current,
            selectedClusterIds: new Set<number>(all),
            selectionMessageId: messageId ?? current.selectionMessageId,
          };
        });

        if (!updated) {
          await ctx.answerCbQuery('Сессия устарела');
          return;
        }

        await this.refreshClusterSelectionMessage(ctx, chatId, updated, messageId);
        await ctx.answerCbQuery('Выбраны все кластеры');
        return;
      }
      case 'clear': {
        const updated = this.sessionStore.updateFlowState(chatId, (current) => {
          if (!current) return undefined;
          return {
            ...current,
            selectedClusterIds: new Set<number>(),
            selectionMessageId: messageId ?? current.selectionMessageId,
          };
        });

        if (!updated) {
          await ctx.answerCbQuery('Сессия устарела');
          return;
        }

        await this.refreshClusterSelectionMessage(ctx, chatId, updated, messageId);
        await ctx.answerCbQuery('Выбор очищен');
        return;
      }
      case 'preview':
        await this.sendFlowPreview(ctx, chatId);
        return;
      case 'start':
        await this.startFlowProcessing(ctx, chatId);
        return;
      case 'cancel': {
        this.sessionStore.clearFlowState(chatId);
        await ctx.answerCbQuery('Выбор отменён');
        if (messageId) {
          try {
            const rawChatId = (ctx.callbackQuery as any)?.message?.chat?.id ?? chatId;
            await ctx.telegram.editMessageText(rawChatId, messageId, undefined, 'Выбор кластеров отменён.');
          } catch (error) {
            this.logger.warn(`Не удалось обновить сообщение после отмены: ${this.formatError(error)}`);
          }
        }
        return;
      }
      default:
        await ctx.answerCbQuery('Неизвестное действие');
        return;
    }
  }

  private async refreshClusterSelectionMessage(
    ctx: Context,
    chatId: string,
    state: FlowState,
    messageId?: number,
  ): Promise<void> {
    const view = this.buildClusterSelectionView(state);
    const targetMessageId = messageId ?? state.selectionMessageId;
    const rawChatId = (ctx.callbackQuery as any)?.message?.chat?.id ?? chatId;
    if (!targetMessageId) {
      return;
    }

    try {
      await ctx.telegram.editMessageText(rawChatId, targetMessageId, undefined, view.text, {
        reply_markup: { inline_keyboard: view.keyboard },
      });
    } catch (error) {
      this.logger.warn(`Не удалось обновить выбор кластеров: ${this.formatError(error)}`);
    }
  }

  private async startFlowProcessing(ctx: Context, chatId: string): Promise<void> {
    const state = this.sessionStore.getFlowState(chatId);
    if (!state) {
      await ctx.answerCbQuery('Сессия устарела');
      return;
    }

    if (!state.selectedClusterIds.size) {
      await ctx.answerCbQuery('Сначала выберите кластер');
      await ctx.reply('Выберите минимум один кластер и повторите запуск.');
      return;
    }

    const selectedOptions = state.clusterOptions.filter((option) =>
      state.selectedClusterIds.has(option.id),
    );
    const tasksToRun = state.tasks.filter(
      (task) => task.clusterId && state.selectedClusterIds.has(task.clusterId),
    );

    if (!tasksToRun.length) {
      await ctx.answerCbQuery('Нет задач для выбранных кластеров');
      await ctx.reply('Для выбранных кластеров не нашлось задач. Попробуйте выбрать другие.');
      return;
    }

    const messageId = (ctx.callbackQuery as any)?.message?.message_id ?? state.selectionMessageId;
    if (messageId) {
      try {
        const rawChatId = (ctx.callbackQuery as any)?.message?.chat?.id ?? chatId;
        await ctx.telegram.editMessageText(
          rawChatId,
          messageId,
          undefined,
          '🚀 Запускаю обработку выбранных кластеров...',
        );
      } catch (error) {
        this.logger.warn(`Не удалось обновить сообщение перед запуском: ${this.formatError(error)}`);
      }
    }

    await ctx.answerCbQuery('Запускаю обработку');
    this.sessionStore.clearFlowState(chatId);
    await this.runSelectedTasks(ctx, chatId, selectedOptions, tasksToRun, state.spreadsheet);
  }

  private async runSelectedTasks(
    ctx: Context,
    chatId: string,
    selectedOptions: ClusterOption[],
    tasks: OzonSupplyTask[],
    spreadsheet: string,
  ): Promise<void> {
    const storedCreds = this.credentialsStore.get(chatId);
    const hasEnv = await this.hasEnvCredentials();

    if (!storedCreds && !hasEnv) {
      await ctx.reply('🔐 Ключи не найдены. Введите их через /ozon_auth и запустите снова.');
      return;
    }

    const summaryLines = selectedOptions.map(
      (option) => `• ${option.name} — задач: ${option.taskCount}`,
    );

    await ctx.reply(
      [
        'Запускаю обработку выбранных кластеров.',
        `Источник: ${this.describeSpreadsheet(spreadsheet)}`,
        '',
        'Кластеры:',
        ...summaryLines,
        '',
        `Всего задач: ${tasks.length}`,
      ].join('\n'),
    );

    const taskMap = new Map<string, OzonSupplyTask>();
    for (const task of this.cloneTasks(tasks)) {
      taskMap.set(task.taskId, task);
    }

    try {
      await this.supplyService.processTasks(taskMap, {
        credentials: storedCreds ?? undefined,
        onEvent: async (result) => this.sendSupplyEvent(ctx, result),
        delayBetweenCallsMs: this.supplyService.getPollIntervalMs(),
      });
      await ctx.reply('✅ Все выбранные задачи обработаны.');
    } catch (error) {
      await ctx.reply(`❌ Ошибка при обработке выбранных задач: ${this.formatError(error)}`);
      await this.safeSendErrorPayload(ctx, error);
    }
  }

  private async sendFlowPreview(ctx: Context, chatId: string): Promise<void> {
    const state = this.sessionStore.getFlowState(chatId);
    if (!state) {
      await ctx.answerCbQuery('Сессия устарела');
      return;
    }

    if (!state.tasks.length) {
      await ctx.answerCbQuery('Черновик пуст');
      await ctx.reply('В текущем черновике нет задач.');
      return;
    }

    const taskMap = new Map<string, OzonSupplyTask>();
    for (const task of this.cloneTasks(state.tasks)) {
      taskMap.set(task.taskId, task);
    }

    const clusterLines = this.supplyService.getClustersOverview(taskMap);
    const previewMessages = this.formatTasksPreview(taskMap, clusterLines);

    if (!previewMessages.length) {
      await ctx.answerCbQuery('Нечего показывать');
      await ctx.reply('Не удалось сформировать предпросмотр. Попробуйте загрузить шаблон заново.');
      return;
    }

    await ctx.answerCbQuery('Черновик отправлен');
    await ctx.reply(`Черновик содержит задач: ${state.tasks.length}. Ниже список.`);
    for (const message of previewMessages) {
      await ctx.reply(message, { parse_mode: 'Markdown' });
    }
  }

  private buildClusterSelectionView(state: FlowState): {
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
  } {
    const selected = state.clusterOptions.filter((option) =>
      state.selectedClusterIds.has(option.id),
    );
    const selectedLines = selected.length
      ? selected.map((option) => `• ${option.name} — задач: ${option.taskCount}`)
      : ['— пока ничего не выбрано —'];

    const lines = [
      'Шаблон загружен.',
      `Источник: ${this.describeSpreadsheet(state.spreadsheet)}`,
      `Задач с доступными кластерами: ${state.tasks.length}`,
      '',
      'Выберите кластеры для запуска (нажмите, чтобы переключить):',
      'Нужно свериться с содержимым? Нажми «Просмотр черновика».',
      '',
      'Выбраны:',
      ...selectedLines,
    ];

    const clusterButtons = state.clusterOptions.map((option) => [
      {
        text: `${state.selectedClusterIds.has(option.id) ? '✅' : '⬜️'} ${option.name} (${option.taskCount})`,
        callback_data: `flow:cluster:${option.id}`,
      },
    ]);

    const controls: Array<Array<{ text: string; callback_data: string }>> = [];
    if (state.clusterOptions.length > 1) {
      controls.push([
        { text: 'Выбрать все', callback_data: 'flow:select_all' },
        { text: 'Очистить', callback_data: 'flow:clear' },
      ]);
    }
    controls.push([{ text: 'Просмотр черновика', callback_data: 'flow:preview' }]);
    controls.push([
      { text: 'Запустить', callback_data: 'flow:start' },
      { text: 'Отмена', callback_data: 'flow:cancel' },
    ]);

    return { text: lines.join('\n'), keyboard: [...clusterButtons, ...controls] };
  }

  private prepareFlowFromTasks(
    tasks: Map<string, OzonSupplyTask>,
    clusters: OzonCluster[],
  ): {
    validTasks: OzonSupplyTask[];
    clusterOptions: ClusterOption[];
    missingCluster: OzonSupplyTask[];
    missingWarehouse: OzonSupplyTask[];
  } {
    const clusterName = new Map<number, string>();
    for (const cluster of clusters) {
      if (typeof cluster.id === 'number') {
        clusterName.set(cluster.id, cluster.name ?? `Кластер ${cluster.id}`);
      }
    }

    const counters = new Map<number, ClusterOption>();
    const validTasks: OzonSupplyTask[] = [];
    const missingCluster: OzonSupplyTask[] = [];
    const missingWarehouse: OzonSupplyTask[] = [];

    for (const task of tasks.values()) {
      if (!task.clusterId) {
        missingCluster.push(task);
        continue;
      }

      if (!task.warehouseId) {
        missingWarehouse.push(task);
        continue;
      }

      validTasks.push(task);

      const existing = counters.get(task.clusterId);
      if (existing) {
        existing.taskCount += 1;
        continue;
      }

      counters.set(task.clusterId, {
        id: task.clusterId,
        name: clusterName.get(task.clusterId) ?? `Кластер ${task.clusterId}`,
        taskCount: 1,
      });
    }

    const clusterOptions = [...counters.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }),
    );

    return { validTasks, clusterOptions, missingCluster, missingWarehouse };
  }

  private cloneTasks(tasks: Iterable<OzonSupplyTask>): OzonSupplyTask[] {
    const result: OzonSupplyTask[] = [];
    for (const task of tasks) {
      result.push({
        ...task,
        items: task.items.map((item) => ({ ...item })),
      });
    }
    return result;
  }

  private async reportSkippedTasks(
    ctx: Context,
    missingCluster: OzonSupplyTask[],
    missingWarehouse: OzonSupplyTask[],
  ): Promise<void> {
    if (!missingCluster.length && !missingWarehouse.length) {
      return;
    }

    if (missingCluster.length) {
      const lines = this.formatTaskRefs(missingCluster, 6);
      await ctx.reply(
        ['⚠️ Не удалось определить кластер для задач:', ...lines].join('\n'),
      );
    }

    if (missingWarehouse.length) {
      const lines = this.formatTaskRefs(missingWarehouse, 6);
      await ctx.reply(
        ['⚠️ Не удалось определить склад для задач:', ...lines].join('\n'),
      );
    }
  }

  private formatTaskRefs(tasks: OzonSupplyTask[], limit: number): string[] {
    const rows = tasks.slice(0, limit).map((task) => {
      const city = task.city ? `, ${task.city}` : '';
      return `• ${task.taskId}${city}`;
    });
    if (tasks.length > limit) {
      rows.push(`… и ещё ${tasks.length - limit}`);
    }
    return rows;
  }

  private describeSpreadsheet(value: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '—';
    if (trimmed.length <= 80) return trimmed;
    return `${trimmed.slice(0, 40)}…${trimmed.slice(-20)}`;
  }

  @Hears(/^привет$/i)
  async onHello(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply('И тебе привет! 👋');
  }

  @On('text')
  async onText(@Ctx() ctx: Context, @Message('text') text?: string): Promise<void> {
    if (!text || text.startsWith('/')) return;
    await ctx.reply('Не понял запрос 🤔. Нажми /help или /start.');
  }

  private parseCommandArgs(ctx: Context): string[] {
    const messageText = (ctx.message as any)?.text ?? '';
    return messageText.trim().split(/\s+/).slice(1);
  }

  private extractChatId(ctx: Context): string | undefined {
    const chatId = (ctx.chat as any)?.id;
    if (typeof chatId === 'undefined' || chatId === null) {
      return undefined;
    }
    return String(chatId);
  }

  private formatError(error: unknown): string {
    if (!error) return 'unknown error';
    if (typeof error === 'string') return error;
    const asAny = error as any;
    if (asAny?.response?.data) {
      try {
        return JSON.stringify(asAny.response.data);
      } catch (err) {
        return asAny.message ?? 'Ошибка без описания';
      }
    }
    return asAny?.message ?? 'Ошибка без описания';
  }

  private buildMenu(hasCredentials: boolean, chatId?: string | undefined) {
    if (!hasCredentials) {
      return [
        [{ text: 'Ввести ключи', callback_data: 'action:enter_creds' }],
        [{ text: 'Запустить поиск', callback_data: 'action:run' }],
        [{ text: 'Проверить связь', callback_data: 'action:ping' }],
        [{ text: 'Помощь', callback_data: 'action:help' }],
      ];
    }

    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    const clustersCached = chatId
      ? this.credentialsStore.get(chatId)?.clusters ?? []
      : [];

    if (clustersCached.length) {
      rows.push([{ text: 'Доступные кластеры', callback_data: 'action:clusters' }]);
    }

    rows.push([{ text: 'Загрузить шаблон', callback_data: 'action:load' }]);
    rows.push([{ text: 'Показать ключи', callback_data: 'action:keys' }]);
    rows.push([{ text: 'Запустить поиск', callback_data: 'action:run' }]);
    rows.push([{ text: 'Проверить связь', callback_data: 'action:ping' }]);
    rows.push([{ text: 'Обновить ключи', callback_data: 'action:enter_creds' }]);
    rows.push([{ text: 'Помощь', callback_data: 'action:help' }]);

    return rows;
  }

  private async sendSupplyEvent(ctx: Context, result: OzonSupplyProcessResult): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) return;

    const message = this.formatSupplyEvent(result);
    if (!message) return;

    await ctx.telegram.sendMessage(chatId, message);
  }

  private formatSupplyEvent({ task, event, message }: OzonSupplyProcessResult): string | undefined {
    const prefix = `[${task.taskId}]`;
    switch (event) {
      case 'draftCreated':
        return `${prefix} Черновик создан. ${message ?? ''}`.trim();
      case 'draftValid':
        return `${prefix} Используем существующий черновик. ${message ?? ''}`.trim();
      case 'draftExpired':
        return `${prefix} Черновик устарел, создаём заново.`;
      case 'draftInvalid':
        return `${prefix} Черновик невалидный, пересоздаём.`;
      case 'draftError':
        return `${prefix} Ошибка статуса черновика.${message ? ` ${message}` : ''}`;
      case 'timeslotMissing':
        return `${prefix} Свободных таймслотов нет.`;
      case 'supplyCreated':
        return `${prefix} ✅ Поставка создана. ${message ?? ''}`.trim();
      case 'noCredentials':
      case 'error':
        return `${prefix} ❌ ${message ?? 'Ошибка'}`;
      default:
        return message ? `${prefix} ${message}` : undefined;
    }
  }

  private async hasEnvCredentials(): Promise<boolean> {
    const clientId = process.env.OZON_CLIENT_ID ?? '';
    const apiKey = process.env.OZON_API_KEY ?? '';
    return Boolean(clientId && apiKey);
  }

  private maskValue(value: string): string {
    if (!value) return '—';
    if (value.length <= 6) {
      return `${value[0] ?? '*'}***${value[value.length - 1] ?? '*'}`;
    }
    return `${value.slice(0, 3)}***${value.slice(-3)}`;
  }

  private formatTasksPreview(tasks: Map<string, OzonSupplyTask>, clusterLines: string[]): string[] {
    const lines: string[] = [];
    for (const task of tasks.values()) {
      const itemsCount = task.items.length;
      const sampleItems = task.items.slice(0, 3)
        .map((item) => `${item.sku}×${item.quantity}`)
        .join(', ');
      const sampleText = sampleItems ? ` — ${sampleItems}${itemsCount > 3 ? ', …' : ''}` : '';
      lines.push(
        `• *${task.taskId}* (${task.city} → ${task.warehouseName || 'не задан склад'}) — товаров: ${itemsCount}${sampleText}`,
      );
    }

    if (clusterLines.length) {
      lines.push('', '*Кластеры и склады:*');
      lines.push(...clusterLines);
    }

    return this.splitMessages(lines, 1500).map((chunk) => chunk.join('\n'));
  }

  private splitMessages(lines: string[], maxLen: number): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let length = 0;

    for (const line of lines) {
      const lineLength = line.length + 1; // + newline
      if (length + lineLength > maxLen && current.length) {
        chunks.push(current);
        current = [];
        length = 0;
      }
      current.push(line);
      length += lineLength;
    }

    if (current.length) {
      chunks.push(current);
    }

    return chunks;
  }

  private async replyLines(
    ctx: Context,
    lines: string[],
    options?: Parameters<Context['reply']>[1],
    logLabel?: string,
  ): Promise<void> {
    const chunks = this.splitMessages(lines, 1500);
    this.logger.debug(
      `replyLines${logLabel ? ` (${logLabel})` : ''}: lines=${lines.length}, chunks=${chunks.length}, options=${
        options ? JSON.stringify(options) : 'none'
      }`,
    );
    for (const chunk of chunks) {
      await ctx.reply(chunk.join('\n'), options as any);
    }
  }

  private extractErrorPayload(error: unknown): string | undefined {
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
      return meta;
    }

    if (error instanceof Error) {
      return error.stack ?? error.message;
    }

    return undefined;
  }

  private async prefetchClusters(
    ctx: Context,
    chatId: string,
    credentials: OzonCredentials,
  ): Promise<void> {
    try {
      const clusters = await this.ozon.listClusters({}, credentials);
      if (!clusters.length) {
        await ctx.reply('Не удалось получить список кластеров — Ozon вернул пустой ответ.');
        return;
      }

      this.updateStoredClusters(chatId, clusters);
      const shortPreview = clusters
        .slice(0, 5)
        .map((cluster) => `${cluster.name ?? 'Без названия'} (ID: ${cluster.id})`);
      await this.replyLines(
        ctx,
        ['Кластеры загружены. Примеры:', ...shortPreview],
        undefined,
        'clusters-after-auth',
      );
    } catch (error) {
      this.logger.warn(`Не удалось получить кластеры сразу после auth: ${this.formatError(error)}`);
      await ctx.reply(
        'Не удалось получить кластеры автоматически. Используйте `/ozon_clusters`, чтобы попробовать ещё раз.',
      );
      await this.safeSendErrorPayload(ctx, error);
    }
  }

  private updateStoredClusters(chatId: string | undefined, clusters: OzonCluster[]): void {
    if (!chatId || !clusters?.length) {
      return;
    }

    const payload = clusters.map((cluster) => ({
      id: cluster.id,
      name: cluster.name ?? undefined,
    }));

    this.credentialsStore.updateClusters(chatId, payload);
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
