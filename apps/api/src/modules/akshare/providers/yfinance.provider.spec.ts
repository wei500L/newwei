import { EconomicDataValueType } from '@prisma/client';
import axios from 'axios';

import { YfinanceFinancialDataProvider } from './yfinance.provider';

jest.mock('axios');

describe('YfinanceFinancialDataProvider', () => {
  const mockedAxiosGet = axios.get as jest.MockedFunction<typeof axios.get>;

  afterEach(() => {
    mockedAxiosGet.mockReset();
    jest.restoreAllMocks();
  });

  it('maps Yahoo Finance chart history into OHLC points', async () => {
    mockedAxiosGet.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      data: JSON.stringify({
        chart: {
          result: [
            {
              meta: {
                currency: 'USD',
                exchangeName: 'SNP',
                fullExchangeName: 'SNP',
                instrumentType: 'INDEX',
                regularMarketPrice: 5105.21,
                symbol: '^GSPC',
              },
              timestamp: [1710374400, 1710460800],
              indicators: {
                quote: [
                  {
                    open: [5080.12, 5092.5],
                    high: [5098.44, 5110.33],
                    low: [5074.2, 5087.11],
                    close: [5094.77, 5105.21],
                  },
                ],
              },
            },
          ],
          error: null,
        },
      }),
      headers: {},
      config: {} as never,
    });

    const provider = new YfinanceFinancialDataProvider();
    const result = await provider.fetch({
      itemId: 'item-sp500',
      slug: 'sp500_index',
      displayName: '标普500指数',
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
        period2: 1710547200,
        includePrePost: false,
        events: 'div,splits',
        sourceFields: {
          open: 'open',
          high: 'high',
          low: 'low',
          close: 'close',
        },
      },
      defaultEnabled: true,
      mainlineRole: 'canonical',
      snapshot: {
        group: 'markets',
        bucket: 'indices',
        symbol: '^GSPC',
        name: 'S&P 500',
        order: 10,
      },
      tags: [],
    });

    expect(mockedAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('/v8/finance/chart/%5EGSPC?'),
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'application/json',
        }),
      }),
    );
    expect(result.requestParams).toEqual({
      symbol: '^GSPC',
      interval: '1d',
      period1: 0,
      period2: 1710547200,
      includePrePost: false,
      events: 'div,splits',
    });
    expect(result.points).toHaveLength(8);
    expect(result.points[0]).toMatchObject({
      recordedAt: new Date(1710374400 * 1000),
      sourceField: 'open',
      value: 5080.12,
      unit: 'pts',
      dataType: EconomicDataValueType.index,
      meta: expect.objectContaining({
        providerSymbol: '^GSPC',
        displaySymbol: '^GSPC',
        instrumentType: 'INDEX',
      }),
    });
    expect(result.points[7]).toMatchObject({
      recordedAt: new Date(1710460800 * 1000),
      sourceField: 'close',
      value: 5105.21,
    });
    expect(result.cleanup).toBeUndefined();
  });

  it('skips incomplete OHLC candles and returns cleanup timestamps for stale rows', async () => {
    mockedAxiosGet.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      data: JSON.stringify({
        chart: {
          result: [
            {
              meta: {
                currency: 'USD',
                exchangeName: 'SNP',
                fullExchangeName: 'SNP',
                instrumentType: 'INDEX',
                regularMarketPrice: 5105.21,
                symbol: '^GSPC',
              },
              timestamp: [1710374400, 1710460800],
              indicators: {
                quote: [
                  {
                    open: [5080.12, 5092.5],
                    high: [5098.44, 5110.33],
                    low: [5074.2, 5087.11],
                    close: [5094.77, null],
                  },
                ],
              },
            },
          ],
          error: null,
        },
      }),
      headers: {},
      config: {} as never,
    });

    const provider = new YfinanceFinancialDataProvider();
    const result = await provider.fetch({
      itemId: 'item-sp500',
      slug: 'sp500_index',
      displayName: '标普500指数',
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
        period2: 1710547200,
        includePrePost: false,
        events: 'div,splits',
      },
      defaultEnabled: true,
      mainlineRole: 'canonical',
      tags: [],
    });

    expect(result.points).toHaveLength(4);
    expect(result.points.every((point) => point.recordedAt.getTime() === 1710374400 * 1000)).toBe(true);
    expect(result.cleanup).toEqual({
      deleteRecordedAts: [new Date(1710460800 * 1000)],
    });
  });

  it('retries throttled Yahoo responses before succeeding', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 429,
        statusText: 'Too Many Requests',
        data: 'Edge: Too Many Requests',
        headers: {},
        config: {} as never,
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  symbol: '^GSPC',
                },
                timestamp: [1710374400],
                indicators: {
                  quote: [
                    {
                      open: [5000],
                      high: [5050],
                      low: [4980],
                      close: [5040],
                    },
                  ],
                },
              },
            ],
            error: null,
          },
        }),
        headers: {},
        config: {} as never,
      });

    const provider = new YfinanceFinancialDataProvider();
    jest.spyOn(provider as any, 'delay').mockResolvedValue(undefined);

    const result = await provider.fetch({
      itemId: 'item-sp500',
      slug: 'sp500_index',
      displayName: '标普500指数',
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
        period2: 1710547200,
      },
      defaultEnabled: true,
      mainlineRole: 'canonical',
      tags: [],
    });

    expect(mockedAxiosGet).toHaveBeenCalledTimes(2);
    expect(result.points).toHaveLength(4);
  });
});
