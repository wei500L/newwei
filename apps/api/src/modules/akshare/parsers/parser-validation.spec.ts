import { EconomicDataValueType } from '@prisma/client';

import { LatestParser } from './latest.parser';
import { MacroParser } from './macro.parser';
import { TimeseriesParser } from './timeseries.parser';
import { YieldCurveParser } from './yield-curve.parser';

describe('Akshare parsers', () => {
  it('builds source fields with categoryField for timeseries payloads', () => {
    const parser = new TimeseriesParser();
    const points = parser.parse(
      {
        type: 'timeseries',
        timestampField: '更新时间',
        categoryField: '交易品种',
        valueFields: [{ field: '最近报价', unit: 'USD', dataType: EconomicDataValueType.price }],
      },
      [{ 更新时间: '2026-03-14 08:00:00', 交易品种: 'BTCUSD', 最近报价: 92000 }],
      { slug: 'crypto_js_spot' },
    );

    expect(points).toHaveLength(1);
    expect(points[0]?.sourceField).toBe('BTCUSD:最近报价');
  });

  it('builds source fields with categoryField for macro payloads', () => {
    const parser = new MacroParser();
    const points = parser.parse(
      {
        type: 'macro',
        periodField: '统计年度',
        categoryField: '指标',
        valueFields: [{ field: '数量', unit: '百万美元', dataType: EconomicDataValueType.index }],
      },
      [{ 统计年度: '2019', 指标: '餐饮', 数量: 16041 }],
      { slug: 'china_international_tourism_fx' },
    );

    expect(points).toHaveLength(1);
    expect(points[0]?.sourceField).toBe('餐饮:数量');
  });

  it('fails fast when a configured timestamp field disappears', () => {
    const parser = new LatestParser();

    expect(() =>
      parser.parse(
        {
          type: 'latest',
          timestampField: '更新时间',
          categoryField: '交易品种',
          valueFields: [{ field: '最近报价', unit: 'USD', dataType: EconomicDataValueType.price }],
        },
        [{ 交易品种: 'BTCUSD', 最近报价: 92000 }],
        { slug: 'crypto_js_spot' },
      ),
    ).toThrow(/更新时间/);
  });

  it('parses all filtered yield-curve rows without collapsing the series', () => {
    const parser = new YieldCurveParser();
    const points = parser.parse(
      {
        type: 'yieldCurve',
        dateField: '日期',
        seriesFields: [
          { field: '3月', unit: '%', dataType: EconomicDataValueType.yield },
          { field: '10年', unit: '%', dataType: EconomicDataValueType.yield },
        ],
      },
      [
        { 日期: '2026-03-13', '3月': 1.8, '10年': 2.6 },
        { 日期: '2026-03-14', '3月': 1.9, '10年': 2.7 },
      ],
      { slug: 'china_treasury_yield_curve' },
    );

    expect(points).toHaveLength(4);
    expect(points.map((point) => point.sourceField)).toEqual(['3月', '10年', '3月', '10年']);
  });
});
