import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';

import { AdminNotifierService } from '../admin-notifier.service';
import { WizardEvent, WizardEventPayload } from './wizard-event.types';

@Injectable()
export class WizardNotifierService {
  private readonly logger = new Logger(WizardNotifierService.name);

  constructor(private readonly adminNotifier: AdminNotifierService) {}

  isEnabled(): boolean {
    return this.adminNotifier.isEnabled();
  }

  async emit(event: WizardEvent, options: { ctx?: Context } & WizardEventPayload = {}): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const filtered = (options.lines ?? []).filter((value): value is string => Boolean(value && value.trim().length));
    const source = options.source ?? (options.ctx ? 'telegram' : undefined);

    try {
      await this.adminNotifier.notifyWizardEvent({
        ctx: options.ctx,
        event,
        lines: filtered,
        source,
      });
    } catch (error) {
      this.logger.debug(`Admin notification failed (${event}): ${String(error)}`);
    }
  }
}
