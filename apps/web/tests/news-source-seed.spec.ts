import { describe, expect, it } from 'vitest';

import {
  buildSeedConfigFromFormValues,
  DEFAULT_SEED_SCHEDULER_RUNTIME_SETTINGS,
  DEFAULT_SEED_FORM_VALUES,
  getDefaultSeedCacheTtlSecondsByMode,
  resolveSeedRssAdaptiveDiscoveryCacheTtlSeconds,
  resolveSeedRssAdaptiveIntervalSeconds,
  resolveSeedRssAdaptiveTier,
  resolveSeedSchedulerRuntimeSettings,
  resolveSeedCacheTtlPolicy,
  readSeedFormValuesFromConfig
} from '../lib/news-source-seed';

describe('news-source seed config mapping', () => {
  it('reads list seed defaults and pagination fields from config', () => {
    const values = readSeedFormValuesFromConfig({
      seed: {
        enabled: true,
        mode: 'list',
        maxUrls: 320,
        maxNewUrlsPerRun: 120,
        listMaxPages: 9,
        listPageConcurrency: 3,
        followPagination: false
      }
    });

    expect(values.seedEnabled).toBe(true);
    expect(values.seedMode).toBe('list');
    expect(values.seedMaxUrls).toBe(320);
    expect(values.seedMaxNewUrlsPerRun).toBe(120);
    expect(values.seedListMaxPages).toBe(9);
    expect(values.seedListPageConcurrency).toBe(3);
    expect(values.seedFollowPagination).toBe(false);
  });

  it('falls back to new recommended defaults for missing values', () => {
    const values = readSeedFormValuesFromConfig({});

    expect(values.seedMaxUrls).toBe(DEFAULT_SEED_FORM_VALUES.seedMaxUrls);
    expect(values.seedMaxNewUrlsPerRun).toBe(DEFAULT_SEED_FORM_VALUES.seedMaxNewUrlsPerRun);
    expect(values.seedListMaxPages).toBe(DEFAULT_SEED_FORM_VALUES.seedListMaxPages);
    expect(values.seedListPageConcurrency).toBe(DEFAULT_SEED_FORM_VALUES.seedListPageConcurrency);
    expect(values.seedFollowPagination).toBe(DEFAULT_SEED_FORM_VALUES.seedFollowPagination);
  });

  it('uses mode-aware cache TTL defaults when cacheTtlSeconds is missing', () => {
    const listValues = readSeedFormValuesFromConfig({
      seed: {
        enabled: true,
        mode: 'list'
      }
    });
    const rssValues = readSeedFormValuesFromConfig({
      seed: {
        enabled: true,
        mode: 'rss'
      }
    });

    expect(listValues.seedCacheTtlSeconds).toBe(getDefaultSeedCacheTtlSecondsByMode('list'));
    expect(rssValues.seedCacheTtlSeconds).toBe(getDefaultSeedCacheTtlSecondsByMode('rss'));
  });

  it('reads rss adaptive setting from config', () => {
    const values = readSeedFormValuesFromConfig({
      seed: {
        enabled: true,
        mode: 'rss',
        rssAdaptive: {
          enabled: true
        }
      }
    });

    expect(values.seedMode).toBe('rss');
    expect(values.seedRssAdaptiveEnabled).toBe(true);
  });

  it('applies runtime scheduler defaults for missing cache ttl', () => {
    const values = readSeedFormValuesFromConfig(
      {
        seed: {
          enabled: true,
          mode: 'list'
        }
      },
      {
        seedCacheTtlSecondsSitemapRss: 75,
        seedCacheTtlSecondsListDeep: 240,
        seedCacheTtlForceGlobal: false
      }
    );

    expect(values.seedCacheTtlSeconds).toBe(240);
  });

  it('resolves effective cache ttl with source override when global force is off', () => {
    const resolved = resolveSeedCacheTtlPolicy(
      'sitemap',
      900,
      {
        ...DEFAULT_SEED_SCHEDULER_RUNTIME_SETTINGS,
        seedCacheTtlForceGlobal: false
      }
    );

    expect(resolved.isGlobalForced).toBe(false);
    expect(resolved.modeDefaultCacheTtlSeconds).toBe(60);
    expect(resolved.sourceSeedCacheTtlSeconds).toBe(900);
    expect(resolved.effectiveCacheTtlSeconds).toBe(900);
  });

  it('resolves effective cache ttl with global defaults when force is on', () => {
    const resolved = resolveSeedCacheTtlPolicy(
      'deep',
      900,
      {
        seedCacheTtlForceGlobal: true,
        seedCacheTtlSecondsSitemapRss: 75,
        seedCacheTtlSecondsListDeep: 210
      }
    );

    expect(resolved.isGlobalForced).toBe(true);
    expect(resolved.modeDefaultCacheTtlSeconds).toBe(210);
    expect(resolved.sourceSeedCacheTtlSeconds).toBe(900);
    expect(resolved.effectiveCacheTtlSeconds).toBe(210);
  });

  it('builds list seed config with pagination settings', () => {
    const next = buildSeedConfigFromFormValues(
      {
        seedEnabled: true,
        seedMode: 'list',
        seedDomain: 'https://example.com',
        seedPattern: 'https://example.com/news/*',
        seedMaxUrls: 200,
        seedMaxNewUrlsPerRun: 80,
        seedListMaxPages: 6,
        seedListPageConcurrency: 2,
        seedFollowPagination: true
      },
      null
    );

    expect(next).toEqual(
      expect.objectContaining({
        seed: expect.objectContaining({
          enabled: true,
          mode: 'list',
          domain: 'https://example.com',
          pattern: 'https://example.com/news/*',
          maxUrls: 200,
          maxNewUrlsPerRun: 80,
          listMaxPages: 6,
          listPageConcurrency: 2,
          followPagination: true
        })
      })
    );
  });

  it('reads deep seed defaults and deep settings from config', () => {
    const values = readSeedFormValuesFromConfig({
      seed: {
        enabled: true,
        mode: 'deep',
        maxUrls: 300,
        maxNewUrlsPerRun: 20,
        deep: {
          maxPages: 120,
          maxDepth: 3,
          timeBudgetSeconds: 90,
          pageConcurrency: 4,
          scoreThreshold: 0.35,
          candidatePoolSize: 160,
          headFetchTopK: 60,
          preferPathDate: false,
          enableSecondaryHubs: false,
          ignoreRobotsTxt: false
        }
      }
    });

    expect(values.seedEnabled).toBe(true);
    expect(values.seedMode).toBe('deep');
    expect(values.seedMaxUrls).toBe(300);
    expect(values.seedMaxNewUrlsPerRun).toBe(20);
    expect(values.seedDeepMaxPages).toBe(120);
    expect(values.seedDeepMaxDepth).toBe(3);
    expect(values.seedDeepTimeBudgetSeconds).toBe(90);
    expect(values.seedDeepPageConcurrency).toBe(4);
    expect(values.seedDeepScoreThreshold).toBe(0.35);
    expect(values.seedDeepCandidatePoolSize).toBe(160);
    expect(values.seedDeepHeadFetchTopK).toBe(60);
    expect(values.seedDeepPreferPathDate).toBe(false);
    expect(values.seedDeepEnableSecondaryHubs).toBe(false);
    expect(values.seedDeepIgnoreRobotsTxt).toBe(true);
  });

  it('builds deep seed config and forces ignoreRobotsTxt', () => {
    const next = buildSeedConfigFromFormValues(
      {
        seedEnabled: true,
        seedMode: 'deep',
        seedDomain: 'https://example.com',
        seedPattern: 'https://example.com/article/*',
        seedMaxUrls: 200,
        seedMaxNewUrlsPerRun: 20,
        seedDeepMaxPages: 90,
        seedDeepMaxDepth: 2,
        seedDeepTimeBudgetSeconds: 75,
        seedDeepPageConcurrency: 3,
        seedDeepScoreThreshold: 0.25,
        seedDeepCandidatePoolSize: 140,
        seedDeepHeadFetchTopK: 45,
        seedDeepPreferPathDate: true,
        seedDeepEnableSecondaryHubs: true,
        seedDeepIgnoreRobotsTxt: false
      },
      null
    );

    expect(next).toEqual(
      expect.objectContaining({
        seed: expect.objectContaining({
          enabled: true,
          mode: 'deep',
          domain: 'https://example.com',
          pattern: 'https://example.com/article/*',
          maxUrls: 200,
          maxNewUrlsPerRun: 20,
          deep: expect.objectContaining({
            maxPages: 90,
            maxDepth: 2,
            timeBudgetSeconds: 75,
            pageConcurrency: 3,
            scoreThreshold: 0.25,
            candidatePoolSize: 140,
            headFetchTopK: 45,
            preferPathDate: true,
            enableSecondaryHubs: true,
            ignoreRobotsTxt: true
          })
        })
      })
    );
  });

  it('builds rss seed config with adaptive toggle', () => {
    const enabled = buildSeedConfigFromFormValues(
      {
        seedEnabled: true,
        seedMode: 'rss',
        seedFeedUrl: 'https://example.com/rss.xml',
        seedRssAdaptiveEnabled: true
      },
      null
    );
    const disabled = buildSeedConfigFromFormValues(
      {
        seedEnabled: true,
        seedMode: 'rss',
        seedFeedUrl: 'https://example.com/rss.xml',
        seedRssAdaptiveEnabled: false
      },
      null
    );

    expect(enabled).toEqual(
      expect.objectContaining({
        seed: expect.objectContaining({
          mode: 'rss',
          feedUrl: 'https://example.com/rss.xml',
          rssAdaptive: expect.objectContaining({ enabled: true })
        })
      })
    );
    expect(disabled).toEqual(
      expect.objectContaining({
        seed: expect.objectContaining({
          mode: 'rss',
          rssAdaptive: expect.objectContaining({ enabled: false })
        })
      })
    );
  });

  it('normalizes adaptive runtime settings with safe bounds', () => {
    const resolved = resolveSeedSchedulerRuntimeSettings({
      rssAdaptiveHotHitRatePercent: 40,
      rssAdaptiveWarmHitRatePercent: 80,
      rssAdaptiveHotDiscoveryCacheTtlCapSeconds: 120,
      rssAdaptiveWarmDiscoveryCacheTtlCapSeconds: 60,
      rssAdaptiveWarmMinIntervalSeconds: 120,
      rssAdaptiveColdMaxIntervalSeconds: 60
    });

    expect(resolved.rssAdaptiveHotHitRatePercent).toBe(40);
    expect(resolved.rssAdaptiveWarmHitRatePercent).toBe(40);
    expect(resolved.rssAdaptiveHotDiscoveryCacheTtlCapSeconds).toBe(60);
    expect(resolved.rssAdaptiveWarmDiscoveryCacheTtlCapSeconds).toBe(60);
    expect(resolved.rssAdaptiveWarmMinIntervalSeconds).toBe(120);
    expect(resolved.rssAdaptiveColdMaxIntervalSeconds).toBe(120);
  });

  it('allows zero hot hit-rate threshold when resolving adaptive settings', () => {
    const resolved = resolveSeedSchedulerRuntimeSettings({
      rssAdaptiveHotHitRatePercent: 0,
      rssAdaptiveWarmHitRatePercent: 50
    });

    expect(resolved.rssAdaptiveHotHitRatePercent).toBe(0);
    expect(resolved.rssAdaptiveWarmHitRatePercent).toBe(0);
  });

  it('resolves adaptive tier from state and runtime thresholds', () => {
    const hot = resolveSeedRssAdaptiveTier(
      {
        outcomes: [true, true, false, true],
        consecutiveNoHit: 0
      },
      {
        rssAdaptiveHotHitRatePercent: 60,
        rssAdaptiveWarmHitRatePercent: 25
      }
    );
    const warm = resolveSeedRssAdaptiveTier(
      {
        outcomes: [true, false, false, false],
        consecutiveNoHit: 0
      },
      {
        rssAdaptiveHotHitRatePercent: 80,
        rssAdaptiveWarmHitRatePercent: 20
      }
    );
    const cold = resolveSeedRssAdaptiveTier(
      {
        outcomes: [false, false, false],
        consecutiveNoHit: 5
      },
      {
        rssAdaptiveColdConsecutiveNoHitRuns: 4
      }
    );
    const boostedByPriority = resolveSeedRssAdaptiveTier(
      {
        outcomes: [true, false, false],
        consecutiveNoHit: 0
      },
      {
        rssAdaptiveHotHitRatePercent: 90,
        rssAdaptiveWarmHitRatePercent: 20
      },
      80
    );
    const demotedByPriority = resolveSeedRssAdaptiveTier(
      {
        outcomes: [true, false, false],
        consecutiveNoHit: 0
      },
      {
        rssAdaptiveHotHitRatePercent: 90,
        rssAdaptiveWarmHitRatePercent: 20
      },
      -80
    );

    expect(hot).toBe('hot');
    expect(warm).toBe('warm');
    expect(cold).toBe('cold');
    expect(boostedByPriority).toBe('hot');
    expect(demotedByPriority).toBe('normal');
  });

  it('resolves adaptive interval and discovery ttl by tier', () => {
    const runtime = {
      rssAdaptiveHotIntervalSeconds: 45,
      rssAdaptiveWarmIntervalDivisor: 3,
      rssAdaptiveWarmMinIntervalSeconds: 90,
      rssAdaptiveColdIntervalMultiplier: 2,
      rssAdaptiveColdMaxIntervalSeconds: 500,
      rssAdaptiveHotDiscoveryCacheTtlCapSeconds: 20,
      rssAdaptiveWarmDiscoveryCacheTtlCapSeconds: 50
    };

    expect(resolveSeedRssAdaptiveIntervalSeconds(600, 'hot', runtime)).toBe(45);
    expect(resolveSeedRssAdaptiveIntervalSeconds(600, 'warm', runtime)).toBe(200);
    expect(resolveSeedRssAdaptiveIntervalSeconds(600, 'cold', runtime)).toBe(600);
    expect(resolveSeedRssAdaptiveIntervalSeconds(120, 'cold', runtime)).toBe(240);
    expect(resolveSeedRssAdaptiveDiscoveryCacheTtlSeconds(180, 'hot', runtime)).toBe(20);
    expect(resolveSeedRssAdaptiveDiscoveryCacheTtlSeconds(180, 'warm', runtime)).toBe(50);
    expect(resolveSeedRssAdaptiveDiscoveryCacheTtlSeconds(180, 'normal', runtime)).toBe(180);
  });
});
