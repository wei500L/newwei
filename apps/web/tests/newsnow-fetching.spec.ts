import { describe, expect, it } from 'vitest';

import {
  normalizeNewsnowSourceIds,
  resolveNewsSourceRefetchInterval,
  shouldRefetchNewsSourceFromRealtimeEvent,
} from '../app/(app)/newsnow/lib/newsnow-fetching';

describe('newsnow fetching helpers', () => {
  it('normalizes visible source ids', () => {
    expect(
      normalizeNewsnowSourceIds([' weibo ', 'hackernews', '', 'weibo']),
    ).toEqual(['weibo', 'hackernews']);
  });

  it('stops polling when realtime is connected or source is hidden', () => {
    expect(
      resolveNewsSourceRefetchInterval({
        enabled: true,
        interval: 120_000,
        realtimeConnected: false,
      }),
    ).toBe(120_000);

    expect(
      resolveNewsSourceRefetchInterval({
        enabled: true,
        interval: 120_000,
        realtimeConnected: true,
      }),
    ).toBe(false);

    expect(
      resolveNewsSourceRefetchInterval({
        enabled: false,
        interval: 120_000,
        realtimeConnected: false,
      }),
    ).toBe(false);
  });

  it('only refetches source queries for visible realtime updates', () => {
    expect(
      shouldRefetchNewsSourceFromRealtimeEvent({
        sourceId: 'weibo',
        visibleSourceIds: ['weibo', 'hackernews'],
      }),
    ).toBe(true);

    expect(
      shouldRefetchNewsSourceFromRealtimeEvent({
        sourceId: 'baidu',
        visibleSourceIds: ['weibo', 'hackernews'],
      }),
    ).toBe(false);
  });
});
