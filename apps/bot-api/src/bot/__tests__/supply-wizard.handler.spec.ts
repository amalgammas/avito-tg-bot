import { Context } from 'telegraf';

import { SupplyWizardHandler } from '../supply-wizard.handler';
import { WizardEvent } from '../services/wizard-event.types';

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  return {
    ...actual,
    Logger: class {
      error = jest.fn();
      warn = jest.fn();
      log = jest.fn();
      debug = jest.fn();
    },
  };
});

describe('SupplyWizardHandler (partial)', () => {
  const credentialsStore = { get: jest.fn(), clear: jest.fn(), set: jest.fn() } as any;
  const sheetService = {} as any;
  const supplyService = {} as any;
  const ozonApi = {} as any;
  const process = {
    describeTimeslot: jest.fn(() => 'ts'),
    fetchOrderIdWithRetries: jest.fn(),
    fetchSupplyOrderDetails: jest.fn(),
  } as any;
  const store = { get: jest.fn(), update: jest.fn(), listTaskContexts: jest.fn(() => []), getTaskContext: jest.fn() } as any;
  const sessions = { saveChatState: jest.fn(), deleteChatState: jest.fn() } as any;
  const processing = { run: jest.fn() } as any;
  const notifications = { notifyWizard: jest.fn(), notifyUser: jest.fn() } as any;
  const view = {
    updatePrompt: jest.fn(),
    renderLanding: jest.fn(() => 'landing'),
    buildLandingKeyboard: jest.fn(() => []),
    renderReadyDaysPrompt: jest.fn(() => 'prompt'),
    buildReadyDaysKeyboard: jest.fn(() => []),
    renderDropOffQuery: jest.fn(() => 'dropoff'),
    sendErrorDetails: jest.fn(),
  } as any;
  const orderStore = {
    saveTask: jest.fn(),
    deleteByTaskId: jest.fn(),
    completeTask: jest.fn(),
    list: jest.fn(() => []),
  } as any;

  const handler = new SupplyWizardHandler(
    credentialsStore,
    sheetService,
    supplyService,
    ozonApi,
    process,
    store,
    sessions,
    processing,
    notifications,
    view,
    orderStore,
  );

  const ctx = { reply: jest.fn(), chat: { id: 1 }, callbackQuery: { message: { chat: { id: 1 } } } } as unknown as Context;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('handleSupplyFailure notifies user and wizard', async () => {
    await (handler as any).handleSupplyFailure(ctx, 'chat-1', { stage: 'landing' }, new Error('fail'));
    expect(view.updatePrompt).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('fail'));
    expect(notifications.notifyWizard).toHaveBeenCalledWith(WizardEvent.SupplyError, expect.anything());
  });

  it('mapSupplyEvent maps supply event types to wizard events', () => {
    const map = (handler as any).mapSupplyEvent.bind(handler);
    expect(map('draftCreated')).toBe(WizardEvent.DraftCreated);
    expect(map('draftExpired')).toBe(WizardEvent.DraftExpired);
    expect(map('warehousePending')).toBe(WizardEvent.WarehousePending);
  });
});
