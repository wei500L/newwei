import { ECONOMIC_DATA_SOURCE_DEFINITION_MAP } from './financial-data.definitions';

describe('Financial data definitions', () => {
  it('maps sp500_index to the yfinance history provider', () => {
    const sp500 = ECONOMIC_DATA_SOURCE_DEFINITION_MAP.get('sp500_index');

    expect(sp500).toBeDefined();
    expect(sp500?.provider).toBe('yfinance');
    expect(sp500?.sourceFunction).toBe('yfinance.history');
    expect(sp500?.endpoint).toBe('/v8/finance/chart');
    expect(sp500?.providerConfig).toMatchObject({
      kind: 'yfinance',
      symbol: '^GSPC',
      interval: '1d',
      period1: 0,
      period2: 'now',
      sourceFields: {
        open: 'open',
        high: 'high',
        low: 'low',
        close: 'close',
      },
    });
  });
});
