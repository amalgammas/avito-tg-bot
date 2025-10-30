import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';

import { WizardNotifierService } from './wizard-notifier.service';
import { WizardEvent, WizardEventPayload } from './wizard-event.types';

interface UserNotificationOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
  disablePreview?: boolean;
  disableNotification?: boolean;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly wizardNotifier: WizardNotifierService,
    @InjectBot() private readonly bot: Telegraf<Context>,
  ) {}

  async notifyWizard(event: WizardEvent, options: WizardEventPayload & { ctx?: Context } = {}): Promise<void> {
    await this.wizardNotifier.emit(event, options);
  }

  async notifyUser(chatId: string, text?: string, options: UserNotificationOptions = {}): Promise<void> {
    if (!text) {
      return;
    }
    const target = chatId?.toString().trim();
    if (!target.length) {
      return;
    }

    try {
      const params: Record<string, unknown> = {};
      if (options.parseMode) {
        params.parse_mode = options.parseMode;
      }
      if (typeof options.disablePreview === 'boolean') {
        params.disable_web_page_preview = options.disablePreview;
      }
      if (typeof options.disableNotification === 'boolean') {
        params.disable_notification = options.disableNotification;
      }
      await this.bot.telegram.sendMessage(target, text, params);
    } catch (error) {
      this.logger.warn(`Failed to deliver message to ${target}: ${String(error)}`);
    }
  }
}
