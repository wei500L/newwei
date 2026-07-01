import { describe, expect, it } from 'vitest';

process.env.NEXT_PUBLIC_API_BASE_URL = 'https://example.com';

describe('estimateReadingTimeMinutes', () => {
  it('uses CJK character counts for long articles without whitespace', async () => {
    const { estimateReadingTimeMinutes } = await import(
      '../lib/use-user-news-read-milestones'
    );
    const text = '这是一个较长的中文段落'.repeat(180);

    expect(estimateReadingTimeMinutes(text)).toBeGreaterThan(1);
  });

  it('still estimates reading time from spaced words', async () => {
    const { estimateReadingTimeMinutes } = await import(
      '../lib/use-user-news-read-milestones'
    );
    const text = 'word '.repeat(420).trim();

    expect(estimateReadingTimeMinutes(text)).toBe(3);
  });
});
