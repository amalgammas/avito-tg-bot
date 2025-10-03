import { Ctx, Help, Message, On, Start, Update, Command, Hears } from 'nestjs-telegraf';
import { Context } from 'telegraf';

@Update()
export class BotUpdate {
    private readonly helpMessage = [
        'Привет! Я бот, который помогает работать с Avito API.',
        'Доступные команды:',
        ' /start — меню и краткая справка',
        ' /help — показать эту подсказку',
        ' /ping — проверка доступности',
        ' /id — показать chat_id и user_id',
        ' /time — текущее время сервера',
        '',
        'Напиши "привет" — я отвечу 😉',
    ].join('\n');

    @Start()
    async onStart(@Ctx() ctx: Context): Promise<void> {
        await ctx.reply(
            'Добро пожаловать! Ниже быстрые действия:',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Мой ID', callback_data: 'action:id' }],
                        [{ text: 'Время', callback_data: 'action:time' }],
                        [{ text: 'Помощь', callback_data: 'action:help' }],
                    ],
                },
            }
        );
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

    @Command('time')
    async onTime(@Ctx() ctx: Context): Promise<void> {
        await ctx.reply(`Время сервера: ${new Date().toISOString()}`);
    }

    // Нажатия на инлайн-кнопки
    @On('callback_query')
    async onCallback(@Ctx() ctx: Context): Promise<void> {
        const data = (ctx.callbackQuery as any)?.data as string | undefined;
        if (!data) return;

        if (data === 'action:id') {
            const chatId = (ctx.chat as any)?.id;
            const userId = (ctx.from as any)?.id;
            await ctx.answerCbQuery();
            await ctx.reply(`chat_id: ${chatId}\nuser_id: ${userId}`);
            return;
        }

        if (data === 'action:time') {
            await ctx.answerCbQuery();
            await ctx.reply(`Время сервера: ${new Date().toISOString()}`);
            return;
        }

        if (data === 'action:help') {
            await ctx.answerCbQuery();
            await this.onHelp(ctx);
            return;
        }

        await ctx.answerCbQuery('Неизвестное действие');
    }

    // Пример осмысленного «слушателя»
    @Hears(/^привет$/i)
    async onHello(@Ctx() ctx: Context): Promise<void> {
        await ctx.reply('И тебе привет! 👋');
    }

    // Fallback: реагируем только на обычный текст, не перехватываем команды
    @On('text')
    async onText(@Ctx() ctx: Context, @Message('text') text?: string): Promise<void> {
        if (!text || text.startsWith('/')) return;
        await ctx.reply('Не понял запрос 🤔. Нажми /help или /start.');
    }
}
