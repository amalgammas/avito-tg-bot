import { Ctx, Help, Message, On, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';

@Update()
export class BotUpdate {
  private readonly helpMessage = [
    'Привет! Я бот, который помогает работать с Avito API.',
    'Доступные команды:',
    ' /start — приветствие и краткая справка',
    ' /help — показать эту подсказку',
    'Отправь любое сообщение, и я повторю его обратно.'
  ].join('\n');

  @Start()
  async onStart(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply('Добро пожаловать! Используйте /help, чтобы увидеть список команд.');
  }

  @Help()
  async onHelp(@Ctx() ctx: Context): Promise<void> {
    await ctx.reply(this.helpMessage);
  }

  @On('text')
  async onText(@Ctx() ctx: Context, @Message('text') text: string): Promise<void> {
    if (!text || text.startsWith('/')) {
      return;
    }

    await ctx.reply(text);
  }
}
