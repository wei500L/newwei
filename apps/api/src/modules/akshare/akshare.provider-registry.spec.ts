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
});
