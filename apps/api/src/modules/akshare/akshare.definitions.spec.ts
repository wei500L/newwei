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

  it('defines usd/eur cny spot via fx_spot_quote', () => {
    const usd = AKSHARE_DATA_DEFINITIONS.find((item) => item.slug === 'usd_cny_spot');
    expect(usd).toBeDefined();
    expect(usd?.endpoint).toBe('/fx_spot_quote');
    expect(usd?.defaultParams).toBeUndefined();
    expect(usd?.filter).toEqual({ field: '货币对', equals: 'USD/CNY' });
    expect((usd?.parser as any)?.valueFields?.[0]?.field).toBe('卖报价');

    const eur = AKSHARE_DATA_DEFINITIONS.find((item) => item.slug === 'eur_cny_spot');
    expect(eur).toBeDefined();
    expect(eur?.endpoint).toBe('/fx_spot_quote');
    expect(eur?.defaultParams).toBeUndefined();
    expect(eur?.filter).toEqual({ field: '货币对', equals: 'EUR/CNY' });
    expect((eur?.parser as any)?.valueFields?.[0]?.field).toBe('卖报价');
  });

  it('maps bitcoin spot fields per docs', () => {
    const btc = AKSHARE_DATA_DEFINITIONS.find((item) => item.slug === 'bitcoin_spot_price');
    expect(btc).toBeDefined();
    expect(btc?.endpoint).toBe('/crypto_js_spot');
    expect(btc?.defaultParams).toBeUndefined();
    expect(btc?.filter).toMatchObject({
      field: '交易品种',
      equals: 'BTCUSD',
      mode: 'best',
      preferNonZeroField: '最近报价',
      rankBy: '24小时成交量',
      rankOrder: 'desc',
    });
    expect((btc?.parser as any)?.timestampField).toBe('更新时间');
    expect((btc?.parser as any)?.valueFields?.[0]?.field).toBe('最近报价');
  });
});
