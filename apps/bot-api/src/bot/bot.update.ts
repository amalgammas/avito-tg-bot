import { Command, Ctx, Hears, Help, Message, On, Start, Update } from 'nestjs-telegraf';
import { Logger } from '@nestjs/common';
import { Context } from 'telegraf';

import { OzonApiService, OzonCredentials, OzonCluster } from '../config/ozon-api.service';
import { OzonSupplyService } from '../ozon/ozon-supply.service';
import { OzonSupplyProcessResult, OzonSupplyTask } from '../ozon/ozon-supply.types';
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
      });

      await ctx.reply('✅ Все задачи обработаны.');
    } catch (error) {
      await ctx.reply(`❌ Ошибка при запуске обработки: ${this.formatError(error)}`);
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
