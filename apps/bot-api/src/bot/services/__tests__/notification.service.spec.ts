import { Context } from 'telegraf';
import type { Telegraf } from 'telegraf';

import { NotificationService } from '../notification.service';
import { WizardNotifierService } from '../wizard-notifier.service';
import { WizardEvent } from '../wizard-event.types';

describe('NotificationService', () => {
  const wizardNotifier = {
    emit: jest.fn(),
  } as unknown as jest.Mocked<WizardNotifierService>;

  const telegram = {
    sendMessage: jest.fn(),
  } as unknown as jest.Mocked<Telegraf<Context>['telegram']>;

  const bot = { telegram } as unknown as Telegraf<Context>;

  const service = new NotificationService(wizardNotifier as WizardNotifierService, bot);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates wizard notifications to WizardNotifierService', async () => {
    const ctx = { chat: { id: 1 } } as unknown as Context;
    await service.notifyWizard(WizardEvent.Start, { ctx, lines: ['hello'] });
    expect(wizardNotifier.emit).toHaveBeenCalledWith(WizardEvent.Start, { ctx, lines: ['hello'] });
  });

  it('skips notifyUser when text is empty or chatId invalid', async () => {
    await service.notifyUser('123', undefined);
    await service.notifyUser('', 'text');
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('sends message with options when notifyUser called', async () => {
    await service.notifyUser('777', 'hi', {
      parseMode: 'HTML',
      disableNotification: true,
      disablePreview: true,
    });

    expect(telegram.sendMessage).toHaveBeenCalledWith('777', 'hi', {
      parse_mode: 'HTML',
      disable_notification: true,
      disable_web_page_preview: true,
    });
  });

  it('logs warning when telegram send fails', async () => {
    telegram.sendMessage.mockRejectedValueOnce(new Error('boom'));

    await service.notifyUser('999', 'boom');

    // should swallow error
    expect(telegram.sendMessage).toHaveBeenCalled();
  });
});
