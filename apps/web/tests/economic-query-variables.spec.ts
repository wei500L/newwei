import { describe, expect, it } from 'vitest';

import {
  buildEconomicQueryVariables,
  buildEconomicSeriesMap,
} from '../hooks/useEconomicData';
import {
  EconomicDataValueType,
  TimeGranularity,
  type EconomicDataPointModel,
} from '../graphql/generated';

describe('economic query variables', () => {
  it('omits granularity so the backend can coarsen by category frequency', () => {
    const variables = buildEconomicQueryVariables(
      'economic-short',
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-24T00:00:00.000Z'),
    );

    expect(variables).toEqual({
      category: 'economic-short',
      timeRange: {
        start: '2026-03-01T00:00:00.000Z',
        end: '2026-03-24T00:00:00.000Z',
      },
    });
    expect('granularity' in variables).toBe(false);
  });

  it('uses the slug-default field key when sourceField is null', () => {
    const points: EconomicDataPointModel[] = [
      {
        timestamp: '2026-03-20T00:00:00.000Z',
        effectiveGranularity: TimeGranularity.Day,
        value: 12.3,
        unit: null,
        sourceField: null,
        dataType: EconomicDataValueType.Percent,
        item: {
          slug: 'demo_metric',
          displayName: 'Demo Metric',
          groupLabel: null,
          defaultUnit: '%',
          metadata: null,
        },
      },
    ];

    const seriesMap = buildEconomicSeriesMap(points);

    expect(seriesMap.demo_metric?.fields['demo_metric-default']).toMatchObject({
      key: 'demo_metric-default',
      label: 'Demo Metric',
      unit: '%',
      values: [
        {
          timestamp: '2026-03-20T00:00:00.000Z',
          value: 12.3,
        },
      ],
    });
  });
});
