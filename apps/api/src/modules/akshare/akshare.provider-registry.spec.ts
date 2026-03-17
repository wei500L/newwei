import { EconomicDataRunStatus, EconomicDataValueType } from '@prisma/client';

const economicProviderResponseCreateMock = jest.fn().mockResolvedValue(undefined);

jest.mock('@modular/mongo', () => ({
  AkshareResponseModel: {
    create: jest.fn().mockResolvedValue(undefined),
  },
  EconomicProviderResponseModel: {
    create: (...args: unknown[]) => economicProviderResponseCreateMock(...args),
  },
}));

import { AkshareService } from './akshare.service';
import { FinancialDataProviderConfigurationError } from './providers/financial-data-provider';

describe('AkshareService provider-aware fetch handling', () => {
  it('marks missing provider secrets without throwing when a provider is not configured', async () => {
    economicProviderResponseCreateMock.mockClear();
    const prisma = {
      economicDataFetchConfig: {
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const providerRegistry = {
      get: jest.fn().mockReturnValue({
        fetch: jest
          .fn()
          .mockRejectedValue(
            new FinancialDataProviderConfigurationError(
              'missing_api_key:fredApiKey',
              'missing_api_key',
            ),
          ),
      }),
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      providerRegistry as any,
    );

    jest
      .spyOn(service as any, 'loadDefinitionFromDatabase')
      .mockResolvedValue({
        itemId: 'item-fred',
        slug: 'us_fed_funds_rate',
        displayName: 'US Fed Funds Rate',
        categories: ['macro-us'],
        sourceFunction: 'fred.series.observations',
        endpoint: '/series/observations',
        docUrl: 'https://fred.stlouisfed.org',
        valueType: EconomicDataValueType.percent,
        defaultUnit: '%',
        defaultFrequency: 'daily',
        providerKind: 'fred',
        providerConfig: {
          kind: 'fred',
          seriesId: 'FEDFUNDS',
          endpoint: '/series/observations',
          docUrl: 'https://fred.stlouisfed.org',
          metric: 'latest',
          sourceField: 'FEDFUNDS',
          precision: 2,
          transform: 'identity',
        },
        requiresSecret: 'fredApiKey',
        defaultEnabled: false,
        mainlineRole: 'canonical',
        tags: [],
      });

    await expect(service.fetchAndPersist('us_fed_funds_rate')).resolves.toBe(0);
    expect(prisma.economicDataFetchConfig.update).toHaveBeenCalledWith({
      where: { itemId: 'item-fred' },
      data: expect.objectContaining({
        lastStatus: EconomicDataRunStatus.failed,
        lastError: 'missing_api_key:fredApiKey',
      }),
    });
    expect(economicProviderResponseCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataItemId: 'us_fed_funds_rate',
        providerKind: 'fred',
        providerIdentity: 'FEDFUNDS',
        status: 'skipped',
      }),
    );
  });

  it('deletes stale incomplete timestamps before upserting provider points', async () => {
    economicProviderResponseCreateMock.mockClear();
    const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    const executeRaw = jest.fn().mockResolvedValue(4);
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      economicDataPoint: {
        deleteMany,
      },
      economicDataFetchConfig: {
        update,
      },
      $executeRaw: executeRaw,
    };
    const providerRegistry = {
      get: jest.fn().mockReturnValue({
        fetch: jest.fn().mockResolvedValue({
          payload: { source: 'yfinance' },
          cleanup: {
            deleteRecordedAts: [new Date('2026-03-16T13:30:00.000Z')],
          },
          points: [
            {
              recordedAt: new Date('2026-03-17T00:00:00.000Z'),
              value: 6700.12,
              unit: 'pts',
              dataType: EconomicDataValueType.index,
              sourceField: 'open',
            },
            {
              recordedAt: new Date('2026-03-17T00:00:00.000Z'),
              value: 6725.44,
              unit: 'pts',
              dataType: EconomicDataValueType.index,
              sourceField: 'high',
            },
            {
              recordedAt: new Date('2026-03-17T00:00:00.000Z'),
              value: 6688.55,
              unit: 'pts',
              dataType: EconomicDataValueType.index,
              sourceField: 'low',
            },
            {
              recordedAt: new Date('2026-03-17T00:00:00.000Z'),
              value: 6712.31,
              unit: 'pts',
              dataType: EconomicDataValueType.index,
              sourceField: 'close',
            },
          ],
        }),
      }),
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      providerRegistry as any,
    );

    jest
      .spyOn(service as any, 'loadDefinitionFromDatabase')
      .mockResolvedValue({
        itemId: 'item-sp500',
        slug: 'sp500_index',
        displayName: 'S&P 500 Index',
        categories: ['key-monitor'],
        sourceFunction: 'yfinance.history',
        endpoint: '/v8/finance/chart',
        docUrl: 'https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.history.html',
        valueType: EconomicDataValueType.index,
        defaultUnit: 'pts',
        defaultFrequency: 'daily',
        providerKind: 'yfinance',
        providerConfig: {
          kind: 'yfinance',
          symbol: '^GSPC',
          endpoint: '/v8/finance/chart',
          docUrl: 'https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.history.html',
          interval: '1d',
          period1: 0,
          period2: 'now',
        },
        defaultEnabled: true,
        mainlineRole: 'canonical',
        tags: [],
      });

    await expect(service.fetchAndPersist('sp500_index')).resolves.toBe(4);

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        itemId: 'item-sp500',
        recordedAt: {
          in: [new Date('2026-03-16T13:30:00.000Z')],
        },
      },
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      executeRaw.mock.invocationCallOrder[0],
    );
    expect(update).toHaveBeenCalledWith({
      where: { itemId: 'item-sp500' },
      data: expect.objectContaining({
        lastStatus: EconomicDataRunStatus.success,
        lastError: null,
      }),
    });
    expect(economicProviderResponseCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataItemId: 'sp500_index',
        providerKind: 'yfinance',
        providerIdentity: '^GSPC',
        status: 'success',
      }),
    );
  });
});
