import { describe, expect, it } from 'vitest';

import { RSS_ITEMS_VIEW_PRESET } from '../app/(app)/rss/rss-reader-preset';

describe('rss reader preset', () => {
  it('locks RSS view to reader-focused defaults', () => {
    expect(RSS_ITEMS_VIEW_PRESET).toEqual({
      experiencePreset: 'reader',
      density: 'compact',
      filterBehavior: 'layered'
    });
  });
});
