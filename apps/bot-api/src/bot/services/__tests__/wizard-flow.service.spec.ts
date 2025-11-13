import { WizardFlowService } from '../wizard-flow.service';

const ozonApi = {
  searchFboWarehouses: jest.fn(),
  listClusters: jest.fn(),
  getDraftInfo: jest.fn(),
  getDraftTimeslots: jest.fn(),
  createDraft: jest.fn(),
  getSupplyCreateStatus: jest.fn(),
  cancelSupplyOrder: jest.fn(),
  getSupplyCancelStatus: jest.fn(),
  getSupplyOrders: jest.fn(),
  getProductsByOfferIds: jest.fn(),
};

const service = new WizardFlowService(ozonApi as any);

beforeEach(() => jest.clearAllMocks());

describe('WizardFlowService', () => {
  const credentials = { clientId: 'id', apiKey: 'key' };

  it('delegates searchDropOffs', async () => {
    ozonApi.searchFboWarehouses.mockResolvedValueOnce(['item']);
    const result = await service.searchDropOffs('query', credentials);
    expect(result).toEqual(['item']);
    expect(ozonApi.searchFboWarehouses).toHaveBeenCalledWith(
      { search: 'query', supplyTypes: ['CREATE_TYPE_CROSSDOCK'] },
      credentials,
    );
  });

  it('pickFirstTimeslot returns first valid slot', () => {
    const response = {
      drop_off_warehouse_timeslots: [
        {
          days: [
            {
              timeslots: [
                { from_in_timezone: '', to_in_timezone: '' },
                { from_in_timezone: 'a', to_in_timezone: 'b' },
              ],
            },
          ],
        },
      ],
    } as any;
    const slot = service.pickFirstTimeslot(response);
    expect(slot).toEqual({ from_in_timezone: 'a', to_in_timezone: 'b' });
  });

  it('delegates getSupplyOrders', async () => {
    ozonApi.getSupplyOrders.mockResolvedValueOnce([{ order_id: 1 }]);
    const orders = await service.getSupplyOrders([1], credentials);
    expect(orders).toEqual([{ order_id: 1 }]);
    expect(ozonApi.getSupplyOrders).toHaveBeenCalledWith([1], credentials);
  });
});
