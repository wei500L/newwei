import { AKSHARE_DATA_DEFINITIONS } from './akshare.definitions';

describe('Akshare definitions', () => {
  const findDefinition = (slug: string) => AKSHARE_DATA_DEFINITIONS.find((item) => item.slug === slug);

  it('keeps definition ids and slugs unique', () => {
    const ids = AKSHARE_DATA_DEFINITIONS.map((item) => item.id);
    const slugs = AKSHARE_DATA_DEFINITIONS.map((item) => item.slug);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('includes all known macro_fx_sentiment fields', () => {
    const definition = findDefinition('macro_fx_sentiment');
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
    const usd = findDefinition('usd_cny_spot');
    expect(usd).toBeDefined();
    expect(usd?.endpoint).toBe('/fx_spot_quote');
    expect(usd?.defaultParams).toBeUndefined();
    expect(usd?.filter).toEqual({ field: '货币对', equals: 'USD/CNY' });
    expect((usd?.parser as any)?.valueFields?.[0]?.field).toBe('卖报价');

    const eur = findDefinition('eur_cny_spot');
    expect(eur).toBeDefined();
    expect(eur?.endpoint).toBe('/fx_spot_quote');
    expect(eur?.defaultParams).toBeUndefined();
    expect(eur?.filter).toEqual({ field: '货币对', equals: 'EUR/CNY' });
    expect((eur?.parser as any)?.valueFields?.[0]?.field).toBe('卖报价');
  });

  it('maps bitcoin spot fields per docs', () => {
    const btc = findDefinition('bitcoin_spot_price');
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

  it('maps SGE historical spot definitions to date/close columns', () => {
    const platinum = findDefinition('platinum_spot_sge');
    const palladium = findDefinition('palladium_spot_sge');

    expect((platinum?.parser as any)?.timestampField).toBe('date');
    expect((platinum?.parser as any)?.valueFields?.[0]?.field).toBe('close');
    expect((palladium?.parser as any)?.timestampField).toBe('date');
    expect((palladium?.parser as any)?.valueFields?.[0]?.field).toBe('close');
  });

  it('maps audited US macro definitions to Chinese columns', () => {
    const unemployment = findDefinition('us_unemployment_rate');
    const nonFarm = findDefinition('us_non_farm_payrolls');
    const corePce = findDefinition('us_core_pce');

    expect((unemployment?.parser as any)?.type).toBe('macro');
    expect((unemployment?.parser as any)?.periodField).toBe('日期');
    expect((unemployment?.parser as any)?.valueFields?.map((field: any) => field.field)).toEqual([
      '今值',
      '预测值',
      '前值',
    ]);

    expect((nonFarm?.parser as any)?.type).toBe('macro');
    expect((nonFarm?.parser as any)?.periodField).toBe('日期');
    expect((nonFarm?.parser as any)?.valueFields?.map((field: any) => field.field)).toEqual([
      '今值',
      '预测值',
      '前值',
    ]);

    expect((corePce?.parser as any)?.type).toBe('macro');
    expect((corePce?.parser as any)?.periodField).toBe('日期');
    expect((corePce?.parser as any)?.valueFields?.map((field: any) => field.field)).toEqual([
      '今值',
      '预测值',
      '前值',
    ]);
  });

  it('maps crypto-js-spot to Chinese realtime columns', () => {
    const crypto = findDefinition('crypto_js_spot');

    expect((crypto?.parser as any)?.type).toBe('latest');
    expect((crypto?.parser as any)?.timestampField).toBe('更新时间');
    expect((crypto?.parser as any)?.categoryField).toBe('交易品种');
    expect((crypto?.parser as any)?.valueFields?.map((field: any) => field.field)).toEqual([
      '最近报价',
      '24小时成交量',
    ]);
  });

  it('maps sp500 em history to 东方财富 global history fields', () => {
    const sp500 = findDefinition('sp500_index_em_hist');

    expect(sp500?.endpoint).toBe('/index_global_hist_em');
    expect(sp500?.defaultParams).toEqual({ symbol: '标普500' });
    expect((sp500?.parser as any)?.timestampField).toBe('日期');
    expect((sp500?.parser as any)?.valueFields?.map((field: any) => field.field)).toEqual([
      '今开',
      '最高',
      '最低',
      '最新价',
    ]);
  });

  it('adds explicit params and curve filter for china treasury yield', () => {
    const treasury = findDefinition('china_treasury_yield_curve');

    expect(treasury?.defaultParams).toEqual({
      start_date: '${TODAY_YYYYMMDD-3650}',
      end_date: '${TODAY_YYYYMMDD}',
    });
    expect(treasury?.filter).toEqual({
      field: '曲线名称',
      equals: '中债国债收益率曲线',
      mode: 'all',
    });
  });

  it('keeps tourism fx metrics separated by 指标', () => {
    const tourism = findDefinition('china_international_tourism_fx');

    expect((tourism?.parser as any)?.type).toBe('macro');
    expect((tourism?.parser as any)?.categoryField).toBe('指标');
  });
});
