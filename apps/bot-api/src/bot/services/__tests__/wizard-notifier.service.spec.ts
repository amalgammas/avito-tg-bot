import { Context } from 'telegraf';

import { AdminNotifierService } from '../../admin-notifier.service';
import { WizardNotifierService } from '../wizard-notifier.service';
import { WizardEvent } from '../wizard-event.types';

describe('WizardNotifierService', () => {
  const adminNotifier = {
    isEnabled: jest.fn(),
    notifyWizardEvent: jest.fn(),
  } as unknown as jest.Mocked<AdminNotifierService>;

  const service = new WizardNotifierService(adminNotifier as AdminNotifierService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips emitting when admin notifier disabled', async () => {
    adminNotifier.isEnabled.mockReturnValue(false);

    await service.emit(WizardEvent.Start, { lines: ['should be ignored'] });

    expect(adminNotifier.notifyWizardEvent).not.toHaveBeenCalled();
  });

  it('filters empty lines before delegating to admin notifier', async () => {
    adminNotifier.isEnabled.mockReturnValue(true);

    const ctx = { chat: { id: 1 } } as unknown as Context;
    await service.emit(WizardEvent.SupplyProcessing, { ctx, lines: ['line', undefined, '  '] });

    expect(adminNotifier.notifyWizardEvent).toHaveBeenCalledWith({
      ctx,
      event: WizardEvent.SupplyProcessing,
      lines: ['line'],
    });
  });

  it('swallows errors from admin notifier and logs debug', async () => {
    adminNotifier.isEnabled.mockReturnValue(true);
    adminNotifier.notifyWizardEvent.mockRejectedValueOnce(new Error('fail'));

    await expect(
      service.emit(WizardEvent.SupplyError, { lines: ['broken'] }),
    ).resolves.toBeUndefined();
  });
});
