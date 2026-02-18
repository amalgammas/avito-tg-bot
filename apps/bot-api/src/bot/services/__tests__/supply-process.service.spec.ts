import { jest } from '@jest/globals';

import type {
  OzonSupplyCancelStatus,
  OzonSupplyCreateStatus,
  OzonSupplyOrder,
} from '@bot/config/ozon-api.service';
import { SupplyProcessService } from '../supply-process.service';

describe('SupplyProcessService', () => {
const flow = {
  getSupplyCreateStatus: jest.fn(),
  getSupplyCancelStatus: jest.fn(),
  getSupplyOrders: jest.fn(),
};

  const service = new SupplyProcessService(flow as any);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('computeTimeslotWindow respects from/to offsets', () => {
    const now = new Date(Date.UTC(2025, 0, 1, 12, 0, 0, 0));
    const window = service.computeTimeslotWindow({ fromDays: 2, toDays: 5, now });
    expect(window.fromIso).toBe('2025-01-03T12:00:00Z');
    expect(window.toIso).toBe('2025-01-06T12:00:00Z');
  });

  it('describeTimeslot returns undefined if edges missing', () => {
    expect(service.describeTimeslot(undefined)).toBeUndefined();
    expect(
      service.describeTimeslot({
        from_in_timezone: '2025-05-10T10:00:00Z',
        to_in_timezone: undefined,
      } as any),
    ).toBeUndefined();
  });

  it('formatTimeslotRange produces human friendly string', () => {
    const formatted = service.formatTimeslotRange(
      '2025-05-10T07:00:00Z',
      '2025-05-10T08:30:00Z',
      'Europe/Moscow',
    );
    expect(formatted).toContain('10.05');
    expect(formatted).toContain('Europe/Moscow');
  });

  it('extractOrderIdsFromStatus reads nested structures', () => {
    const status: OzonSupplyCreateStatus = {
      status: 'SUCCESS',
      result: {
        order_ids: [12345, '54321'],
      },
      order_ids: ['22222'],
    } as any;
    const ids = service.extractOrderIdsFromStatus(status).sort();
    expect(ids).toEqual([12345, 54321, 22222].sort());
  });

  it('fetchOrderIdWithRetries retries until orderId found', async () => {
    const operationId = 'op-1';
    const statusMock = flow.getSupplyCreateStatus as jest.MockedFunction<
      (operationId: string, credentials: unknown) => Promise<OzonSupplyCreateStatus>
    >;

    statusMock
      .mockResolvedValueOnce({} as OzonSupplyCreateStatus)
      .mockResolvedValueOnce({
        result: { order_ids: [777] },
      } as OzonSupplyCreateStatus);

    const result = await service.fetchOrderIdWithRetries(operationId, {} as any, {
      attempts: 3,
      delayMs: 0,
    });

    expect(result).toBe(777);
    expect(statusMock).toHaveBeenCalledTimes(2);
  });

  it('resolveOrderIdWithRetries fast-fails on forbidden role', async () => {
    const statusMock = flow.getSupplyCreateStatus as jest.MockedFunction<
      (operationId: string, credentials: unknown) => Promise<OzonSupplyCreateStatus>
    >;
    statusMock.mockRejectedValueOnce({
      response: {
        status: 403,
        data: { message: 'Api-Key is missing a required role for a method' },
      },
    } as any);

    const result = await service.resolveOrderIdWithRetries('op-403', {} as any, {
      attempts: 5,
      delayMs: 0,
    });

    expect(result.orderId).toBeUndefined();
    expect(result.failureReason).toBe('forbidden_role');
    expect(result.attemptsMade).toBe(1);
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it('isCancelSuccessful handles SUCCESS flag', () => {
    const status: OzonSupplyCancelStatus = { status: 'SUCCESS' } as any;
    expect(service.isCancelSuccessful(status)).toBe(true);
  });

  it('describeCancelStatus composes readable message', () => {
    const status: OzonSupplyCancelStatus = {
      status: 'SUCCESS',
      result: {
        is_order_cancelled: true,
        supplies: [
          {
            supply_id: 111,
            is_supply_cancelled: false,
            error_reasons: [{ code: 'X', message: 'reason' }],
          },
        ],
      },
    } as any;

    const description = service.describeCancelStatus(status);
    expect(description).toContain('status=SUCCESS');
    expect(description).toContain('is_order_cancelled=true');
    expect(description).toContain('111:active(X:reason)');
  });

  it('mapOrderDetails converts API order into domain model', () => {
    const order: OzonSupplyOrder = {
      order_id: 1,
      drop_off_warehouse: {
        warehouse_id: '123',
        name: 'DropOff',
        address: 'Address',
      },
      timeslot: {
        timeslot: {
          from: '2025-05-10T07:00:00Z',
          to: '2025-05-10T08:00:00Z',
        },
        timezone_info: { iana_name: 'Europe/Moscow' },
      },
      supplies: [
        {
          supply_id: 2,
          storage_warehouse: {
            warehouse_id: '777',
            name: 'WH',
            address: 'WH Address',
          },
        },
      ],
    } as any;

    const details = (service as any).mapOrderDetails(order);
    expect(details.dropOffId).toBe(123);
    expect(details.storageWarehouseId).toBe(777);
    expect(details.timeslotLabel).toContain('Europe/Moscow');
  });
});
