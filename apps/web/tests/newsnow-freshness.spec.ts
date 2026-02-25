import { describe, expect, it } from 'vitest';

import {
  formatShortDuration,
  resolveNewsFreshnessState,
} from '../app/(app)/newsnow/lib/newsnow-freshness';

describe('newsnow freshness', () => {
  it('marks entries as fresh within interval', () => {
    const now = Date.parse('2026-02-25T08:00:00.000Z');
    const state = resolveNewsFreshnessState({
      updatedTime: '2026-02-25T07:59:00.000Z',
      intervalMs: 2 * 60 * 1000,
      nowMs: now,
    });

    expect(state.level).toBe('fresh');
    expect(state.delayMs).toBe(0);
    expect(state.nextRefreshInMs).toBeGreaterThan(0);
  });

  it('marks entries as stale after large delay', () => {
    const now = Date.parse('2026-02-25T08:30:00.000Z');
    const state = resolveNewsFreshnessState({
      updatedTime: '2026-02-25T08:00:00.000Z',
      intervalMs: 5 * 60 * 1000,
      nowMs: now,
    });

    expect(state.level).toBe('stale');
    expect(state.delayMs).toBeGreaterThan(0);
    expect(state.nextRefreshInMs).toBe(0);
  });

  it('formats duration for minute/hour boundaries', () => {
    expect(formatShortDuration(12_000)).toBe('12s');
    expect(formatShortDuration(125_000)).toBe('2m 5s');
    expect(formatShortDuration(3_720_000)).toBe('1h 2m');
  });
});
