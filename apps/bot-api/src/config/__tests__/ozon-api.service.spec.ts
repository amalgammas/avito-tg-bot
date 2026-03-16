import { OzonAccessDeniedError, OzonApiService } from '../ozon-api.service';

describe('OzonApiService.validateSupplyOrderAccess', () => {
  const http = { axiosRef: { request: jest.fn() } } as any;
  const config = { get: jest.fn() } as any;
  const credentials = { clientId: 'client', apiKey: 'key' };

  let service: OzonApiService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OzonApiService(http, config);
  });

  it('accepts credentials when role Supply order has all required methods', async () => {
    const requiredMethods = [...((service as any).requiredSupplyMethods as string[])];

    jest.spyOn(service, 'validateCredentials').mockResolvedValue({ account: { seller_id: 1 } });
    jest.spyOn(service, 'getRoles').mockResolvedValue({
      roles: [
        { name: 'Supply order ReadOnly', methods: ['/v1/supply-order/list'] },
        { name: 'Supply order', methods: requiredMethods },
      ],
    });

    await expect(service.validateSupplyOrderAccess(credentials)).resolves.toEqual({
      account: { seller_id: 1 },
      roles: [
        { name: 'Supply order ReadOnly', methods: ['/v1/supply-order/list'] },
        { name: 'Supply order', methods: requiredMethods },
      ],
    });
  });

  it('throws when role Supply order is missing', async () => {
    jest.spyOn(service, 'validateCredentials').mockResolvedValue({ account: {} });
    jest.spyOn(service, 'getRoles').mockResolvedValue({
      roles: [{ name: 'Supply order ReadOnly', methods: [] }],
    });

    await expect(service.validateSupplyOrderAccess(credentials)).rejects.toThrow(OzonAccessDeniedError);
    await expect(service.validateSupplyOrderAccess(credentials)).rejects.toThrow(
      'Недостаточно прав Ozon API: требуется роль "Supply order".',
    );
  });

  it('throws when Supply order has missing required methods', async () => {
    const requiredMethods = [...((service as any).requiredSupplyMethods as string[])];
    const missingMethod = requiredMethods[0];

    jest.spyOn(service, 'validateCredentials').mockResolvedValue({ account: {} });
    jest.spyOn(service, 'getRoles').mockResolvedValue({
      roles: [{ name: 'Supply order', methods: requiredMethods.slice(1) }],
    });

    await expect(service.validateSupplyOrderAccess(credentials)).rejects.toThrow(OzonAccessDeniedError);
    await expect(service.validateSupplyOrderAccess(credentials)).rejects.toThrow(
      `в роли "Supply order" отсутствуют методы: ${missingMethod}.`,
    );
  });
});

describe('OzonApiService.createDraft', () => {
  const http = { axiosRef: { request: jest.fn() } } as any;
  const config = { get: jest.fn() } as any;
  const credentials = { clientId: 'client', apiKey: 'key' };

  let service: OzonApiService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OzonApiService(http, config);
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
  });

  it('builds crossdock request in new format', async () => {
    const postSpy = jest.spyOn(service, 'post').mockResolvedValue({
      data: { operation_id: 'op-1' },
    } as any);

    const operationId = await service.createDraft(
      {
        clusterIds: [154],
        macrolocalClusterId: 154,
        dropOffPointWarehouseId: 1020000902510000,
        items: [{ sku: 1927956902, quantity: 20 }],
        type: 'CROSSDOCK',
      },
      credentials,
    );

    expect(operationId).toBe('op-1');
    expect(postSpy).toHaveBeenCalledWith(
      '/v1/draft/crossdock/create',
      {
        cluster_info: {
          items: [{ sku: 1927956902, quantity: 20 }],
          macrolocal_cluster_id: 154,
        },
        deletion_sku_mode: 'FULL',
        delivery_info: {
          drop_off_warehouse: {
            warehouse_id: 1020000902510000,
            warehouse_type: 'DELIVERY_POINT',
          },
          type: 'DROPOFF',
        },
      },
      undefined,
      credentials,
      undefined,
    );
  });

  it('keeps direct request format', async () => {
    const postSpy = jest.spyOn(service, 'post').mockResolvedValue({
      data: { operation_id: 'op-2' },
    } as any);

    const operationId = await service.createDraft(
      {
        clusterIds: [200],
        macrolocalClusterId: 200,
        items: [{ sku: 111, quantity: 5 }],
        type: 'DIRECT',
      },
      credentials,
    );

    expect(operationId).toBe('op-2');
    expect(postSpy).toHaveBeenCalledWith(
      '/v1/draft/direct/create',
      {
        cluster_info: {
          items: [{ sku: 111, quantity: 5 }],
          macrolocal_cluster_id: 200,
        },
        deletion_sku_mode: 'FULL',
      },
      undefined,
      credentials,
      undefined,
    );
  });

  it('reads operation_id from nested result payload', async () => {
    jest.spyOn(service, 'post').mockResolvedValue({
      data: { result: { operation_id: 'op-3' } },
    } as any);

    const operationId = await service.createDraft(
      {
        clusterIds: [200],
        macrolocalClusterId: 200,
        items: [{ sku: 111, quantity: 5 }],
        type: 'DIRECT',
      },
      credentials,
    );

    expect(operationId).toBe('op-3');
  });

  it('returns local draft operation id when API responds with draft_id', async () => {
    jest.spyOn(service, 'post').mockResolvedValue({
      data: { draft_id: 777 },
    } as any);

    const operationId = await service.createDraft(
      {
        clusterIds: [200],
        macrolocalClusterId: 200,
        items: [{ sku: 111, quantity: 5 }],
        type: 'DIRECT',
      },
      credentials,
    );

    expect(operationId).toBe('draft-777');
  });

  it('throws readable error when API responds with errors and no ids', async () => {
    jest.spyOn(service, 'post').mockResolvedValue({
      data: {
        draft_id: 0,
        errors: [{ error_message: 'UNSPECIFIED', error_reasons: ['BAD_ITEM'] }],
      },
    } as any);

    await expect(
      service.createDraft(
        {
          clusterIds: [200],
          macrolocalClusterId: 200,
          items: [{ sku: 111, quantity: 5 }],
          type: 'DIRECT',
        },
        credentials,
      ),
    ).rejects.toThrow('createDraft returned errors: UNSPECIFIED');
  });
});

describe('OzonApiService.getDraftTimeslots', () => {
  const http = { axiosRef: { request: jest.fn() } } as any;
  const config = { get: jest.fn() } as any;
  const credentials = { clientId: 'client', apiKey: 'key' };

  let service: OzonApiService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OzonApiService(http, config);
  });

  it('normalizes new result format and appends timezone marker to local datetime strings', async () => {
    jest.spyOn(service, 'post').mockResolvedValue({
      data: {
        result: {
          drop_off_warehouse_timeslots: {
            warehouse_timezone: 'Asia/Yekaterinburg',
            current_time_in_timezone: '2026-03-13T11:19:15',
            days: [
              {
                date_in_timezone: '2026-03-13',
                timeslots: [
                  {
                    from_in_timezone: '2026-03-13T13:00:00',
                    to_in_timezone: '2026-03-13T14:00:00',
                  },
                ],
              },
            ],
          },
        },
      },
    } as any);

    const response = await service.getDraftTimeslots(
      {
        draftId: 1,
        warehouseIds: [2],
        dateFrom: '2026-03-12',
        dateTo: '2026-03-15',
        supplyType: 'CROSSDOCK',
      },
      credentials,
    );

    expect(response.drop_off_warehouse_timeslots?.length).toBe(1);
    expect(response.drop_off_warehouse_timeslots?.[0].current_time_in_timezone).toBe('2026-03-13T11:19:15Z');
    expect(response.drop_off_warehouse_timeslots?.[0].days?.[0].timeslots?.[0]).toEqual({
      from_in_timezone: '2026-03-13T13:00:00Z',
      to_in_timezone: '2026-03-13T14:00:00Z',
    });
  });
});
