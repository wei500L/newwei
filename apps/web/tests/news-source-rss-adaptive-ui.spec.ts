import { describe, expect, it } from 'vitest';

import { resolveRssAdaptiveListUiModel } from '../lib/news-source-rss-adaptive-ui';

describe('news-source rss adaptive ui model', () => {
  it('returns null when schedule mode is cron', () => {
    const model = resolveRssAdaptiveListUiModel({
      config: {
        seed: {
          enabled: true,
          mode: 'rss',
          rssAdaptive: { enabled: true }
        },
        schedule: {
          mode: ' cron '
        }
      },
      frequencySeconds: 300,
      rssAdaptiveState: {
        outcomes: [true, true, false],
        consecutiveNoHit: 0,
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    });

    expect(model).toBeNull();
  });

  it('returns adaptive model for non-cron rss sources', () => {
    const model = resolveRssAdaptiveListUiModel({
      config: {
        seed: {
          enabled: true,
          mode: 'rss',
          rssAdaptive: { enabled: true }
        }
      },
      frequencySeconds: 300,
      rssAdaptiveState: {
        outcomes: [true, true, false],
        consecutiveNoHit: 0,
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    });

    expect(model).toEqual(
      expect.objectContaining({
        tier: 'hot',
        effectiveIntervalSeconds: 30,
        effectiveDiscoveryCacheTtlSeconds: 30
      })
    );
  });

  it('applies source priority bias when computing tier', () => {
    const model = resolveRssAdaptiveListUiModel({
      config: {
        seed: {
          enabled: true,
          mode: 'rss',
          rssAdaptive: { enabled: true }
        }
      },
      frequencySeconds: 300,
      priority: -80,
      rssAdaptiveState: {
        outcomes: [true, false, false],
        consecutiveNoHit: 0,
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    });

    expect(model).toEqual(
      expect.objectContaining({
        tier: 'normal',
        effectiveIntervalSeconds: 300
      })
    );
  });
});
