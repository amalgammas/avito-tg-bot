import { SupplyWizardStore } from '../supply-wizard.store';

const baseState = {
  stage: 'landing',
  clusters: [],
  warehouses: {},
  dropOffs: [],
  draftWarehouses: [],
  draftTimeslots: [],
  draftStatus: 'idle',
  orders: [],
  pendingTasks: [],
  createdAt: 0,
  taskContexts: {},
  taskOrder: [],
} as any;

describe('SupplyWizardStore', () => {
  const store = new SupplyWizardStore();
  const chatId = 'chat-1';

  beforeEach(() => {
    store.clear(chatId);
  });

  it('start initialises state and cloning keeps immutability', () => {
    const state = store.start(chatId, { clusters: [], warehouses: {}, dropOffs: [] });
    state.stage = 'authWelcome';

    const stored = store.get(chatId);
    expect(stored?.stage).toBe('awaitSpreadsheet');
  });

  it('update applies updater and persists new state', () => {
    store.start(chatId, { clusters: [], warehouses: {}, dropOffs: [] });
    store.update(chatId, (current) => ({
      ...(current as any),
      stage: 'landing',
    }));
    expect(store.get(chatId)?.stage).toBe('landing');
  });

  it('upsertTaskContext inserts and updates task snapshot', () => {
    store.start(chatId, { clusters: [], warehouses: {}, dropOffs: [] });

    const created = store.upsertTaskContext(chatId, 'task-1', () => ({
      taskId: 'task-1',
      stage: 'processing',
      draftStatus: 'idle',
      draftWarehouses: [],
      draftTimeslots: [],
      task: { taskId: 'task-1', items: [] } as any,
      summaryItems: [],
      createdAt: Date.now(),
    }));
    expect(created?.taskId).toBe('task-1');

    const updated = store.upsertTaskContext(chatId, 'task-1', (existing) => ({
      ...(existing as any),
      stage: 'awaitReadyDays',
    }));
    expect(updated?.stage).toBe('awaitReadyDays');

    expect(store.listTaskContexts(chatId)).toHaveLength(1);
  });

  it('removeTaskContext deletes context and updates order', () => {
    store.start(chatId, { clusters: [], warehouses: {}, dropOffs: [] });
    store.upsertTaskContext(chatId, 'task-1', () => ({
      taskId: 'task-1',
      stage: 'processing',
      draftStatus: 'idle',
      draftWarehouses: [],
      draftTimeslots: [],
      task: { taskId: 'task-1', items: [] } as any,
      summaryItems: [],
      createdAt: Date.now(),
    }));
    store.removeTaskContext(chatId, 'task-1');
    expect(store.listTaskContexts(chatId)).toEqual([]);
  });
});
