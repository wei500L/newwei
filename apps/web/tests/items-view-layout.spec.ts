import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import {
  countItemsFilterDimensions,
  resolveItemsViewLayoutState
} from '../app/(app)/items/items-view-layout';

describe('items-view layout state', () => {
  it('uses backward-compatible defaults', () => {
    expect(resolveItemsViewLayoutState()).toEqual({
      experiencePreset: 'default',
      density: 'compact',
      filterBehavior: 'legacy',
      isReaderPreset: false,
      isLayeredFilters: false
    });
  });

  it('enables reader and layered flags when configured', () => {
    expect(
      resolveItemsViewLayoutState({
        experiencePreset: 'reader',
        density: 'comfortable',
        filterBehavior: 'layered'
      })
    ).toEqual({
      experiencePreset: 'reader',
      density: 'comfortable',
      filterBehavior: 'layered',
      isReaderPreset: true,
      isLayeredFilters: true
    });
  });

  it('counts active filter dimensions for badges and summaries', () => {
    expect(
      countItemsFilterDimensions({
        sourceIds: ['source-a'],
        regions: ['APAC'],
        topics: ['AI'],
        sentiments: ['positive', 'neutral'],
        dateRange: [dayjs('2026-02-01'), dayjs('2026-02-15')]
      })
    ).toBe(5);
  });
});
