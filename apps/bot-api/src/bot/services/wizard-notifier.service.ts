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
    const withTask = this.ensureTaskLine(filtered);

    try {
      await this.adminNotifier.notifyWizardEvent({
        ctx: options.ctx,
        event,
        lines: withTask,
      });
    } catch (error) {
      this.logger.debug(`Admin notification failed (${event}): ${String(error)}`);
    }
  }

  private ensureTaskLine(lines: string[]): string[] {
    if (!lines.length) {
      return lines;
    }
    const hasTaskLine = lines.some((line) => line.trim().toLowerCase().startsWith('task:'));
    if (hasTaskLine) {
      return lines;
    }
    const joined = lines.join('\n');
    const match = joined.match(/\[([^\]]+)\]/);
    if (!match) {
      return lines;
    }
    const candidate = match[1]?.trim();
    if (!candidate || !/\d/.test(candidate)) {
      return lines;
    }
    return [`task: ${candidate}`, ...lines];
  }
}
