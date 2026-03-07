import { describe, expect, it } from 'vitest';

import {
  getNewsItemStableKey,
  sanitizeNewsItems,
} from '../app/(app)/newsnow/lib/newsnow-items';

describe('newsnow source item normalization', () => {
  it('dedupes repeated source entries by url while preserving order', () => {
    const items = sanitizeNewsItems([
      {
        id: 'https://news.ifeng.com/c/8rIrbm4QTxl',
        title: 'Item A',
        url: 'https://news.ifeng.com/c/8rIrbm4QTxl',
        pubDate: 1,
      },
      {
        id: 'duplicate-id',
        title: 'Item A duplicate',
        url: 'https://news.ifeng.com/c/8rIrbm4QTxl',
        pubDate: 2,
      },
      {
        id: 'second-item',
        title: 'Item B',
        url: 'https://example.com/b',
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.id)).toEqual([
      'https://news.ifeng.com/c/8rIrbm4QTxl',
      'second-item',
    ]);
    expect(items[0]?.title).toBe('Item A');
  });

  it('creates a stable fallback key when source id is missing', () => {
    const [item] = sanitizeNewsItems([
      {
        title: 'No id item',
        url: 'https://example.com/no-id',
      },
    ]);

    expect(item).toBeDefined();
    expect(item?.id).toBe('https://example.com/no-id');
    expect(getNewsItemStableKey(item ?? {}, 0)).toBe('https://example.com/no-id');
  });
});
