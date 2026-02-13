import { SupplyTaskRunnerService } from '../supply-task-runner.service';
import { WizardEvent } from '../services/wizard-event.types';
import { OzonSupplyEventType } from '@bot/ozon/ozon-supply.types';

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  return {
    ...actual,
    Logger: class {
      log = jest.fn();
      warn = jest.fn();
      error = jest.fn();
      debug = jest.fn();
    },
  };
});

describe('SupplyTaskRunnerService', () => {
  const orderStore = {
    listTasks: jest.fn(),
    findTask: jest.fn(),
    completeTask: jest.fn(),
    setOrderId: jest.fn(),
  } as any;
  const credentialsStore = {
    get: jest.fn(),
  } as any;
  const supplyService = {
    runSingleTask: jest.fn(),
  } as any;
  const notifications = {
    notifyWizard: jest.fn(),
    notifyUser: jest.fn(),
  } as any;
  const process = {
    fetchOrderIdWithRetries: jest.fn(),
    fetchSupplyOrderDetails: jest.fn(),
    describeTimeslot: jest.fn(() => 'timeslot'),
    mapTaskItems: jest.fn(() => []),
  } as any;
  const taskAbortService = {
    register: jest.fn(),
    clear: jest.fn(),
  } as any;
  const bot = {
    telegram: {
      getChat: jest.fn(),
    },
  } as any;

  const service = new SupplyTaskRunnerService(
    orderStore,
    credentialsStore,
    supplyService,
    notifications,
    process,
    taskAbortService,
    bot,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    orderStore.findTask.mockResolvedValue(null);
  });

  const sampleTask = {
    id: 'row-1',
    taskId: 'task-1',
    chatId: 'chat-1',
    dropOffId: 123,
    dropOffName: 'DO',
    warehouseName: 'WH',
    taskPayload: {
      taskId: 'task-1',
      items: [],
    },
    readyInDays: 2,
  } as any;

  it('handleTaskEvent completes task and notifies on SupplyCreated', async () => {
    process.fetchOrderIdWithRetries.mockResolvedValueOnce(777);
    const result = {
      event: { type: OzonSupplyEventType.SupplyCreated },
      task: { taskId: 'task-1', items: [], selectedTimeslot: undefined },
      operationId: 'op-1',
    } as any;

    orderStore.completeTask.mockResolvedValueOnce({
      orderId: 777,
      operationId: 'op-1',
      timeslotFrom: undefined,
      timeslotTo: undefined,
      arrival: 'timeslot',
      warehouse: 'WH',
      dropOffName: 'DO',
    });

    await (service as any).handleTaskEvent(sampleTask, result, {} as any);

    expect(orderStore.completeTask).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      taskId: 'task-1',
      operationId: 'op-1',
      orderId: 777,
    }));
    expect(notifications.notifyUser).toHaveBeenCalledWith('chat-1', expect.stringContaining('Поставка создана'), {
      parseMode: 'HTML',
    });
    expect(notifications.notifyWizard).toHaveBeenCalledWith(WizardEvent.TaskResumedSupplyCreated, {
      lines: expect.arrayContaining([expect.stringContaining('task: task-1')]),
    });
  });

  it('handleTaskEvent sends error info to wizard channel on generic error', async () => {
    const result = {
      event: { type: OzonSupplyEventType.Error },
      message: 'oops',
      task: sampleTask.taskPayload,
    } as any;

    await (service as any).handleTaskEvent(sampleTask, result, {} as any);

    expect(notifications.notifyWizard).toHaveBeenCalledWith(WizardEvent.SupplyError, {
      lines: expect.arrayContaining([expect.stringContaining('task: task-1'), expect.stringContaining('oops')]),
    });
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  it('handleTaskEvent skips duplicate SupplyCreated when task already completed', async () => {
    orderStore.findTask.mockResolvedValueOnce({ status: 'supply' });
    const result = {
      event: { type: OzonSupplyEventType.SupplyCreated },
      task: { taskId: 'task-1', items: [], selectedTimeslot: undefined },
      operationId: 'op-1',
    } as any;

    await (service as any).handleTaskEvent(sampleTask, result, {} as any);

    expect(orderStore.completeTask).not.toHaveBeenCalled();
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  it('recoverMissingOrderIds resolves and stores orderId for supply records without id', async () => {
    orderStore.listTasks.mockResolvedValueOnce([
      {
        id: 'op-1',
        chatId: 'chat-1',
        status: 'supply',
        operationId: 'op-1',
        orderId: undefined,
      },
    ]);
    credentialsStore.get.mockResolvedValueOnce({ clientId: 'c', apiKey: 'k' });
    process.fetchOrderIdWithRetries.mockResolvedValueOnce(999);

    await (service as any).recoverMissingOrderIds();

    expect(process.fetchOrderIdWithRetries).toHaveBeenCalledWith(
      'op-1',
      { clientId: 'c', apiKey: 'k' },
      expect.objectContaining({ attempts: 5, delayMs: 1000 }),
    );
    expect(orderStore.setOrderId).toHaveBeenCalledWith('chat-1', 'op-1', 999);
    expect(notifications.notifyWizard).toHaveBeenCalledWith(WizardEvent.TaskOrderIdRecovered, {
      lines: expect.arrayContaining([
        'chat: chat-1',
        'operation: op-1',
        'order_id: 999',
      ]),
    });
  });
});
