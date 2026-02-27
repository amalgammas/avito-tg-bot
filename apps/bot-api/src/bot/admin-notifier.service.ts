import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, TelegramError } from 'telegraf';
import { Telegraf } from 'telegraf';
import { InjectBot } from 'nestjs-telegraf';

import { WizardEvent } from './services/wizard-event.types';

@Injectable()
export class AdminNotifierService {
  private readonly logger = new Logger(AdminNotifierService.name);
  private readonly telegramMessageLimit = 4096;
  private readonly telegramChunkSize = 3800;
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
    event: WizardEvent;
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
    const successfulTargets: string[] = [];
    const failedTargets: Array<{ chatId: string; reason: string }> = [];

    if (this.broadcastChatId) {
      const delivery = await this.sendMessage(this.broadcastChatId, text);
      if (delivery.ok) {
        successfulTargets.push(this.broadcastChatId);
      } else {
        failedTargets.push({ chatId: this.broadcastChatId, reason: delivery.reason });
      }
    }

    for (const chatId of this.adminChatIds) {
      if (this.broadcastChatId && chatId === this.broadcastChatId) {
        continue;
      }
      const personalText = this.broadcastChatId
        ? `${text}\n\n(Лог продублирован в канале ${this.broadcastChatId})`
        : text;
      const delivery = await this.sendMessage(chatId, personalText);
      if (delivery.ok) {
        successfulTargets.push(chatId);
      } else {
        failedTargets.push({ chatId, reason: delivery.reason });
      }
    }

    if (failedTargets.length) {
      const diagnosticText = this.formatDeliveryFailureText(text, failedTargets);
      for (const chatId of successfulTargets) {
        await this.sendMessage(chatId, diagnosticText);
      }

      const failureSummary = failedTargets.map((item) => `${item.chatId}: ${item.reason}`).join(' | ');
      this.logger.warn(`Admin notification delivery issues: ${failureSummary}`);
    }
  }

  private async sendMessage(chatId: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parts = this.splitMessage(text, this.telegramChunkSize);

    try {
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const payload =
          parts.length > 1
            ? `(часть ${index + 1}/${parts.length})\n${part}`
            : part;

        await this.bot.telegram.sendMessage(chatId, payload.slice(0, this.telegramMessageLimit));
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof TelegramError && error.code === 403) {
        this.logger.warn(`Unable to deliver admin notification to ${chatId}: ${error.message}`);
        return { ok: false, reason: `403: ${error.message}` };
      }
      this.logger.error(`Failed to deliver admin notification to ${chatId}: ${error}`);
      return { ok: false, reason: this.describeError(error) };
    }
  }

  private formatDeliveryFailureText(
    sourceText: string,
    failedTargets: Array<{ chatId: string; reason: string }>,
  ): string {
    const eventLine = sourceText.split('\n')[0] ?? '#unknown';
    const failedLines = failedTargets.map((item) => `• ${item.chatId}: ${item.reason}`);
    return [
      '⚠️ Не удалось доставить админ-уведомление во все чаты.',
      `Событие: ${eventLine}`,
      'Причины:',
      ...failedLines,
    ].join('\n');
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    if (typeof error === 'object' && error !== null) {
      const maybeCode = (error as any).code;
      const maybeMessage = (error as any).message;
      if (maybeCode || maybeMessage) {
        return `${maybeCode ?? 'unknown'}: ${maybeMessage ?? String(error)}`;
      }
    }
    return String(error);
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const input = text?.trim();
    if (!input) {
      return [''];
    }
    if (input.length <= maxLength) {
      return [input];
    }

    const chunks: string[] = [];
    let rest = input;

    while (rest.length > maxLength) {
      const slice = rest.slice(0, maxLength);
      const breakAtNewline = slice.lastIndexOf('\n');
      const breakAtSpace = slice.lastIndexOf(' ');
      const minBreakIndex = Math.floor(maxLength * 0.6);

      let breakIndex = -1;
      if (breakAtNewline >= minBreakIndex) {
        breakIndex = breakAtNewline;
      } else if (breakAtSpace >= minBreakIndex) {
        breakIndex = breakAtSpace;
      }

      if (breakIndex <= 0) {
        breakIndex = maxLength;
      }

      chunks.push(rest.slice(0, breakIndex).trimEnd());
      rest = rest.slice(breakIndex).trimStart();
    }

    if (rest.length) {
      chunks.push(rest);
    }

    return chunks.length ? chunks : [input];
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
