import { NewsAggregatorService } from './news-aggregator.service';

const metadataFixture = {
  sources: {
    weibo: {
      name: '微博',
      interval: 120000,
      color: 'red',
    },
    hackernews: {
      name: 'Hacker News',
      interval: 300000,
      color: 'orange',
    },
    baidu: {
      name: '百度',
      interval: 300000,
      color: 'blue',
    },
  },
  columns: {
    hottest: {
      name: '最热',
      sources: ['weibo', 'hackernews', 'baidu'],
    },
  },
};

describe('NewsAggregatorService personalization order', () => {
  const cacheServiceMock = {
    get: jest.fn(),
    set: jest.fn(),
    withLock: jest.fn(),
    zadd: jest.fn(),
    zcard: jest.fn(),
    zrange: jest.fn(),
    zrem: jest.fn(),
    delMany: jest.fn(),
    expire: jest.fn(),
  } as any;

  const rateLimiterServiceMock = {
    consume: jest.fn(),
  } as any;

  const prismaMock = {} as any;

  const registryServiceMock = {
    getMetadata: jest.fn(() => metadataFixture),
  } as any;

  const runtimeSecretsServiceMock = {
    getSecretsForSource: jest.fn(),
  } as any;

  const realtimeDispatcherMock = {
    publish: jest.fn(),
  } as any;

  const userSettingsServiceMock = {
    getNewsnowUiSettings: jest.fn(),
  } as any;

  const personalizationSettingsServiceMock = {
    getRuntimeSettings: jest.fn().mockResolvedValue({
      source: 'default',
      cacheTtlMs: 20_000,
      maxCacheEntries: 2_000,
      throttleWindowMs: 10_000,
      maxRequestsPerWindowPerUser: 40,
      affinitySourceWeight: 0.42,
      behaviorSourceWeight: 0.58,
      focusSourceBonus: 0.35,
      staleTtlStrategy: 'multiplier',
      staleTtlMultiplier: 3,
      staleTtlFixedMs: 60_000,
    }),
    resolveStaleTtlMs: jest.fn().mockReturnValue(60_000),
    recordRuntimeMetricsBestEffort: jest.fn(),
  } as any;

  let service: NewsAggregatorService;

  beforeEach(() => {
    jest.resetAllMocks();
    registryServiceMock.getMetadata.mockReturnValue(metadataFixture);
    cacheServiceMock.zcard.mockResolvedValue(0);
    cacheServiceMock.zrange.mockResolvedValue([]);
    rateLimiterServiceMock.consume.mockResolvedValue(true);
    personalizationSettingsServiceMock.getRuntimeSettings.mockResolvedValue({
      source: 'default',
      cacheTtlMs: 20_000,
      maxCacheEntries: 2_000,
      throttleWindowMs: 10_000,
      maxRequestsPerWindowPerUser: 40,
      affinitySourceWeight: 0.42,
      behaviorSourceWeight: 0.58,
      focusSourceBonus: 0.35,
      staleTtlStrategy: 'multiplier',
      staleTtlMultiplier: 3,
      staleTtlFixedMs: 60_000,
    });
    service = new NewsAggregatorService(
      cacheServiceMock,
      rateLimiterServiceMock,
      prismaMock,
      registryServiceMock,
      runtimeSecretsServiceMock,
      realtimeDispatcherMock,
      userSettingsServiceMock,
      personalizationSettingsServiceMock,
    );
  });

  it('applies manual column order from user settings', async () => {
    userSettingsServiceMock.getNewsnowUiSettings.mockResolvedValue({
      settings: {
        focusSources: [],
        columnOrders: {
          hottest: ['baidu', 'weibo'],
        },
        hideCrossSourceDuplicates: false,
        sortMode: 'manual',
        sourceAffinity: {},
      },
    });

    const result = await service.getPersonalizedSourceOrderForUser({
      orgId: 'org-1',
      userId: 'user-1',
      columnKey: 'hottest',
      sourceIds: ['weibo', 'hackernews', 'baidu'],
    });

    expect(result.sortMode).toBe('manual');
    expect(result.sourceIds).toEqual(['baidu', 'weibo', 'hackernews']);
  });

  it('computes smart order on server using affinity + focus bonus', async () => {
    const now = Date.now();
    userSettingsServiceMock.getNewsnowUiSettings.mockResolvedValue({
      settings: {
        focusSources: ['hackernews'],
        columnOrders: {
          hottest: ['weibo', 'hackernews', 'baidu'],
        },
        hideCrossSourceDuplicates: false,
        sortMode: 'smart',
        sourceAffinity: {
          weibo: {
            score: 0.5,
            openOriginalCount: 0,
            openEventCount: 0,
            openItemCount: 0,
            refreshCount: 0,
            focusCount: 0,
            accumulatedDwellMs: 0,
            lastInteractedAt: now,
          },
          hackernews: {
            score: 0.3,
            openOriginalCount: 0,
            openEventCount: 0,
            openItemCount: 0,
            refreshCount: 0,
            focusCount: 1,
            accumulatedDwellMs: 0,
            lastInteractedAt: now,
          },
          baidu: {
            score: 0,
            openOriginalCount: 0,
            openEventCount: 0,
            openItemCount: 0,
            refreshCount: 0,
            focusCount: 0,
            accumulatedDwellMs: 0,
            lastInteractedAt: now,
          },
        },
      },
    });

    const result = await service.getPersonalizedSourceOrderForUser({
      orgId: 'org-1',
      userId: 'user-1',
      columnKey: 'hottest',
      sourceIds: ['weibo', 'hackernews', 'baidu'],
    });

    expect(result.sortMode).toBe('smart');
    expect(result.sourceIds[0]).toBe('hackernews');
    expect(result.sourceScores.hackernews).toBeGreaterThan(result.sourceScores.weibo);
  });

  it('prefers request settings override when provided', async () => {
    userSettingsServiceMock.getNewsnowUiSettings.mockResolvedValue({
      settings: {
        focusSources: [],
        columnOrders: {},
        hideCrossSourceDuplicates: false,
        sortMode: 'manual',
        sourceAffinity: {},
      },
    });

    const result = await service.getPersonalizedSourceOrderForUser({
      orgId: 'org-1',
      userId: 'user-1',
      columnKey: 'hottest',
      sourceIds: ['weibo', 'hackernews', 'baidu'],
      settingsOverride: {
        sortMode: 'smart',
        focusSources: ['baidu'],
        sourceAffinity: {
          baidu: {
            score: 1,
            openOriginalCount: 0,
            openEventCount: 0,
            openItemCount: 0,
            refreshCount: 0,
            focusCount: 1,
            accumulatedDwellMs: 0,
            lastInteractedAt: Date.now(),
          },
        },
      },
    });

    expect(result.sortMode).toBe('smart');
    expect(result.sourceIds[0]).toBe('baidu');
  });

  it('returns fresh redis cache payload when available', async () => {
    userSettingsServiceMock.getNewsnowUiSettings.mockResolvedValue({
      settings: {
        focusSources: [],
        columnOrders: {},
        hideCrossSourceDuplicates: false,
        sortMode: 'manual',
        sourceAffinity: {},
      },
      updatedAt: {
        settings: '2026-01-01T00:00:00.000Z',
      },
    });

    const cachedPayload = {
      columnKey: 'hottest',
      sortMode: 'manual' as const,
      sourceIds: ['hackernews', 'weibo', 'baidu'],
      sourceScores: {},
      computedAt: new Date().toISOString(),
    };
    cacheServiceMock.get.mockResolvedValueOnce(cachedPayload);

    const result = await service.getPersonalizedSourceOrderForUser({
      orgId: 'org-1',
      userId: 'user-1',
      columnKey: 'hottest',
      sourceIds: ['weibo', 'hackernews', 'baidu'],
    });

    expect(result).toEqual(cachedPayload);
    expect(rateLimiterServiceMock.consume).not.toHaveBeenCalled();
  });

  it('returns stale redis cache payload when rate limited', async () => {
    userSettingsServiceMock.getNewsnowUiSettings.mockResolvedValue({
      settings: {
        focusSources: [],
        columnOrders: {},
        hideCrossSourceDuplicates: false,
        sortMode: 'manual',
        sourceAffinity: {},
      },
      updatedAt: {
        settings: '2026-01-01T00:00:00.000Z',
      },
    });

    rateLimiterServiceMock.consume.mockResolvedValue(false);
    cacheServiceMock.get.mockResolvedValueOnce(null).mockResolvedValueOnce({
      columnKey: 'hottest',
      sortMode: 'manual',
      sourceIds: ['baidu', 'weibo', 'hackernews'],
      sourceScores: {},
      computedAt: new Date().toISOString(),
    });

    const result = await service.getPersonalizedSourceOrderForUser({
      orgId: 'org-1',
      userId: 'user-1',
      columnKey: 'hottest',
      sourceIds: ['weibo', 'hackernews', 'baidu'],
    });

    expect(result.sourceIds[0]).toBe('baidu');
    expect(rateLimiterServiceMock.consume).toHaveBeenCalledTimes(1);
  });

  it('throws 429 when rate limited and no stale payload exists', async () => {
    userSettingsServiceMock.getNewsnowUiSettings.mockResolvedValue({
      settings: {
        focusSources: [],
        columnOrders: {},
        hideCrossSourceDuplicates: false,
        sortMode: 'manual',
        sourceAffinity: {},
      },
      updatedAt: {
        settings: '2026-01-01T00:00:00.000Z',
      },
    });

    rateLimiterServiceMock.consume.mockResolvedValue(false);
    cacheServiceMock.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await expect(
      service.getPersonalizedSourceOrderForUser({
        orgId: 'org-1',
        userId: 'user-1',
        columnKey: 'hottest',
        sourceIds: ['weibo', 'hackernews', 'baidu'],
      }),
    ).rejects.toMatchObject({
      status: 429,
    });
  });
});
