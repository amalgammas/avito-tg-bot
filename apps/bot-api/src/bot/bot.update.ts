import { Command, Ctx, Help, Message, On, Start, Update } from 'nestjs-telegraf';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context } from 'telegraf';

import { SupplyWizardHandler } from './supply-wizard.handler';
import { UserCredentialsStore } from './user-credentials.store';
import { OzonAccessDeniedError, OzonApiService, OzonCredentials } from '../config/ozon-api.service';
import { NotificationService } from './services/notification.service';
import { WizardEvent } from './services/wizard-event.types';
import { SupplyOrderStore } from '../storage/supply-order.store';

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
    ' /ping — проверить доступность бота',
    ' /admin_broadcast <ALL|chatId> <текст> — рассылка (только админ)'
  ].join('\n');

  constructor(
    private readonly wizard: SupplyWizardHandler,
    private readonly credentialsStore: UserCredentialsStore,
    private readonly orderStore: SupplyOrderStore,
    private readonly ozonApi: OzonApiService,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService,
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

    try {
      await this.ozonApi.validateSupplyOrderAccess({ clientId, apiKey });
    } catch (error) {
      if (error instanceof OzonAccessDeniedError) {
        await ctx.reply(
          `❌ Ключи не сохранены, потому что у аккаунта нет нужных прав.\n${error.message}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Авторизоваться', callback_data: 'wizard:auth:login' }],
                [{ text: 'Назад', callback_data: 'wizard:auth:back:welcome' }],
              ],
            },
          } as any,
        );
        return;
      }
      const message = error instanceof Error ? error.message : 'Не удалось проверить права Ozon API.';
      await ctx.reply(`❌ Ключи не сохранены.\n${message}`);
      return;
    }

    await this.credentialsStore.set(chatId, { clientId, apiKey });

    await ctx.reply(
      [
        '✅ Ключи сохранены.'
      ].join('\n'),
    );

    await this.notifications.notifyWizard(WizardEvent.AuthSaved, {
      ctx,
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

    await this.notifications.notifyWizard(WizardEvent.AuthCleared, { ctx });
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
      `• user: ${chatId}`,
      `• обновлено: ${updated}`,
    ];

    await ctx.reply(lines.join('\n'));
  }

  @Command('admin_broadcast')
  async onAdminBroadcast(@Ctx() ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат.');
      return;
    }

    if (!this.isAdminContext(ctx)) {
      await ctx.reply('Команда доступна только администратору.');
      return;
    }

    const args = this.parseCommandArgs(ctx);
    if (!args.length) {
      await ctx.reply('Использование: /admin_broadcast <ALL|chatId> <текст сообщения>');
      return;
    }

    let targets: string[] = [];
    let text = '';
    const [targetArg, ...rest] = args;
    const normalizedTarget = (targetArg ?? '').trim();

    if (normalizedTarget.toUpperCase() === 'ALL') {
      text = rest.join(' ').trim();
      targets = await this.collectBroadcastTargets();
      if (!targets.length) {
        await ctx.reply('В базе нет пользователей для рассылки.');
        return;
      }
    } else if (/^-?\d+$/.test(normalizedTarget)) {
      text = rest.join(' ').trim();
      targets = [normalizedTarget];
    } else {
      // Backward-compat mode: old format "/admin_broadcast <text>" sends to ALL.
      text = args.join(' ').trim();
      targets = await this.collectBroadcastTargets();
      if (!targets.length) {
        await ctx.reply('В базе нет пользователей для рассылки.');
        return;
      }
    }

    if (!text) {
      await ctx.reply('Укажите текст сообщения после target.');
      return;
    }

    let attempted = 0;
    for (const target of targets) {
      await this.notifications.notifyUser(target, text);
      attempted += 1;
    }

    await ctx.reply(`Рассылка завершена. Попыток отправки: ${attempted}`);
    await this.notifications.notifyWizard(WizardEvent.SupplyStatus, {
      ctx,
      lines: [`admin_broadcast target=${normalizedTarget || 'ALL'} attempted=${attempted}`],
    });
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
      await this.wizard.start(ctx);
      return;
    }

    const supplyType = state.supplyType ?? 'CREATE_TYPE_CROSSDOCK';

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
      if (supplyType === 'CREATE_TYPE_CROSSDOCK') {
        await this.wizard.handleDropOffSearch(ctx, text);
        return;
      }
    }

    if (state.stage === 'awaitReadyDays') {
      await this.wizard.handleReadyDays(ctx, text);
      return;
    }

    if (state.stage === 'awaitSearchDeadline') {
      await this.wizard.handleSearchDeadline(ctx, text);
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

  private parseCommandText(ctx: Context, command: string): string {
    const messageText = ((ctx.message as any)?.text ?? '').trim();
    if (!messageText) {
      return '';
    }

    const [firstToken, ...restTokens] = messageText.split(/\s+/);
    const normalized = firstToken.replace(/^\/+/, '');
    const commandName = normalized.split('@')[0];
    if (commandName !== command) {
      return restTokens.join(' ').trim();
    }
    return restTokens.join(' ').trim();
  }

  private extractChatId(ctx: Context): string | undefined {
    const chatId = (ctx.chat as any)?.id;
    if (typeof chatId === 'undefined' || chatId === null) {
      return undefined;
    }
    return String(chatId);
  }

  private isAdminContext(ctx: Context): boolean {
    const ids = this.config.get<string[]>('telegram.adminIds') ?? [];
    const configured = new Set(ids.map((value) => value.trim()).filter(Boolean));
    const broadcastChatId = this.config.get<string>('telegram.botAdminId')?.trim();

    const chatId = this.extractChatId(ctx);
    const fromId = this.extractFromId(ctx);

    if (chatId && configured.has(chatId)) {
      return true;
    }
    if (fromId && configured.has(fromId)) {
      return true;
    }
    if (broadcastChatId && chatId === broadcastChatId) {
      return true;
    }
    return false;
  }

  private async collectBroadcastTargets(): Promise<string[]> {
    const [fromCredentials, fromOrders] = await Promise.all([
      this.credentialsStore.listChatIds(),
      this.orderStore.listDistinctChatIds(),
    ]);

    const set = new Set<string>();
    for (const chatId of [...fromCredentials, ...fromOrders]) {
      const normalized = chatId?.trim();
      if (normalized) {
        set.add(normalized);
      }
    }
    return Array.from(set.values());
  }

  private extractFromId(ctx: Context): string | undefined {
    const fromId = (ctx.from as any)?.id;
    if (typeof fromId === 'undefined' || fromId === null) {
      return undefined;
    }
    return String(fromId);
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
