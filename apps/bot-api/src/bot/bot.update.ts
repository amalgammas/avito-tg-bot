import { Command, Ctx, Help, Message, On, Start, Update } from 'nestjs-telegraf';
import { Logger } from '@nestjs/common';
import { Context } from 'telegraf';

import { SupplyWizardHandler } from './supply-wizard.handler';
import { UserCredentialsStore } from './user-credentials.store';
import { OzonApiService, OzonCredentials } from '../config/ozon-api.service';

@Update()
export class BotUpdate {
  private readonly logger = new Logger(BotUpdate.name);
  private readonly helpMessage = [
    'Привет! Я помогу оформить поставку на Ozon:',
    ' 1. /ozon_auth <CLIENT_ID> <API_KEY> — сохранить ключи',
    ' 2. /ozon_supply — загрузить Excel (Артикул, Количество) и пройти все этапы',
    ' 3. /ozon_keys — посмотреть сохранённые ключи',
    ' 4. /ozon_clear — удалить ключи из памяти',
    '',
    'Дополнительно:',
    ' /ping — проверить доступность бота',
    ' /help — показать эту подсказку',
  ].join('\n');

  constructor(
    private readonly wizard: SupplyWizardHandler,
    private readonly credentialsStore: UserCredentialsStore,
    private readonly ozonApi: OzonApiService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    const hasCredentials = chatId ? this.credentialsStore.has(chatId) : false;
    const intro = hasCredentials
      ? 'Ключи найдены. Готов принять Excel-файл — отправьте его или воспользуйтесь /ozon_supply.'
      : 'Для начала сохраните Client ID и API Key Ozon через /ozon_auth <CLIENT_ID> <API_KEY>.';

    await ctx.reply(intro);
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
    this.credentialsStore.set(chatId, { clientId, apiKey });

    await ctx.reply(
      [
        '✅ Ключи сохранены.',
        'Теперь отправьте файл через /ozon_supply — я спрошу кластер, склад и дату, а затем создам поставку.',
      ].join('\n'),
    );

    await this.wizardWarmup(ctx, { clientId, apiKey });
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
    await ctx.reply('✅ Ключи удалены из памяти бота.');
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

    await ctx.reply(['Сохранённые ключи (маскированы):', ...lines].join('\n'));
  }

  @Command('ozon_supply')
  async onOzonSupply(@Ctx() ctx: Context): Promise<void> {
    await this.wizard.start(ctx);
  }

  @On('document')
  async onDocument(@Ctx() ctx: Context): Promise<void> {
    await this.wizard.handleDocument(ctx);
  }

  @On('text')
  async onText(@Ctx() ctx: Context, @Message('text') text?: string): Promise<void> {
    if (!text || text.startsWith('/')) {
      return;
    }

    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
      return;
    }

    const state = this.wizardState(chatId);
    if (!state) {
      await ctx.reply('Используйте /ozon_supply, чтобы начать оформление поставки.');
      return;
    }

    if (state.stage === 'awaitSpreadsheet') {
      await this.wizard.handleSpreadsheetLink(ctx, text);
      return;
    }

    if (state.stage === 'awaitReadyDays') {
      await this.wizard.handleReadyDays(ctx, text);
      return;
    }

    await ctx.reply('Команда не распознана. Если хотите загрузить файл, отправьте его или используйте /ozon_supply.');
  }

  @On('callback_query')
  async onCallback(@Ctx() ctx: Context): Promise<void> {
    const data = (ctx.callbackQuery as any)?.data as string | undefined;
    if (!data) return;

    if (data.startsWith('wizard:')) {
      await this.wizard.handleCallback(ctx, data);
      return;
    }

    await ctx.answerCbQuery('Неизвестное действие');
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

  private maskValue(value: string): string {
    if (!value) return '—';
    if (value.length <= 6) {
      return `${value[0] ?? '*'}***${value[value.length - 1] ?? '*'}`;
    }
    return `${value.slice(0, 3)}***${value.slice(-3)}`;
  }

  private wizardState(chatId: string) {
    return this.wizard.getState(chatId);
  }

  private async wizardWarmup(ctx: Context, credentials: OzonCredentials): Promise<void> {
    this.logger.debug(`Credentials saved for wizard warmup: ${credentials.clientId}`);
    await ctx.reply('Жду загрузку документа со списком позиций (Артикул + Количество).');
  }
}
