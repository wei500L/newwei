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
});

