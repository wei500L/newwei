import { describe, expect, it } from 'vitest';

import {
  NEWSNOW_RECOMMENDED_QUERY_KEY_PREFIX,
  buildNewsnowRecommendedQueryKey,
} from '../app/(app)/newsnow/hooks/newsnow-recommended-query';

describe('newsnow recommended query key', () => {
  it('scopes personalized recommendations to org and user identity', () => {
    expect(
      buildNewsnowRecommendedQueryKey({
        orgId: 'org-1',
        userId: 'user-1',
        limit: 30,
      }),
    ).toEqual([
      NEWSNOW_RECOMMENDED_QUERY_KEY_PREFIX,
      'org-1',
      'user-1',
      30,
    ]);
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
});
