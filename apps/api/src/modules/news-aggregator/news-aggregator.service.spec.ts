import { buildComparableUrlVariants } from '@modular/mongo';
import { BadRequestException, HttpException } from '@nestjs/common';

import { NewsSourceRuntimeSecretRequiredError } from './news-aggregator.errors';
import { NewsAggregatorService } from './news-aggregator.service';

const mockRawItemFindOne = jest.fn();
const mockProcessedItemFind = jest.fn();

jest.mock('@modular/mongo', () => {
  const actual = jest.requireActual('@modular/mongo');
  return {
    ...actual,
    RawItemModel: {
      findOne: (...args: unknown[]) => mockRawItemFindOne(...args),
    },
    ProcessedItemModel: {
      find: (...args: unknown[]) => mockProcessedItemFind(...args),
    },
  };
});

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

const mockRawItemFindOneResult = (result: unknown) => {
  const lean = jest.fn().mockResolvedValue(result);
  const sort = jest.fn().mockReturnValue({ lean });
  mockRawItemFindOne.mockReturnValueOnce({ sort });
};

const mockProcessedItemFindResult = (rows: { _id: string }[]) => {
  const lean = jest.fn().mockResolvedValue(rows);
  const limit = jest.fn().mockReturnValue({ lean });
  const sort = jest.fn().mockReturnValue({ limit });
  mockProcessedItemFind.mockReturnValueOnce({ sort });
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

  const prismaMock = {
    newsEventItem: {
      findFirst: jest.fn(),
    },
  } as any;

  const registryServiceMock = {
    getMetadata: jest.fn(() => metadataFixture),
    getSource: jest.fn(),
    getGetter: jest.fn(),
  } as any;

  const runtimeSecretsServiceMock = {
    getSecretsForSource: jest.fn(),
  } as any;

  const activeSourcesMock = {
    getOrgIdsForSource: jest.fn(),
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

  const userNewsBehaviorMock = {
    getPersonalizationProfile: jest.fn(),
  } as any;

  let service: NewsAggregatorService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockRawItemFindOne.mockReset();
    mockProcessedItemFind.mockReset();
    registryServiceMock.getMetadata.mockReturnValue(metadataFixture);
    registryServiceMock.getSource.mockReturnValue({
      name: '微博',
      interval: 120000,
      color: 'red',
    });
    registryServiceMock.getGetter.mockReturnValue(
      jest.fn().mockResolvedValue([
        {
          id: 'item-1',
          title: 'headline',
          url: 'https://example.com/headline',
        },
      ]),
    );
    cacheServiceMock.get.mockResolvedValue(null);
    cacheServiceMock.set.mockResolvedValue(undefined);
    cacheServiceMock.withLock.mockImplementation(
      async (_lockKey: string, _ttlMs: number, fn: () => Promise<unknown>) => fn(),
    );
    cacheServiceMock.zcard.mockResolvedValue(0);
    cacheServiceMock.zrange.mockResolvedValue([]);
    rateLimiterServiceMock.consume.mockResolvedValue(true);
    runtimeSecretsServiceMock.getSecretsForSource.mockResolvedValue({});
    activeSourcesMock.getOrgIdsForSource.mockReturnValue([]);
    realtimeDispatcherMock.publish.mockResolvedValue(undefined);
    prismaMock.newsEventItem.findFirst.mockResolvedValue(null);
    userNewsBehaviorMock.getPersonalizationProfile.mockResolvedValue({
      positive: { sources: {} },
      negative: { sources: {} },
    });
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
      activeSourcesMock,
      realtimeDispatcherMock,
      userSettingsServiceMock,
      personalizationSettingsServiceMock,
      userNewsBehaviorMock,
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

    expect(result.sortMode).toBe('personalized');
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

    expect(result.sortMode).toBe('personalized');
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

  it('resolves exact comparable URL matches and reuses the cached result', async () => {
    const cacheStore = new Map<string, unknown>();
    cacheServiceMock.get.mockImplementation(async (key: string) => cacheStore.get(key) ?? null);
    cacheServiceMock.set.mockImplementation(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
    });

    mockRawItemFindOneResult({
      itemMetaId: 'item-meta-1',
      payload: { url: 'https://example.com/news?id=1' },
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
    });
    mockProcessedItemFindResult([{ _id: 'processed-1' }]);
    prismaMock.newsEventItem.findFirst.mockResolvedValue({ eventId: 'event-1' });

    const first = await service.resolveByUrl('https://Example.com/news?id=1#section');
    const second = await service.resolveByUrl('https://example.com/news?id=1');
    const comparable = buildComparableUrlVariants('https://example.com/news?id=1');

    expect(first).toEqual({
      matched: true,
      itemId: 'item-meta-1',
      eventId: 'event-1',
      confidence: 1,
      matchedUrl: 'https://example.com/news?id=1',
    });
    expect(second).toEqual(first);
    expect(mockRawItemFindOne).toHaveBeenCalledTimes(1);
    expect(mockRawItemFindOne).toHaveBeenCalledWith(
      {
        urlComparableFullHash: comparable?.fullHash,
        urlComparableFull: comparable?.full,
      },
      { itemMetaId: 1, 'payload.url': 1, createdAt: 1 },
    );
    expect(mockProcessedItemFind).toHaveBeenCalledTimes(1);
    expect(prismaMock.newsEventItem.findFirst).toHaveBeenCalledTimes(1);
    expect(cacheServiceMock.set).toHaveBeenCalledWith(
      expect.stringContaining('news-aggregator:resolve:v1:'),
      first,
      300,
    );
  });

  it('falls back to the comparable base URL when the full URL does not match', async () => {
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult({
      itemMetaId: 'item-meta-2',
      payload: { url: 'https://example.com/story' },
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
    });
    mockProcessedItemFindResult([]);

    const result = await service.resolveByUrl('https://example.com/story?ref=homepage');
    const comparable = buildComparableUrlVariants('https://example.com/story?ref=homepage');

    expect(result).toEqual({
      matched: true,
      itemId: 'item-meta-2',
      confidence: 0.93,
      matchedUrl: 'https://example.com/story',
    });
    expect(mockRawItemFindOne).toHaveBeenCalledTimes(4);
    expect(mockRawItemFindOne).toHaveBeenNthCalledWith(
      1,
      {
        urlComparableFullHash: comparable?.fullHash,
        urlComparableFull: comparable?.full,
      },
      { itemMetaId: 1, 'payload.url': 1, createdAt: 1 },
    );
    expect(mockRawItemFindOne).toHaveBeenNthCalledWith(
      2,
      { urlComparableFull: comparable?.full },
      { itemMetaId: 1, 'payload.url': 1, createdAt: 1 },
    );
    expect(mockRawItemFindOne).toHaveBeenNthCalledWith(
      3,
      { 'payload.url': 'https://example.com/story?ref=homepage' },
      { itemMetaId: 1, 'payload.url': 1, createdAt: 1 },
    );
    expect(mockRawItemFindOne).toHaveBeenNthCalledWith(
      4,
      { urlComparableBase: 'https://example.com/story' },
      { itemMetaId: 1, 'payload.url': 1, createdAt: 1 },
    );
  });

  it('falls back to legacy comparable full matching when the hash backfill has not reached the row yet', async () => {
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult({
      itemMetaId: 'item-meta-legacy-comparable',
      payload: { url: 'https://Example.com/story?id=123#top' },
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
    });
    mockProcessedItemFindResult([]);

    const result = await service.resolveByUrl('https://example.com/story?id=123');
    const comparable = buildComparableUrlVariants('https://example.com/story?id=123');

    expect(result).toEqual({
      matched: true,
      itemId: 'item-meta-legacy-comparable',
      confidence: 1,
      matchedUrl: 'https://Example.com/story?id=123#top',
    });
    expect(mockRawItemFindOne).toHaveBeenCalledTimes(2);
    expect(mockRawItemFindOne).toHaveBeenNthCalledWith(
      1,
      {
        urlComparableFullHash: comparable?.fullHash,
        urlComparableFull: comparable?.full,
      },
      { itemMetaId: 1, 'payload.url': 1, createdAt: 1 },
    );
    expect(mockRawItemFindOne).toHaveBeenNthCalledWith(
      2,
      { urlComparableFull: comparable?.full },
      { itemMetaId: 1, 'payload.url': 1, createdAt: 1 },
    );
  });

  it('preserves the legacy exact payload.url fallback before comparable base matching', async () => {
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult({
      itemMetaId: 'item-meta-legacy',
      payload: { url: 'https://example.com/story?id=123' },
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
    });
    mockProcessedItemFindResult([]);

    const result = await service.resolveByUrl('https://example.com/story?id=123#top');

    expect(result).toEqual({
      matched: true,
      itemId: 'item-meta-legacy',
      confidence: 1,
      matchedUrl: 'https://example.com/story?id=123',
    });
    expect(mockRawItemFindOne).toHaveBeenCalledTimes(3);
    expect(mockRawItemFindOne).toHaveBeenNthCalledWith(
      3,
      {
        'payload.url': {
          $in: [
            'https://example.com/story?id=123#top',
            'https://example.com/story?id=123',
          ],
        },
      },
      { itemMetaId: 1, 'payload.url': 1, createdAt: 1 },
    );
  });

  it('caches unmatched resolve results to avoid repeated database lookups', async () => {
    const cacheStore = new Map<string, unknown>();
    cacheServiceMock.get.mockImplementation(async (key: string) => cacheStore.get(key) ?? null);
    cacheServiceMock.set.mockImplementation(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
    });

    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult(null);

    const first = await service.resolveByUrl('https://example.com/missing');
    const second = await service.resolveByUrl('https://example.com/missing');

    expect(first).toEqual({ matched: false });
    expect(second).toEqual({ matched: false });
    expect(mockRawItemFindOne).toHaveBeenCalledTimes(5);
    expect(mockProcessedItemFind).not.toHaveBeenCalled();
    expect(prismaMock.newsEventItem.findFirst).not.toHaveBeenCalled();
    expect(cacheServiceMock.set).toHaveBeenCalledWith(
      expect.stringContaining('news-aggregator:resolve:v1:'),
      { matched: false },
      30,
    );
  });

  it('falls back to the legacy payload.url regex when comparable fields do not match', async () => {
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult(null);
    mockRawItemFindOneResult({
      itemMetaId: 'item-meta-3',
      payload: { url: 'https://example.com/Story/?utm_source=legacy' },
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
    });
    mockProcessedItemFindResult([]);

    const result = await service.resolveByUrl('https://example.com/Story/?utm_source=homepage#top');

    expect(result).toEqual({
      matched: true,
      itemId: 'item-meta-3',
      confidence: 0.86,
      matchedUrl: 'https://example.com/Story/?utm_source=legacy',
    });
    expect(mockRawItemFindOne).toHaveBeenCalledTimes(5);
    expect(mockRawItemFindOne.mock.calls[4]?.[0]).toMatchObject({
      'payload.url': {
        $regex: expect.stringContaining('^https://example\\.com/Story'),
        $options: 'i',
      },
    });
  });

  it('wraps source refresh failures into 502 response with source context and logs error', async () => {
    const loggerErrorSpy = jest.spyOn((service as any).logger, 'error');
    cacheServiceMock.withLock.mockRejectedValue(new Error('upstream timeout'));

    try {
      await service.fetchSource('weibo');
      throw new Error('expected fetchSource to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect(error).toMatchObject({
        status: 502,
        response: expect.objectContaining({
          code: 'NEWS_SOURCE_FETCH_FAILED',
          message: 'Failed to fetch news source: weibo',
          detail: 'upstream timeout',
        }),
      });
    }
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('source refresh failed for "weibo": upstream timeout'),
      expect.any(String),
    );
  });

  it('does not wrap 4xx HttpException from source refresh flow', async () => {
    cacheServiceMock.withLock.mockRejectedValue(new BadRequestException('invalid token'));

    try {
      await service.fetchSource('weibo');
      throw new Error('expected fetchSource to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).toMatchObject({ status: 400 });
    }
  });

  it('maps missing runtime secrets to a structured 424 response', async () => {
    cacheServiceMock.withLock.mockRejectedValue(
      new NewsSourceRuntimeSecretRequiredError({
        sourceId: 'producthunt',
        requiredKeys: ['token', 'api_token'],
        message: 'Product Hunt API token is required',
      }),
    );

    try {
      await service.fetchSource('producthunt');
      throw new Error('expected fetchSource to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect(error).toMatchObject({
        status: 424,
        response: expect.objectContaining({
          code: 'NEWS_SOURCE_RUNTIME_SECRET_REQUIRED',
          message: 'Runtime secret required for news source: producthunt',
          sourceId: 'producthunt',
          requiredKeys: ['token', 'api_token'],
        }),
      });
    }
  });

  it('publishes NewsNow realtime updates once per active org for the refreshed source', async () => {
    activeSourcesMock.getOrgIdsForSource.mockReturnValue(['org-1', 'org-2']);
    cacheServiceMock.get.mockResolvedValueOnce({
      status: 'success',
      id: 'weibo',
      updatedTime: Date.now() - 120000,
      items: [
        {
          id: 'old-item',
          title: 'old headline',
          url: 'https://example.com/old',
        },
      ],
    });

    await service.fetchSource('weibo', true);

    expect(activeSourcesMock.getOrgIdsForSource).toHaveBeenCalledWith('weibo');
    expect(realtimeDispatcherMock.publish).toHaveBeenCalledTimes(2);
    expect(realtimeDispatcherMock.publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        orgId: 'org-1',
        sourceId: 'weibo',
        newItemsCount: 1,
        topTitles: ['headline'],
        intervalMs: 120000,
      }),
    );
    expect(realtimeDispatcherMock.publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        orgId: 'org-2',
        sourceId: 'weibo',
        newItemsCount: 1,
      }),
    );
  });

  it('does not publish NewsNow realtime updates when no org is actively watching the source', async () => {
    activeSourcesMock.getOrgIdsForSource.mockReturnValue([]);
    cacheServiceMock.get.mockResolvedValueOnce({
      status: 'success',
      id: 'weibo',
      updatedTime: Date.now() - 120000,
      items: [
        {
          id: 'old-item',
          title: 'old headline',
          url: 'https://example.com/old',
        },
      ],
    });

    await service.fetchSource('weibo', true);

    expect(activeSourcesMock.getOrgIdsForSource).toHaveBeenCalledWith('weibo');
    expect(realtimeDispatcherMock.publish).not.toHaveBeenCalled();
  });
});
