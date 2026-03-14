import { AkshareParserService } from '../akshare-parser.service';
import { AkshareFinancialDataProvider } from './akshare.provider';

describe('AkshareFinancialDataProvider payload filtering', () => {
  const createProvider = () =>
    new AkshareFinancialDataProvider(
      {} as any,
      { akshareConfig: { enabled: true } } as any,
      new AkshareParserService(),
    );

  it('keeps all rows when filter mode is all', () => {
    const provider = createProvider();
    const filtered = (provider as any).applyPayloadFilter(
      [
        { 曲线名称: '中债国债收益率曲线', 日期: '2026-03-13' },
        { 曲线名称: '中债国债收益率曲线', 日期: '2026-03-14' },
        { 曲线名称: '中债商业银行普通债收益率曲线(AAA)', 日期: '2026-03-14' },
      ],
      {
        field: '曲线名称',
        equals: '中债国债收益率曲线',
        mode: 'all',
      },
    );

    expect(filtered).toEqual([
      { 曲线名称: '中债国债收益率曲线', 日期: '2026-03-13' },
      { 曲线名称: '中债国债收益率曲线', 日期: '2026-03-14' },
    ]);
  });

  it('selects the best row when filter mode is best', () => {
    const provider = createProvider();
    const filtered = (provider as any).applyPayloadFilter(
      [
        { 交易品种: 'BTCUSD', 最近报价: 0, '24小时成交量': 100 },
        { 交易品种: 'BTCUSD', 最近报价: 92100, '24小时成交量': 50 },
        { 交易品种: 'BTCUSD', 最近报价: 92050, '24小时成交量': 500 },
      ],
      {
        field: '交易品种',
        equals: 'BTCUSD',
        mode: 'best',
        preferNonZeroField: '最近报价',
        rankBy: '24小时成交量',
        rankOrder: 'desc',
      },
    );

    expect(filtered).toEqual({ 交易品种: 'BTCUSD', 最近报价: 92050, '24小时成交量': 500 });
  });

  it('throws when the filter does not match any records', () => {
    const provider = createProvider();

    expect(() =>
      (provider as any).applyPayloadFilter([{ 交易品种: 'ETHUSD' }], {
        field: '交易品种',
        equals: 'BTCUSD',
      }),
    ).toThrow(/交易品种=BTCUSD/);
  });
});
