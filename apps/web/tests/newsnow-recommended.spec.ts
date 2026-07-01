import { describe, expect, it } from 'vitest';

import { buildNewsnowRecommendedNotInterestedPayload } from '../app/(app)/newsnow/hooks/newsnow-recommended-feedback';
import {
  NEWSNOW_RECOMMENDED_QUERY_KEY_PREFIX,
  buildNewsnowRecommendedQueryKey,
} from '../app/(app)/newsnow/hooks/newsnow-recommended-query';
import type { NewsnowRecommendedItem } from '../app/(app)/newsnow/hooks/use-newsnow-recommended';

describe('newsnow recommended query key', () => {
  it('scopes personalized recommendations to org and user identity', () => {
    expect(
      buildNewsnowRecommendedQueryKey({
        orgId: 'org-1',
        userId: 'user-1',
        limit: 30,
      }),
    ).toEqual([NEWSNOW_RECOMMENDED_QUERY_KEY_PREFIX, 'org-1', 'user-1', 30]);
  });

  it('uses anonymous placeholders before the session resolves', () => {
    expect(
      buildNewsnowRecommendedQueryKey({
        orgId: null,
        userId: null,
        limit: 12,
      }),
    ).toEqual([
      NEWSNOW_RECOMMENDED_QUERY_KEY_PREFIX,
      'anonymous-org',
      'anonymous-user',
      12,
    ]);
  });

  it('builds not-interested payloads with one target family in priority order', () => {
    const baseItem: NewsnowRecommendedItem = {
      id: 'recommended-1',
      sourceId: 'weibo',
      sourceName: '微博',
      title: 'AI story',
      url: 'https://example.com/ai-story',
      topics: ['ai'],
      entities: ['openai'],
      reasonLabel: '当前热度较高',
      score: 0.8,
      scoreBreakdown: {
        content: 0,
        collaborative: 0,
        source: 0,
        hotness: 0.8,
        final: 0.12,
      },
    };

    expect(
      buildNewsnowRecommendedNotInterestedPayload({
        ...baseItem,
        matchedItemId: 'item-1',
        matchedEventId: 'event-1',
      }),
    ).toEqual({ type: 'not_interested', itemId: 'item-1' });
    expect(
      buildNewsnowRecommendedNotInterestedPayload({
        ...baseItem,
        topics: [],
        matchedEventId: 'event-1',
      }),
    ).toEqual({ type: 'not_interested', eventId: 'event-1' });
    expect(buildNewsnowRecommendedNotInterestedPayload(baseItem)).toEqual({
      type: 'not_interested',
      topics: ['ai'],
    });
    expect(
      buildNewsnowRecommendedNotInterestedPayload({
        ...baseItem,
        topics: [],
      }),
    ).toEqual({ type: 'not_interested', entities: ['openai'] });
    expect(
      buildNewsnowRecommendedNotInterestedPayload({
        ...baseItem,
        topics: [],
        entities: [],
      }),
    ).toEqual({ type: 'not_interested', source: 'weibo' });
  });
});
