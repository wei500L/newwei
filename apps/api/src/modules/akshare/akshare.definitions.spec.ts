import { AKSHARE_DATA_DEFINITIONS } from './akshare.definitions';

describe('Akshare definitions', () => {
  it('includes all known macro_fx_sentiment fields', () => {
    const definition = AKSHARE_DATA_DEFINITIONS.find((item) => item.slug === 'macro_fx_sentiment');
    expect(definition).toBeDefined();

    const parser = definition?.parser as any;
    expect(parser?.type).toBe('timeseries');

    const fields = (parser?.valueFields ?? []).map((field: any) => field.field);
    expect(fields).toEqual([
      'BTCUSD',
      'ETHUSD',
      'AUDJPY',
      'AUDUSD',
      'XBRUSD',
      'GER40',
      'EURAUD',
      'EURGBP',
      'EURJPY',
      'EURUSD',
      'GBPJPY',
      'GBPUSD',
      'NAS100',
      'NZDUSD',
      'SP500',
      'USDCAD',
      'USDCHF',
      'USDJPY',
      'XTIUSD',
      'XAGUSD',
      'XAUUSD',
      'US30',
      'GBPCHF',
      'EURCHF',
      'USDX',
    ]);
  });
});

