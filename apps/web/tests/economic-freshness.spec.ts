import { describe, expect, it } from 'vitest';

import { deriveEconomicFreshness } from '../hooks/useEconomicData';
import { TimeGranularity } from '../graphql/generated';

describe('deriveEconomicFreshness', () => {
  it('uses the freshest series cadence instead of interleaving timestamps across series', () => {
    const points = [
      {
        timestamp: '2026-03-12T10:00:00.000Z',
        sourceField: 'latest',
        effectiveGranularity: TimeGranularity.Hour,
        item: { slug: 'series-a' },
      },
      {
        timestamp: '2026-03-12T11:00:00.000Z',
        sourceField: 'latest',
        effectiveGranularity: TimeGranularity.Hour,
        item: { slug: 'series-a' },
      },
      {
        timestamp: '2026-03-12T12:00:00.000Z',
        sourceField: 'latest',
        effectiveGranularity: TimeGranularity.Hour,
        item: { slug: 'series-a' },
      },
      {
        timestamp: '2026-03-12T10:02:00.000Z',
        sourceField: 'latest',
        effectiveGranularity: TimeGranularity.Hour,
        item: { slug: 'series-b' },
      },
      {
        timestamp: '2026-03-12T11:02:00.000Z',
        sourceField: 'latest',
        effectiveGranularity: TimeGranularity.Hour,
        item: { slug: 'series-b' },
      },
      {
        timestamp: '2026-03-12T12:02:00.000Z',
        sourceField: 'latest',
        effectiveGranularity: TimeGranularity.Hour,
        item: { slug: 'series-b' },
      },
      {
        timestamp: '2026-03-12T10:04:00.000Z',
        sourceField: 'latest',
        effectiveGranularity: TimeGranularity.Hour,
        item: { slug: 'series-c' },
      },
      {
        timestamp: '2026-03-12T11:04:00.000Z',
        sourceField: 'latest',
        effectiveGranularity: TimeGranularity.Hour,
        item: { slug: 'series-c' },
      },
      {
        timestamp: '2026-03-12T12:04:00.000Z',
        sourceField: 'latest',
        effectiveGranularity: TimeGranularity.Hour,
        item: { slug: 'series-c' },
      },
    ];

    const freshness = deriveEconomicFreshness(points);

    expect(freshness.latestTimestamp?.toISOString()).toBe('2026-03-12T12:04:00.000Z');
    expect(freshness.expectedIntervalMs).toBe(60 * 60 * 1000);
  });

  it('falls back to the freshest series granularity when only one point is present', () => {
    const freshness = deriveEconomicFreshness([
      {
        timestamp: '2026-03-01T00:00:00.000Z',
        sourceField: 'value',
        effectiveGranularity: TimeGranularity.Month,
        item: { slug: 'monthly-series' },
      },
    ]);

    expect(freshness.latestTimestamp?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(freshness.expectedIntervalMs).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
