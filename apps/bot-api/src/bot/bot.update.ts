import { Command, Ctx, Hears, Help, Message, On, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';

import { OzonApiService, OzonCredentials } from '../config/ozon-api.service';
import { UserCredentialsStore } from './user-credentials.store';

@Update()
export class BotUpdate {
  private readonly helpMessage = [
    'Привет! Я бот, который помогает автоматизировать поставки Ozon.',
    'Доступные команды:',
    ' /start — приветствие и главное меню',
    ' /help — показать эту подсказку',
    ' /ping — проверка доступности (кнопка «Проверить связь»)',
    ' /id — показать chat_id и user_id',
    ' /ozon_auth <CLIENT_ID> <API_KEY> — проверить ключи и сохранить их',
    ' /ozon_whoami — информация о продавце по сохранённым ключам',
    ' /ozon_clear — удалить сохранённые ключи',
    ' /ozon_me — профиль по ключам из .env',
    ' Пользователь Дима — проверка ключей из .env',
    '',
    'Если ключей нет — нажми «Ввести ключи» в меню.',
  ].join('\n');

  constructor(
    private readonly ozon: OzonApiService,
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
        inline_keyboard: this.buildMenu(hasCredentials),
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

    await ctx.reply('Проверяю ключи в Ozon...');

    try {
      const { account } = await this.ozon.validateCredentials(credentials);
      this.credentialsStore.set(chatId, credentials);

      const summary = this.stringifyAccount(account);
      await ctx.reply(
        [
          '✅ Ключи подтверждены.',
          summary ? `Продавец: ${summary}` : undefined,
          'Теперь можно использовать /ozon_whoami.',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (error) {
      await ctx.reply(`❌ Не удалось подтвердить ключи: ${this.formatError(error)}`);
    }
  }

  @Command('ozon_whoami')
  async onOzonWhoAmI(@Ctx() ctx: Context): Promise<void> {
    await this.handleOzonWhoAmI(ctx);
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

  @Command('ozon_me')
  async onOzonMe(@Ctx() ctx: Context): Promise<void> {
    try {
      const profile = await this.ozon.getSellerInfo();
      await ctx.reply('```\n' + JSON.stringify(profile, null, 2) + '\n```', {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      await ctx.reply(`❌ Ошибка при запросе профиля (env): ${this.formatError(error)}`);
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
      case 'action:dima':
        await ctx.answerCbQuery();
        await this.handleEnvProfile(ctx, 'Проверка пользователя Дима...');
        break;
      case 'action:ping':
        await ctx.answerCbQuery('pong 🏓');
        await ctx.reply('pong 🏓');
        break;
      case 'action:help':
        await ctx.answerCbQuery();
        await this.onHelp(ctx);
        break;
      case 'action:whoami':
        await ctx.answerCbQuery();
        await this.handleOzonWhoAmI(ctx);
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

  @Hears(/^пользователь дима$/i)
  async onUserDima(@Ctx() ctx: Context): Promise<void> {
    await this.handleEnvProfile(ctx, 'Проверяю пользователя Дима по ключам .env...');
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

  private stringifyAccount(account: unknown): string | undefined {
    if (!account || typeof account !== 'object') return undefined;
    const data = account as Record<string, unknown>;
    const name = data['name'] ?? data['legal_name'] ?? data['organization_name'];
    if (typeof name === 'string' && name.trim().length > 0) {
      return name.trim();
    }
    return undefined;
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

  private buildMenu(hasCredentials: boolean) {
    if (!hasCredentials) {
      return [
        [{ text: 'Пользователь Дима', callback_data: 'action:dima' }],
        [{ text: 'Ввести ключи', callback_data: 'action:enter_creds' }],
        [{ text: 'Проверить связь', callback_data: 'action:ping' }],
        [{ text: 'Помощь', callback_data: 'action:help' }],
      ];
    }

    return [
      [{ text: 'Пользователь Дима', callback_data: 'action:dima' }],
      [{ text: 'Профиль Ozon', callback_data: 'action:whoami' }],
      [{ text: 'Проверить связь', callback_data: 'action:ping' }],
      [{ text: 'Обновить ключи', callback_data: 'action:enter_creds' }],
      [{ text: 'Помощь', callback_data: 'action:help' }],
    ];
  }

  private async handleOzonWhoAmI(ctx: Context): Promise<void> {
    const chatId = this.extractChatId(ctx);
    if (!chatId) {
      await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
      return;
    }

    const creds = this.credentialsStore.get(chatId);
    if (!creds) {
      await ctx.reply('Ключи не найдены. Используйте /ozon_auth <CLIENT_ID> <API_KEY>.');
      return;
    }

    await ctx.reply('Запрашиваю профиль продавца в Ozon...');

    try {
      const profile = await this.ozon.getSellerInfo(creds);
      await ctx.reply('```\n' + JSON.stringify(profile, null, 2) + '\n```', {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      await ctx.reply(`❌ Ошибка при запросе профиля: ${this.formatError(error)}`);
    }
  }

  private async handleEnvProfile(ctx: Context, intro?: string): Promise<void> {
    if (intro) {
      await ctx.reply(intro);
    }

    try {
      const profile = await this.ozon.getSellerInfo();
      await ctx.reply('```\n' + JSON.stringify(profile, null, 2) + '\n```', {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      await ctx.reply(`❌ Ошибка при проверке ключей из .env: ${this.formatError(error)}`);
    }
  }
}
