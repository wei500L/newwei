import { beforeEach, describe, expect, it } from 'vitest';

import { buildCrossSourceDedupResult } from '../app/(app)/newsnow/lib/newsnow-dnd';
import { useNewsnowStore } from '../app/(app)/newsnow/store/newsnow-store';

describe('newsnow realtime store', () => {
  beforeEach(() => {
    useNewsnowStore.setState({
      visibleSourceIds: [],
      sourceSnapshots: {},
      sourceSnapshotHashes: {},
      sourceUnreadItemIds: {},
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

  it('reconciles source unread items from snapshot diffs and clears them when seen', () => {
    const store = useNewsnowStore.getState();

    store.reconcileSourceItems('weibo', ['https://example.com/a']);
    store.upsertSourceSnapshot('weibo', {
      updatedAt: 1,
      items: [
        {
          id: 'https://example.com/a',
          title: 'Alpha',
          url: 'https://example.com/a',
        },
      ],
    });

    expect(useNewsnowStore.getState().sourceUnreadItemIds.weibo).toBeUndefined();

    store.reconcileSourceItems('weibo', [
      'https://example.com/b',
      'https://example.com/a',
    ]);
    store.upsertSourceSnapshot('weibo', {
      updatedAt: 2,
      items: [
        {
          id: 'https://example.com/b',
          title: 'Beta',
          url: 'https://example.com/b',
        },
        {
          id: 'https://example.com/a',
          title: 'Alpha',
          url: 'https://example.com/a',
        },
      ],
    });

    expect(useNewsnowStore.getState().sourceUnreadItemIds.weibo).toEqual([
      'https://example.com/b',
    ]);

    store.markSourceItemSeen('weibo', 'https://example.com/b');
    expect(useNewsnowStore.getState().sourceUnreadItemIds.weibo).toBeUndefined();
  });

  it('preserves snapshot-backed counts across remount-like replays of the same feed', () => {
    const store = useNewsnowStore.getState();

    store.reconcileSourceItems('weibo', ['https://example.com/a']);
    store.upsertSourceSnapshot('weibo', {
      updatedAt: 1,
      items: [
        {
          id: 'https://example.com/a',
          title: 'Shared headline',
          url: 'https://example.com/a',
        },
      ],
    });
    store.upsertSourceSnapshot('hackernews', {
      updatedAt: 1,
      items: [
        {
          id: 'https://news.ycombinator.com/a',
          title: 'Shared headline',
          url: 'https://news.ycombinator.com/a',
        },
      ],
    });

    store.reconcileSourceItems('weibo', [
      'https://example.com/b',
      'https://example.com/a',
    ]);
    store.upsertSourceSnapshot('weibo', {
      updatedAt: 2,
      items: [
        {
          id: 'https://example.com/b',
          title: 'Exclusive follow-up',
          url: 'https://example.com/b',
        },
        {
          id: 'https://example.com/a',
          title: 'Shared headline',
          url: 'https://example.com/a',
        },
      ],
    });

    const beforeReplay = buildCrossSourceDedupResult({
      sourceOrder: ['weibo', 'hackernews'],
      snapshots: useNewsnowStore.getState().sourceSnapshots,
      snapshotHashes: useNewsnowStore.getState().sourceSnapshotHashes,
    });

    expect(useNewsnowStore.getState().sourceUnreadItemIds.weibo).toEqual([
      'https://example.com/b',
    ]);
    expect(beforeReplay.duplicateItemsBySource.weibo).toBe(1);
    expect(beforeReplay.visibleItemsBySource.weibo).toBe(2);

    store.reconcileSourceItems('weibo', [
      'https://example.com/b',
      'https://example.com/a',
    ]);
    store.upsertSourceSnapshot('weibo', {
      updatedAt: 3,
      items: [
        {
          id: 'https://example.com/b',
          title: 'Exclusive follow-up',
          url: 'https://example.com/b',
        },
        {
          id: 'https://example.com/a',
          title: 'Shared headline',
          url: 'https://example.com/a',
        },
      ],
    });

    const afterReplay = buildCrossSourceDedupResult({
      sourceOrder: ['weibo', 'hackernews'],
      snapshots: useNewsnowStore.getState().sourceSnapshots,
      snapshotHashes: useNewsnowStore.getState().sourceSnapshotHashes,
    });

    expect(useNewsnowStore.getState().sourceUnreadItemIds.weibo).toEqual([
      'https://example.com/b',
    ]);
    expect(afterReplay.duplicateItemsBySource.weibo).toBe(1);
    expect(afterReplay.visibleItemsBySource.weibo).toBe(2);
  });
});
