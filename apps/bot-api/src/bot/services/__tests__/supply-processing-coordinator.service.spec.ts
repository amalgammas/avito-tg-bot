import { SupplyProcessingCoordinatorService } from '../supply-processing-coordinator.service';

const orchestrator = {
  run: jest.fn(),
};

const coordinator = new SupplyProcessingCoordinatorService(orchestrator as any);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SupplyProcessingCoordinatorService', () => {
  const params = {
    task: { taskId: 'task-1', items: [] } as any,
    credentials: { clientId: 'id', apiKey: 'key' },
    readyInDays: 1,
    dropOffWarehouseId: 123,
    abortController: new AbortController(),
  } as const;

  it('delegates run call to orchestrator and forwards callbacks', async () => {
    const callbacks = {
      onEvent: jest.fn(),
      onWindowExpired: jest.fn(),
      onSupplyCreated: jest.fn(),
      onError: jest.fn(),
      onAbort: jest.fn(),
      onFinally: jest.fn(),
    };

    orchestrator.run.mockResolvedValueOnce(undefined);

    await coordinator.run({ ...params, callbacks });

    expect(orchestrator.run).toHaveBeenCalledWith({
      task: params.task,
      credentials: params.credentials,
      readyInDays: params.readyInDays,
      dropOffWarehouseId: params.dropOffWarehouseId,
      abortController: params.abortController,
      callbacks: {
        onEvent: callbacks.onEvent,
        onWindowExpired: callbacks.onWindowExpired,
        onSupplyCreated: callbacks.onSupplyCreated,
        onError: callbacks.onError,
        onAbort: callbacks.onAbort,
      },
    });

    expect(callbacks.onFinally).toHaveBeenCalled();
  });

  it('invokes onFinally even when orchestrator throws', async () => {
    const callbacks = {
      onFinally: jest.fn(),
    };

    orchestrator.run.mockRejectedValueOnce(new Error('boom'));

    await expect(coordinator.run({ ...params, callbacks })).rejects.toThrow('boom');
    expect(callbacks.onFinally).toHaveBeenCalled();
  });
});
