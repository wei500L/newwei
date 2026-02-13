export interface NewsSourceSeedFormValues {
  seedEnabled?: boolean;
  seedMode?: 'sitemap' | 'rss' | 'list' | 'deep';
  seedDomain?: string;
  seedPattern?: string;
  seedFeedUrl?: string;
  seedQuery?: string;
  seedMaxUrls?: number;
  seedMaxNewUrlsPerRun?: number;
  seedScoreThreshold?: number;
  seedDedupeWindowHours?: number;
  seedCacheTtlSeconds?: number;
  seedConcurrency?: number;
  seedListMaxPages?: number;
  seedListPageConcurrency?: number;
  seedFollowPagination?: boolean;
  seedDeepMaxPages?: number;
  seedDeepMaxDepth?: number;
  seedDeepTimeBudgetSeconds?: number;
  seedDeepPageConcurrency?: number;
  seedDeepScoreThreshold?: number;
  seedDeepCandidatePoolSize?: number;
  seedDeepHeadFetchTopK?: number;
  seedDeepPreferPathDate?: boolean;
  seedDeepEnableSecondaryHubs?: boolean;
  seedDeepIgnoreRobotsTxt?: boolean;
}

export const DEFAULT_SEED_FORM_VALUES: Required<
  Pick<
    NewsSourceSeedFormValues,
    | 'seedMode'
    | 'seedMaxUrls'
    | 'seedMaxNewUrlsPerRun'
    | 'seedScoreThreshold'
    | 'seedDedupeWindowHours'
    | 'seedCacheTtlSeconds'
    | 'seedConcurrency'
    | 'seedListMaxPages'
    | 'seedListPageConcurrency'
    | 'seedFollowPagination'
    | 'seedDeepMaxPages'
    | 'seedDeepMaxDepth'
    | 'seedDeepTimeBudgetSeconds'
    | 'seedDeepPageConcurrency'
    | 'seedDeepScoreThreshold'
    | 'seedDeepCandidatePoolSize'
    | 'seedDeepHeadFetchTopK'
    | 'seedDeepPreferPathDate'
    | 'seedDeepEnableSecondaryHubs'
    | 'seedDeepIgnoreRobotsTxt'
  >
> = {
  seedMode: 'sitemap',
  seedMaxUrls: 200,
  seedMaxNewUrlsPerRun: 80,
  seedScoreThreshold: 0,
  seedDedupeWindowHours: 24,
  seedCacheTtlSeconds: 600,
  seedConcurrency: 5,
  seedListMaxPages: 6,
  seedListPageConcurrency: 2,
  seedFollowPagination: true,
  seedDeepMaxPages: 80,
  seedDeepMaxDepth: 2,
  seedDeepTimeBudgetSeconds: 60,
  seedDeepPageConcurrency: 2,
  seedDeepScoreThreshold: 0.2,
  seedDeepCandidatePoolSize: 120,
  seedDeepHeadFetchTopK: 40,
  seedDeepPreferPathDate: true,
  seedDeepEnableSecondaryHubs: true,
  seedDeepIgnoreRobotsTxt: true
};

const toFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const readSeedFormValuesFromConfig = (config: unknown): Partial<NewsSourceSeedFormValues> => {
  const seedConfig =
    config && typeof config === 'object' && !Array.isArray(config) &&
    (config as Record<string, unknown>).seed &&
    typeof (config as Record<string, unknown>).seed === 'object' &&
    !Array.isArray((config as Record<string, unknown>).seed)
      ? ((config as Record<string, unknown>).seed as Record<string, unknown>)
      : null;

  const mode =
    seedConfig?.mode === 'rss'
      ? 'rss'
      : seedConfig?.mode === 'list'
        ? 'list'
        : seedConfig?.mode === 'deep'
          ? 'deep'
        : 'sitemap';
  const deepConfig =
    seedConfig?.deep && typeof seedConfig.deep === 'object' && !Array.isArray(seedConfig.deep)
      ? (seedConfig.deep as Record<string, unknown>)
      : null;

  return {
    seedEnabled: seedConfig?.enabled === true,
    seedMode: mode,
    seedDomain: typeof seedConfig?.domain === 'string' ? seedConfig.domain : '',
    seedPattern: typeof seedConfig?.pattern === 'string' ? seedConfig.pattern : '',
    seedFeedUrl: typeof seedConfig?.feedUrl === 'string' ? seedConfig.feedUrl : '',
    seedQuery: typeof seedConfig?.query === 'string' ? seedConfig.query : '',
    seedMaxUrls: toFiniteNumber(seedConfig?.maxUrls) ?? DEFAULT_SEED_FORM_VALUES.seedMaxUrls,
    seedMaxNewUrlsPerRun:
      toFiniteNumber(seedConfig?.maxNewUrlsPerRun) ?? DEFAULT_SEED_FORM_VALUES.seedMaxNewUrlsPerRun,
    seedScoreThreshold: toFiniteNumber(seedConfig?.scoreThreshold) ?? DEFAULT_SEED_FORM_VALUES.seedScoreThreshold,
    seedDedupeWindowHours:
      toFiniteNumber(seedConfig?.dedupeWindowHours) ?? DEFAULT_SEED_FORM_VALUES.seedDedupeWindowHours,
    seedCacheTtlSeconds:
      toFiniteNumber(seedConfig?.cacheTtlSeconds) ?? DEFAULT_SEED_FORM_VALUES.seedCacheTtlSeconds,
    seedConcurrency: toFiniteNumber(seedConfig?.concurrency) ?? DEFAULT_SEED_FORM_VALUES.seedConcurrency,
    seedListMaxPages: toFiniteNumber(seedConfig?.listMaxPages) ?? DEFAULT_SEED_FORM_VALUES.seedListMaxPages,
    seedListPageConcurrency:
      toFiniteNumber(seedConfig?.listPageConcurrency) ?? DEFAULT_SEED_FORM_VALUES.seedListPageConcurrency,
    seedFollowPagination:
      typeof seedConfig?.followPagination === 'boolean'
        ? seedConfig.followPagination
        : DEFAULT_SEED_FORM_VALUES.seedFollowPagination,
    seedDeepMaxPages:
      toFiniteNumber(deepConfig?.maxPages) ?? DEFAULT_SEED_FORM_VALUES.seedDeepMaxPages,
    seedDeepMaxDepth:
      toFiniteNumber(deepConfig?.maxDepth) ?? DEFAULT_SEED_FORM_VALUES.seedDeepMaxDepth,
    seedDeepTimeBudgetSeconds:
      toFiniteNumber(deepConfig?.timeBudgetSeconds) ??
      DEFAULT_SEED_FORM_VALUES.seedDeepTimeBudgetSeconds,
    seedDeepPageConcurrency:
      toFiniteNumber(deepConfig?.pageConcurrency) ??
      DEFAULT_SEED_FORM_VALUES.seedDeepPageConcurrency,
    seedDeepScoreThreshold:
      toFiniteNumber(deepConfig?.scoreThreshold) ??
      DEFAULT_SEED_FORM_VALUES.seedDeepScoreThreshold,
    seedDeepCandidatePoolSize:
      toFiniteNumber(deepConfig?.candidatePoolSize) ??
      DEFAULT_SEED_FORM_VALUES.seedDeepCandidatePoolSize,
    seedDeepHeadFetchTopK:
      toFiniteNumber(deepConfig?.headFetchTopK) ??
      DEFAULT_SEED_FORM_VALUES.seedDeepHeadFetchTopK,
    seedDeepPreferPathDate:
      typeof deepConfig?.preferPathDate === 'boolean'
        ? deepConfig.preferPathDate
        : DEFAULT_SEED_FORM_VALUES.seedDeepPreferPathDate,
    seedDeepEnableSecondaryHubs:
      typeof deepConfig?.enableSecondaryHubs === 'boolean'
        ? deepConfig.enableSecondaryHubs
        : DEFAULT_SEED_FORM_VALUES.seedDeepEnableSecondaryHubs,
    // Deep mode is hard-locked to ignore robots.txt, regardless of stored config.
    seedDeepIgnoreRobotsTxt: DEFAULT_SEED_FORM_VALUES.seedDeepIgnoreRobotsTxt
  };
};

export const buildSeedConfigFromFormValues = (
  values: NewsSourceSeedFormValues,
  existingConfig: Record<string, unknown> | null
): Record<string, unknown> | null => {
  const shouldIncludeSeed = values.seedEnabled === true || Boolean(existingConfig?.seed);
  if (!shouldIncludeSeed) {
    return existingConfig;
  }

  const seedMode =
    values.seedMode === 'rss'
      ? 'rss'
      : values.seedMode === 'list'
        ? 'list'
        : values.seedMode === 'deep'
          ? 'deep'
          : 'sitemap';
  const seed: Record<string, unknown> = {
    enabled: values.seedEnabled === true,
    mode: seedMode
  };

  if (seedMode === 'rss') {
    const feedUrl = values.seedFeedUrl?.trim();
    if (feedUrl) {
      seed.feedUrl = feedUrl;
    }
  } else {
    const domain = values.seedDomain?.trim();
    if (domain) {
      seed.domain = domain;
    }

    const pattern = values.seedPattern?.trim();
    if (pattern) {
      seed.pattern = pattern;
    }

    if (seedMode === 'list') {
      if (typeof values.seedListMaxPages === 'number' && Number.isFinite(values.seedListMaxPages)) {
        seed.listMaxPages = values.seedListMaxPages;
      }
      if (typeof values.seedListPageConcurrency === 'number' && Number.isFinite(values.seedListPageConcurrency)) {
        seed.listPageConcurrency = values.seedListPageConcurrency;
      }
      if (typeof values.seedFollowPagination === 'boolean') {
        seed.followPagination = values.seedFollowPagination;
      }
    }
  }

  if (seedMode === 'deep') {
    const deep: Record<string, unknown> = {
      ignoreRobotsTxt: true
    };
    if (typeof values.seedDeepMaxPages === 'number' && Number.isFinite(values.seedDeepMaxPages)) {
      deep.maxPages = values.seedDeepMaxPages;
    }
    if (typeof values.seedDeepMaxDepth === 'number' && Number.isFinite(values.seedDeepMaxDepth)) {
      deep.maxDepth = values.seedDeepMaxDepth;
    }
    if (
      typeof values.seedDeepTimeBudgetSeconds === 'number' &&
      Number.isFinite(values.seedDeepTimeBudgetSeconds)
    ) {
      deep.timeBudgetSeconds = values.seedDeepTimeBudgetSeconds;
    }
    if (
      typeof values.seedDeepPageConcurrency === 'number' &&
      Number.isFinite(values.seedDeepPageConcurrency)
    ) {
      deep.pageConcurrency = values.seedDeepPageConcurrency;
    }
    if (
      typeof values.seedDeepScoreThreshold === 'number' &&
      Number.isFinite(values.seedDeepScoreThreshold)
    ) {
      deep.scoreThreshold = values.seedDeepScoreThreshold;
    }
    if (
      typeof values.seedDeepCandidatePoolSize === 'number' &&
      Number.isFinite(values.seedDeepCandidatePoolSize)
    ) {
      deep.candidatePoolSize = values.seedDeepCandidatePoolSize;
    }
    if (
      typeof values.seedDeepHeadFetchTopK === 'number' &&
      Number.isFinite(values.seedDeepHeadFetchTopK)
    ) {
      deep.headFetchTopK = values.seedDeepHeadFetchTopK;
    }
    if (typeof values.seedDeepPreferPathDate === 'boolean') {
      deep.preferPathDate = values.seedDeepPreferPathDate;
    }
    if (typeof values.seedDeepEnableSecondaryHubs === 'boolean') {
      deep.enableSecondaryHubs = values.seedDeepEnableSecondaryHubs;
    }
    seed.deep = deep;
  }

  const query = values.seedQuery?.trim();
  if (query) {
    seed.query = query;
  }

  if (typeof values.seedMaxUrls === 'number' && Number.isFinite(values.seedMaxUrls)) {
    seed.maxUrls = values.seedMaxUrls;
  }
  if (typeof values.seedMaxNewUrlsPerRun === 'number' && Number.isFinite(values.seedMaxNewUrlsPerRun)) {
    seed.maxNewUrlsPerRun = values.seedMaxNewUrlsPerRun;
  }
  if (typeof values.seedScoreThreshold === 'number' && Number.isFinite(values.seedScoreThreshold)) {
    seed.scoreThreshold = values.seedScoreThreshold;
  }
  if (typeof values.seedDedupeWindowHours === 'number' && Number.isFinite(values.seedDedupeWindowHours)) {
    seed.dedupeWindowHours = values.seedDedupeWindowHours;
  }
  if (typeof values.seedCacheTtlSeconds === 'number' && Number.isFinite(values.seedCacheTtlSeconds)) {
    seed.cacheTtlSeconds = values.seedCacheTtlSeconds;
  }
  if (typeof values.seedConcurrency === 'number' && Number.isFinite(values.seedConcurrency)) {
    seed.concurrency = values.seedConcurrency;
  }

  return {
    ...(existingConfig ?? {}),
    seed
  };
};
