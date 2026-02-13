import { SupplyOrderStore } from '../supply-order.store';

describe('SupplyOrderStore', () => {
  const repository = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn((entity) => ({ ...entity })),
  } as any;

  const store = new SupplyOrderStore(repository);
  const chatId = 'chat-1';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('list returns mapped summaries of supply records', async () => {
    repository.find.mockResolvedValueOnce([
      { id: '1', status: 'supply', items: [], createdAt: 0 },
      { id: '2', status: 'task', items: [], createdAt: 0 },
    ]);

    const summaries = await store.list(chatId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe('1');
    expect(repository.find).toHaveBeenCalledWith({ where: { chatId }, order: { createdAt: 'ASC' } });
  });

  it('saveTask creates new entity when missing and updates fields', async () => {
    repository.findOne.mockResolvedValueOnce(null);

    const entity = await store.saveTask(chatId, {
      task: { taskId: 'task-1', items: [], selectedTimeslot: undefined } as any,
      clusterId: 1,
      dropOffId: 2,
      readyInDays: 3,
    });

    expect(entity.taskId).toBe('task-1');
    expect(repository.save).toHaveBeenCalled();
  });

  it('completeTask creates new entity if task missing', async () => {
    repository.findOne.mockResolvedValueOnce(null);

    await store.completeTask(chatId, {
      taskId: 'task-1',
      operationId: 'op-1',
      items: [],
    });

    expect(repository.save).toHaveBeenCalled();
  });

  it('completeTask does not rewrite already completed task', async () => {
    repository.findOne.mockResolvedValueOnce({
      id: 'task-1',
      chatId,
      taskId: 'task-1',
      status: 'supply',
      createdAt: 1,
    });

    const entity = await store.completeTask(chatId, {
      taskId: 'task-1',
      operationId: 'op-1',
      items: [],
    });

    expect(entity.status).toBe('supply');
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('setOrderId updates entity and persists changes', async () => {
    repository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'op-1', chatId });

    await store.setOrderId(chatId, 'op-1', 777);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '777', orderId: 777 }),
    );
  });
});
