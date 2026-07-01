import type { UserNewsBehaviorPayload } from '@/lib/user-news-behavior';

import type { NewsnowRecommendedItem } from './use-newsnow-recommended';

function firstNonEmpty(values: string[]) {
  if (!Array.isArray(values)) {
    return null;
  }
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function buildNewsnowRecommendedNotInterestedPayload(
  item: NewsnowRecommendedItem,
): UserNewsBehaviorPayload {
  if (item.matchedItemId) {
    return {
      type: 'not_interested',
      itemId: item.matchedItemId,
    };
  }
  if (item.matchedEventId) {
    return {
      type: 'not_interested',
      eventId: item.matchedEventId,
    };
  }

  const topic = firstNonEmpty(item.topics);
  if (topic) {
    return {
      type: 'not_interested',
      topics: [topic],
    };
  }

  const entity = firstNonEmpty(item.entities);
  if (entity) {
    return {
      type: 'not_interested',
      entities: [entity],
    };
  }

  return {
    type: 'not_interested',
    source: item.sourceId,
  };
}
