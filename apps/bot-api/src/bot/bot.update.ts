import { Command, Ctx, Help, Message, On, Start, Update } from 'nestjs-telegraf';
import { Logger } from '@nestjs/common';
import { Context } from 'telegraf';

import { SupplyWizardHandler } from './supply-wizard.handler';
import { UserCredentialsStore } from './user-credentials.store';
import { OzonCredentials } from '../config/ozon-api.service';
import { AdminNotifierService } from './admin-notifier.service';

@Update()
export class BotUpdate {
  private readonly logger = new Logger(BotUpdate.name);

  private readonly helpMessage = [
    'Привет! Я помогу оформить поставку на Ozon:',
    ' 1. /start — запустить мастер',
    ' 2. /ozon_keys — посмотреть сохранённые ключи',
    ' 3. /ozon_clear — удалить ключи из базы',
    '',
    'Дополнительно:',
    ' /ping — проверить доступность бота'
  ].join('\n');

  constructor(
    private readonly wizard: SupplyWizardHandler,
    private readonly credentialsStore: UserCredentialsStore,
    private readonly adminNotifier: AdminNotifierService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context): Promise<void> {
    await this.wizard.start(ctx);
  }

  @Help()
  async onHelp(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(this.helpMessage);
  }

  @Command('ping')
  async onPing(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply('pong 🏓');
  }

  @Command('ozon_auth')
  async onOzonAuth(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
      return;
    }

    const args = this.parseCommandArgs(ctx);
    const [clientId, apiKey] = args;

    if (args.length < 2) {
      await ctx.reply(`Пройдите авторизацию через /start`);
      return;
    } else {
        await ctx.reply(`client_id: ${ this.maskValue(clientId) }\napi_key: ${ this.maskValue(apiKey) }`);
    }

    await this.credentialsStore.set(chatId, { clientId, apiKey });

    await ctx.reply(
      [
        '✅ Ключи сохранены.'
      ].join('\n'),
    );

    await this.adminNotifier.notifyWizardEvent({
      ctx,
      event: 'auth.saved',
      lines: [`client_id: ${this.maskValue(clientId)}`],
    });

    await this.wizardWarmup(ctx, { clientId, apiKey });
  }

  @Command('ozon_clear')
  async onOzonClear(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
      return;
    }

    const credentials = await this.credentialsStore.get(chatId);
    if (!credentials) {
      await ctx.reply('Сохранённых ключей нет.');
      return;
    }

    await this.credentialsStore.clear(chatId);
    await ctx.reply('✅ Ключи удалены из базы бота.');
    await this.wizard.start(ctx)

    await this.adminNotifier.notifyWizardEvent({
      ctx,
      event: 'auth.cleared',
    });
  }

  @Command('ozon_keys')
  async onOzonKeys(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
      return;
    }

    const credentials = await this.credentialsStore.get(chatId);
    if (!credentials) {
      await ctx.reply('Сохранённых ключей нет. Пройдите авторизацию через /start.');
      return;
    }

    const updated = credentials.verifiedAt.toISOString();
    const lines = [
      'Сохранённые ключи (маскированы):',
      `• client_id: ${this.maskValue(credentials.clientId)}`,
      `• api_key: ${this.maskValue(credentials.apiKey)}`,
      `• обновлено: ${updated}`,
    ];

    await ctx.reply(lines.join('\n'));
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
      await ctx.reply('Используйте /start, чтобы начать оформление поставки.');
      return;
    }

    if (state.stage === 'authApiKey') {
      await this.wizard.handleAuthApiKeyInput(ctx, chatId, state, text);
      return;
    }

    if (state.stage === 'authClientId') {
      await this.wizard.handleAuthClientIdInput(ctx, chatId, state, text);
      return;
    }

    if (state.stage === 'warehouseSelect') {
      await this.wizard.handleWarehouseSearch(ctx, chatId, state, text);
      return;
    }

    if (state.stage === 'awaitSpreadsheet') {
      await this.wizard.handleSpreadsheetLink(ctx, text);
      return;
    }

    if (
      state.stage === 'awaitDropOffQuery' ||
      state.stage === 'dropOffSelect' ||
      state.stage === 'clusterPrompt'
    ) {
      await this.wizard.handleDropOffSearch(ctx, text);
      return;
    }

    if (state.stage === 'awaitReadyDays') {
      await this.wizard.handleReadyDays(ctx, text);
      return;
    }

    await ctx.reply('Команда не распознана. Если хотите загрузить файл, отправьте его или используйте /start.');
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
