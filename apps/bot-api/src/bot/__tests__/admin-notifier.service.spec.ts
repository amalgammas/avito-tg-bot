import type { Context, TelegramError } from 'telegraf';
import type { Telegraf } from 'telegraf';

import { AdminNotifierService } from '../admin-notifier.service';
import { WizardEvent } from '../services/wizard-event.types';

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  return {
    ...actual,
    Logger: class {
      log = jest.fn();
      warn = jest.fn();
      error = jest.fn();
    },
  };
});

describe('AdminNotifierService', () => {
  const configGet = jest.fn();
  const configService = { get: configGet } as any;
  const telegram = {
    sendMessage: jest.fn(),
  } as unknown as Telegraf<Context>['telegram'];
  const bot = { telegram } as Telegraf<Context>;

  const buildService = (options: { adminIds?: string[]; broadcastId?: string } = {}) => {
    configGet.mockImplementation((key: string) => {
      if (key === 'telegram.adminIds') {
        return options.adminIds ?? [];
      }
      if (key === 'telegram.botAdminId') {
        return options.broadcastId ?? undefined;
      }
      return undefined;
    });

    return new AdminNotifierService(configService, bot);
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('isEnabled returns false when no chat ids configured', () => {
    const service = buildService();
    expect(service.isEnabled()).toBe(false);
  });

  it('sends notifications to both broadcast and admin ids', async () => {
    const service = buildService({ adminIds: ['111', '222'], broadcastId: '333' });

    const ctx = { chat: { id: 777 }, from: { username: 'user', first_name: 'John' } } as any;
    await service.notifyWizardEvent({ ctx, event: WizardEvent.Start, lines: ['hello'] });

    expect(telegram.sendMessage).toHaveBeenCalledTimes(3);
    expect(telegram.sendMessage).toHaveBeenNthCalledWith(1, '333', expect.stringContaining('#wizard.start'));
    expect(telegram.sendMessage).toHaveBeenNthCalledWith(
      2,
      '111',
      expect.stringContaining('(Лог продублирован в канале 333)'),
    );
    expect(telegram.sendMessage).toHaveBeenNthCalledWith(
      3,
      '222',
      expect.stringContaining('(Лог продублирован в канале 333)'),
    );
  });

  it('logs warning when telegram returns 403', async () => {
    const service = buildService({ adminIds: ['111'] });
    (telegram.sendMessage as jest.Mock).mockRejectedValueOnce({ code: 403, message: 'blocked' } as TelegramError);

    await service.notifyWizardEvent({ event: WizardEvent.SupplyError, lines: ['fail'] });

    expect(telegram.sendMessage).toHaveBeenCalled();
  });

  it('logs error for other telegram failures', async () => {
    const service = buildService({ adminIds: ['111'] });
    (telegram.sendMessage as jest.Mock).mockRejectedValueOnce(new Error('boom'));

    await service.notifyWizardEvent({ event: WizardEvent.SupplyError, lines: ['fail'] });

    expect(telegram.sendMessage).toHaveBeenCalled();
  });
});
