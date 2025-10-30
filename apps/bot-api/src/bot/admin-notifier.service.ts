import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, TelegramError } from 'telegraf';
import { Telegraf } from 'telegraf';
import { InjectBot } from 'nestjs-telegraf';

@Injectable()
export class AdminNotifierService {
  private readonly logger = new Logger(AdminNotifierService.name);
  private readonly adminChatIds: string[];
  private readonly broadcastChatId?: string;

  constructor(
    private readonly config: ConfigService,
    @InjectBot() private readonly bot: Telegraf<Context>,
  ) {
    const ids = this.config.get<string[]>('telegram.adminIds') ?? [];
    this.adminChatIds = ids.filter((value) => value.trim().length > 0);
    this.broadcastChatId = this.config.get<string>('telegram.botAdminId')?.trim();
    if (this.broadcastChatId && !/^[-]?\d+$/.test(this.broadcastChatId)) {
      this.logger.warn(
        `TELEGRAM_BOT_ADMIN expected to be chat id (integer), got "${this.broadcastChatId}". Messages may fail.`,
      );
    }
    if (!this.adminChatIds.length) {
      this.logger.log('Admin notifications disabled: TELEGRAM_ADMIN_IDS is empty');
    }
    if (!this.broadcastChatId) {
      this.logger.log('Broadcast channel is not set (TELEGRAM_BOT_ADMIN). Logs will be delivered only to admins list.');
    }
  }

  isEnabled(): boolean {
    return Boolean(this.broadcastChatId || this.adminChatIds.length);
  }

  async notifyWizardEvent(params: {
    ctx?: Context;
    event: string;
    lines?: string[];
  }): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const { ctx, event, lines = [] } = params;
    const meta: string[] = [];

    const chatId = this.extractChatId(ctx);
    if (chatId) {
      meta.push(`chat: ${chatId}`);
    }

    const userLabel = this.describeUser(ctx);
    if (userLabel) {
      meta.push(`user: ${userLabel}`);
    }

    const messageLines = [`#${event}`, ...meta];
    if (lines.length) {
      messageLines.push('', ...lines);
    }

    const text = messageLines.join('\n');

    await this.broadcast(text);
  }

  private async broadcast(text: string): Promise<void> {
    if (this.broadcastChatId) {
      await this.sendMessage(this.broadcastChatId, text);
    }

    for (const chatId of this.adminChatIds) {
      if (this.broadcastChatId && chatId === this.broadcastChatId) {
        continue;
      }
      const personalText = this.broadcastChatId
        ? `${text}\n\n(Лог продублирован в канале ${this.broadcastChatId})`
        : text;
      await this.sendMessage(chatId, personalText);
    }
  }

  private async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, text);
    } catch (error) {
      if (error instanceof TelegramError && error.code === 403) {
        this.logger.warn(`Unable to deliver admin notification to ${chatId}: ${error.message}`);
        return;
      }
      this.logger.error(`Failed to deliver admin notification to ${chatId}: ${error}`);
    }
  }

  private extractChatId(ctx?: Context): string | undefined {
    const raw = ctx?.chat?.id;
    if (typeof raw === 'number' || typeof raw === 'string') {
      return String(raw);
    }
    return undefined;
  }

  private describeUser(ctx?: Context): string | undefined {
    const user = ctx?.from;
    if (!user) return undefined;
    const parts = [];
    if (user.username) {
      parts.push(`${user.username}`);
    }
    if (user.first_name || user.last_name) {
      parts.push(`${user.first_name ?? ''} ${user.last_name ?? ''}`.trim());
    }

    return parts.filter(Boolean).join(' ');
  }
}
