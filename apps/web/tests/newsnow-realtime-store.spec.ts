import { beforeEach, describe, expect, it } from 'vitest';

import { useNewsnowStore } from '../app/(app)/newsnow/store/newsnow-store';

describe('newsnow realtime store', () => {
  beforeEach(() => {
    useNewsnowStore.setState({
      visibleSourceIds: [],
      sourceSnapshots: {},
      sourceSnapshotHashes: {},
      liveUnreadBySource: {},
      realtimeHighlights: [],
      lastRealtimeEventAt: undefined,
      realtimeConnected: false,
      realtimeConnectionError: undefined,
    });
  });

  it('records realtime arrivals with unread count and highlights', () => {
    useNewsnowStore.getState().recordRealtimeArrival({
      sourceId: 'weibo',
      count: 2,
      topTitles: ['title a', 'title b'],
      timestamp: '2026-02-25T08:00:00.000Z',
    });

    const state = useNewsnowStore.getState();
    expect(state.liveUnreadBySource.weibo).toBe(2);
    expect(state.realtimeHighlights.length).toBe(1);
    expect(state.realtimeHighlights[0]).toMatchObject({
      sourceId: 'weibo',
      count: 2,
      topTitles: ['title a', 'title b'],
    });
    expect(typeof state.lastRealtimeEventAt).toBe('number');
  });

  it('clearLiveUnread removes source unread and related highlights', () => {
    const store = useNewsnowStore.getState();
    store.recordRealtimeArrival({ sourceId: 'weibo', count: 1, timestamp: '2026-02-25T08:00:00.000Z' });
    store.recordRealtimeArrival({ sourceId: 'hackernews', count: 3, timestamp: '2026-02-25T08:00:01.000Z' });

    useNewsnowStore.getState().clearLiveUnread('weibo');

    const state = useNewsnowStore.getState();
    expect(state.liveUnreadBySource.weibo).toBeUndefined();
    expect(state.liveUnreadBySource.hackernews).toBe(3);
    expect(state.realtimeHighlights.every((entry) => entry.sourceId !== 'weibo')).toBe(true);
  });

  it('clearAllLiveUnread clears all unread and highlights', () => {
    const store = useNewsnowStore.getState();
    store.recordRealtimeArrival({ sourceId: 'weibo', count: 1 });
    store.recordRealtimeArrival({ sourceId: 'hackernews', count: 1 });

    useNewsnowStore.getState().clearAllLiveUnread();

    const state = useNewsnowStore.getState();
    expect(state.liveUnreadBySource).toEqual({});
    expect(state.realtimeHighlights).toEqual([]);
  });

  it('tracks visible sources without duplicates and clears them on hide', () => {
    const store = useNewsnowStore.getState();

    store.setSourceVisibility('weibo', true);
    store.setSourceVisibility('weibo', true);
    store.setSourceVisibility('hackernews', true);

    expect(useNewsnowStore.getState().visibleSourceIds).toEqual([
      'weibo',
      'hackernews',
    ]);

    useNewsnowStore.getState().setSourceVisibility('weibo', false);

    expect(useNewsnowStore.getState().visibleSourceIds).toEqual([
      'hackernews',
    ]);
  });

  it('skips source snapshot writes when the incoming items are unchanged', () => {
    const store = useNewsnowStore.getState();
    const snapshot = {
      updatedAt: 1,
      items: [
        {
          id: 'item-1',
          title: 'Alpha',
          pubDate: '2026-03-22T00:00:00.000Z',
          url: 'https://example.com/a',
        },
      ],
    };

    store.upsertSourceSnapshot('weibo', snapshot);
    const firstState = useNewsnowStore.getState();
    const firstSnapshots = firstState.sourceSnapshots;

    store.upsertSourceSnapshot('weibo', {
      updatedAt: 2,
      items: snapshot.items.map((item) => ({ ...item })),
    });

    const secondState = useNewsnowStore.getState();
    expect(secondState.sourceSnapshots).toBe(firstSnapshots);
    expect(secondState.sourceSnapshotHashes.weibo).toBeDefined();
  });
});
