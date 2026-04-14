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
    (service as any).draftRequestHistory = new Map();
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
    expect(window.preparationExpired).toBe(true);
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

  it('handleExistingDraft keeps waiting when crossdock draft has no available warehouses yet', async () => {
    const credentials = { clientId: 'id', apiKey: 'key' };
    ozonApi.getDraftInfo.mockResolvedValueOnce({
      status: 'SUCCESS',
      draft_id: 123,
      clusters: [
        {
          macrolocal_cluster_id: 4007,
          warehouses: [
            {
              availability_status: {
                invalid_reason: 'NOT_AVAILABLE_ROUTE',
                state: 'NOT_AVAILABLE',
              },
              storage_warehouse: null,
              total_score: 0,
            },
          ],
          supply_type: 'CROSSDOCK',
        },
      ],
    });

    const result = await (service as any).handleExistingDraft(
      {
        ...baseTask,
        supplyType: 'CREATE_TYPE_CROSSDOCK',
        warehouseAutoSelect: true,
        warehouseId: undefined,
      },
      credentials,
    );

    expect(result.event.type).toBe(OzonSupplyEventType.WarehousePending);
    expect(ozonApi.getDraftTimeslots).not.toHaveBeenCalled();
    expect(result.task.draftOperationId).toBe(baseTask.draftOperationId);
  });

  it('createDraft requests operation and returns DraftCreated', async () => {
    const credentials = { clientId: 'id', apiKey: 'key' };
    ozonApi.createDraft.mockResolvedValue('operation-123');
    ozonApi.getDraftTimeslots.mockResolvedValue({ drop_off_warehouse_timeslots: [] });
    const task = { ...baseTask, draftOperationId: '', draftId: 0 };

    const result = await (service as any).createDraft(task, credentials, 100);
    expect(result.event.type).toBe(OzonSupplyEventType.DraftCreated);
    expect(task.draftOperationId).toBe('operation-123');
    expect(ozonApi.createDraft).toHaveBeenCalledTimes(1);
  });

  it('pickTimeslot ignores preset slot outside readiness window', async () => {
    const credentials = { clientId: 'id', apiKey: 'key' };
    const staleTimeslot = {
      from_in_timezone: '2020-01-01T10:00:00+03:00',
      to_in_timezone: '2020-01-01T12:00:00+03:00',
    };

    const task: OzonSupplyTask = {
      ...baseTask,
      readyInDays: 1,
      draftId: 123,
      draftOperationId: 'op-2',
      warehouseId: 7,
      selectedTimeslot: staleTimeslot,
    };

    const window = (service as any).computeTimeslotWindow(task);
    const nextFrom = window.dateFromIso;
    const nextTo = new Date(new Date(nextFrom).getTime() + 2 * 60 * 60 * 1000).toISOString();

    ozonApi.getDraftTimeslots.mockResolvedValue({
      drop_off_warehouse_timeslots: [
        {
          days: [
            {
              timeslots: [
                {
                  from_in_timezone: nextFrom,
                  to_in_timezone: nextTo,
                },
              ],
            },
          ],
        },
      ],
    });

    const result = await (service as any).pickTimeslot(task, credentials, window);
    expect(result?.from_in_timezone).toBe(nextFrom);
    expect(ozonApi.getDraftTimeslots).toHaveBeenCalledTimes(1);
    expect(task.selectedTimeslot).toBeUndefined();
  });

  it('refreshes credentials and retries task only on missing role error', async () => {
    const task: OzonSupplyTask = {
      ...baseTask,
      supplyType: 'CREATE_TYPE_DIRECT',
      orderFlag: 0,
    };
    const taskMap = new Map([[task.taskId, task]]);
    const oldCredentials = { clientId: 'old', apiKey: 'old-key' };
    const newCredentials = { clientId: 'new', apiKey: 'new-key' };

    const processSingleTask = jest
      .spyOn(service as any, 'processSingleTask')
      .mockRejectedValueOnce({
        response: {
          status: 403,
          data: {
            code: 7,
            message: 'Api-Key is missing a required role for a method',
          },
        },
      } as AxiosError)
      .mockImplementationOnce(async (state: any) => {
        state.orderFlag = 1;
        return {
          task: state,
          event: { type: OzonSupplyEventType.SupplyCreated },
          operationId: 'op-2',
        };
      });

    await service.processTasks(taskMap, {
      credentials: oldCredentials,
      getCredentials: jest.fn().mockResolvedValue(newCredentials),
      onEvent: jest.fn(),
    });

    expect(processSingleTask).toHaveBeenNthCalledWith(1, task, oldCredentials, undefined, undefined);
    expect(processSingleTask).toHaveBeenNthCalledWith(2, task, newCredentials, undefined, undefined);
  });

  it('emits detailed error with status/code/message when role error cannot be recovered', async () => {
    const task: OzonSupplyTask = {
      ...baseTask,
      supplyType: 'CREATE_TYPE_DIRECT',
      orderFlag: 0,
    };
    const taskMap = new Map([[task.taskId, task]]);
    const onEvent = jest.fn();
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });

    jest.spyOn(service as any, 'processSingleTask').mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          code: 7,
          message: 'Api-Key is missing a required role for a method',
        },
      },
      message: 'Request failed with status code 403',
    } as AxiosError);
    jest.spyOn(service as any, 'sleep').mockRejectedValueOnce(abortError);

    await expect(
      service.processTasks(taskMap, {
        credentials: { clientId: 'old', apiKey: 'old-key' },
        getCredentials: jest.fn().mockResolvedValue(undefined),
        onEvent,
      }),
    ).rejects.toThrow('aborted');

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: { type: OzonSupplyEventType.Error },
        message: expect.stringContaining('status=403'),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('code=7'),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('missing a required role'),
      }),
    );
  });
});
