import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';

import { AdminNotifierService } from '../admin-notifier.service';

@Injectable()
export class WizardNotifierService {
  private readonly logger = new Logger(WizardNotifierService.name);

  constructor(private readonly adminNotifier: AdminNotifierService) {}

  isEnabled(): boolean {
    return this.adminNotifier.isEnabled();
  }

  async emit(event: string, options: { ctx?: Context; lines?: Array<string | undefined> } = {}): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const filtered = (options.lines ?? []).filter((value): value is string => Boolean(value && value.trim().length));

    try {
      await this.adminNotifier.notifyWizardEvent({
        ctx: options.ctx,
        event,
        lines: filtered,
      });
    } catch (error) {
      this.logger.debug(`Admin notification failed (${event}): ${String(error)}`);
    }
  }
}
