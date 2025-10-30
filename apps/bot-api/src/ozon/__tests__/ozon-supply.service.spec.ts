import type { AxiosError } from 'axios';

import { OzonSupplyService } from '../ozon-supply.service';
import { OzonSupplyEventType, type OzonSupplyTask } from '../ozon-supply.types';

describe('OzonSupplyService', () => {
  const sheetService = {} as any;

  const ozonApi = {
    getDraftInfo: jest.fn(),
    createDraft: jest.fn(),
    getDraftTimeslots: jest.fn(),
    createSupply: jest.fn(),
    listClusters: jest.fn(),
    listAvailableWarehouses: jest.fn(),
    getProductsByOfferIds: jest.fn(),
    getSupplyCreateStatus: jest.fn(),
    getSupplyCancelStatus: jest.fn(),
    getSupplyOrders: jest.fn(),
  } as const;

  const configService = {
    get: jest.fn((key: string) => {
      switch (key) {
        case 'ozonSupply.dropOffPointWarehouseId':
          return '0';
        case 'ozonSupply.spreadsheetId':
          return '';
        case 'ozonSupply.pollIntervalMs':
          return '3000';
        case 'ozon.clientId':
        case 'ozon.apiKey':
          return '';
        default:
          return undefined;
      }
    }),
  } as const;

  const service = new OzonSupplyService(sheetService, ozonApi as any, configService as any);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseTask: OzonSupplyTask = {
    taskId: 'task-1',
    city: 'City',
    warehouseName: 'Warehouse',
    lastDay: '',
    draftId: 0,
    draftOperationId: 'op-1',
    orderFlag: 0,
  items: [{ article: 'A', quantity: 1, sku: 123 }],
  };

  it('computeTimeslotWindow marks expired windows when readyInDays exceeds deadline', () => {
    const task: OzonSupplyTask = {
      ...baseTask,
      readyInDays: 10,
      lastDay: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const window = (service as any).computeTimeslotWindow(task);
    expect(window.expired).toBe(true);
  });

  it('resolveReadyInDays falls back to lastDay when readyInDays missing', () => {
    const task: OzonSupplyTask = {
      ...baseTask,
      readyInDays: undefined,
      lastDay: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const result = (service as any).resolveReadyInDays(task);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(28);
  });

  it('handleExistingDraft returns DraftExpired when API responds with 404 code=5', async () => {
    const credentials = { clientId: 'id', apiKey: 'key' };
    ozonApi.getDraftInfo.mockRejectedValueOnce({
      response: { status: 404, data: { code: 5 } },
    } as AxiosError);

    const result = await (service as any).handleExistingDraft({ ...baseTask }, credentials);
    expect(result.event.type).toBe(OzonSupplyEventType.DraftExpired);
  });

  it('createDraft caches operation and returns DraftCreated', async () => {
    const credentials = { clientId: 'id', apiKey: 'key' };
    ozonApi.createDraft.mockResolvedValueOnce('operation-123');
    ozonApi.getDraftTimeslots.mockResolvedValue({ drop_off_warehouse_timeslots: [] });
    const task = { ...baseTask, draftOperationId: '', draftId: 0 };

    const result = await (service as any).createDraft(task, credentials, 100);
    expect(result.event.type).toBe(OzonSupplyEventType.DraftCreated);
    expect(task.draftOperationId).toBe('operation-123');

    // repeat should hit cache and return DraftValid
    const cached = await (service as any).createDraft(task, credentials, 100);
    expect(cached.event.type).toBe(OzonSupplyEventType.DraftValid);
    expect(ozonApi.createDraft).toHaveBeenCalledTimes(1);
  });
});
