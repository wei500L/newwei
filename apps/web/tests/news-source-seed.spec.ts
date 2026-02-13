import { describe, expect, it } from 'vitest';

import {
  buildSeedConfigFromFormValues,
  DEFAULT_SEED_FORM_VALUES,
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
});
