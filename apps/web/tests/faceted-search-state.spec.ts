import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import {
  filterFacetOptions,
  getFacetedSelectionCounts,
  resolveFacetedDefaultActiveKeys
} from '../app/(app)/items/components/faceted-search-state';

describe('faceted-search state', () => {
  it('defaults layered expansion to groups with selected values only', () => {
    expect(
      resolveFacetedDefaultActiveKeys({
        behavior: 'layered',
        availableKeys: ['region', 'topic', 'sentiment'],
        filters: {
          regions: ['APAC'],
          sentiments: ['positive']
        }
      })
    ).toEqual(['region', 'sentiment']);
  });

  it('expands all groups in legacy mode', () => {
    expect(
      resolveFacetedDefaultActiveKeys({
        behavior: 'legacy',
        availableKeys: ['region', 'topic', 'sentiment'],
        filters: {}
      })
    ).toEqual(['region', 'topic', 'sentiment']);
  });

  it('computes selected summary counts including date range', () => {
    expect(
      getFacetedSelectionCounts({
        sourceIds: ['s1', 's2'],
        regions: ['APAC'],
        topics: ['AI', 'Finance'],
        sentiments: ['neutral'],
        dateRange: [dayjs('2026-02-01'), dayjs('2026-02-15')]
      })
    ).toEqual({
      sourceIds: 2,
      regions: 1,
      topics: 2,
      sentiments: 1,
      dateRange: 1
    });
  });

  it('filters section options case-insensitively', () => {
    expect(filterFacetOptions(['North America', 'Asia Pacific', 'Europe'], 'ASIA')).toEqual([
      'Asia Pacific'
    ]);
  });
});
