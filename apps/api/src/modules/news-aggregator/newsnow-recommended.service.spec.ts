import { NewsnowRecommendedService } from './newsnow-recommended.service';
import { buildSignalKey } from './newsnow-hottest-analysis.utils';

describe('NewsnowRecommendedService', () => {
  const metadata = {
    sources: {
      weibo: { name: '微博', interval: 60_000, color: 'red' },
      hackernews: { name: 'Hacker News', interval: 60_000, color: 'orange' },
    },
    columns: {
      hottest: {
        name: '最热',
        sources: ['weibo', 'hackernews'],
      },
    },
  };

  const registry = {
    getMetadata: jest.fn(() => metadata),
  } as any;

  const aggregator = {
    fetchBatch: jest.fn(),
  } as any;

  const hottestAnalysis = {
    getHottestAnalysis: jest.fn(),
  } as any;

  const behavior = {
    getProfile: jest.fn(),
    getCollaborativeProfile: jest.fn(),
  } as any;

  const userSettings = {
    getNewsnowUiSettings: jest.fn(),
  } as any;

  let service: NewsnowRecommendedService;

  beforeEach(() => {
    jest.resetAllMocks();
    const signalKey = buildSignalKey({
      sourceId: 'weibo',
      title: 'AI 巨头发布新模型',
      url: 'https://example.com/ai-story',
    });
    registry.getMetadata.mockReturnValue(metadata);
    behavior.getProfile.mockResolvedValue({
      items: { 'item-1': 4 },
      events: { 'event-1': 3 },
      topics: { ai: 5 },
      entities: { openai: 4 },
      domains: { 'example.com': 2 },
    });
    behavior.getCollaborativeProfile.mockResolvedValue({
      items: { 'item-1': 2 },
      events: { 'event-1': 2 },
      topics: { ai: 3 },
      entities: { openai: 2 },
      domains: { 'example.com': 1 },
      sources: {},
      neighbors: [{ userId: 'user-2', similarity: 0.84, sharedSignals: 4 }],
      degraded: false,
      computedAt: new Date().toISOString(),
    });
    userSettings.getNewsnowUiSettings.mockResolvedValue({
      settings: {
        focusSources: ['weibo'],
        columnOrders: {},
        hideCrossSourceDuplicates: false,
        sortMode: 'manual',
        densityMode: 'compact',
        sourceAffinity: {
          weibo: {
            score: 80,
            openOriginalCount: 0,
            openEventCount: 0,
            openItemCount: 0,
            refreshCount: 0,
            focusCount: 0,
            accumulatedDwellMs: 0,
            lastInteractedAt: Date.now(),
          },
        },
      },
    });
    aggregator.fetchBatch.mockResolvedValue({
      requested: 2,
      processed: 2,
      errors: [],
      results: [
        {
          id: 'weibo',
          status: 'success',
          updatedTime: Date.now(),
          items: [
            {
              id: 'w-1',
              title: 'AI 巨头发布新模型',
              url: 'https://example.com/ai-story',
            },
          ],
        },
        {
          id: 'hackernews',
          status: 'success',
          updatedTime: Date.now(),
          items: [
            {
              id: 'h-1',
              title: 'AI 巨头发布新模型',
              url: 'https://example.com/ai-story',
            },
          ],
        },
      ],
    });
    hottestAnalysis.getHottestAnalysis.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      cached: false,
      dataState: 'ready',
      emptyReason: null,
      diagnostics: {
        sourcesRequested: 2,
        sourcesSucceeded: 2,
        sourcesFailed: 0,
        sourceItemsFetched: 2,
      },
      sourcesAnalyzed: 2,
      itemsAnalyzed: 2,
      errors: [],
      candidates: [],
      bySource: {
        weibo: {
          [signalKey]: {
            sourceId: 'weibo',
            itemId: signalKey,
            clusterId: 'c-1',
            theme: 'AI',
            candidateLabel: 'AI',
            candidateSummary: null,
            reason: null,
            topics: ['ai'],
            entities: ['openai'],
            contentKind: 'article',
            sourceCount: 2,
            heatScore: 0.8,
            freshnessScore: 0.9,
            candidateScore: 0.88,
            isNew: true,
            isRising: true,
            bridgeEligible: true,
            bridgeStatus: 'eligible',
            matchedItemId: 'item-1',
            matchedEventId: 'event-1',
          },
        },
      },
    });
    service = new NewsnowRecommendedService(
      registry,
      aggregator,
      hottestAnalysis,
      behavior,
      userSettings,
    );
  });

  it('builds deduplicated recommended items ranked by combined scores', async () => {
    const result = await service.getRecommendedFeed({
      orgId: 'org-1',
      userId: 'user-1',
      limit: 10,
    });

    expect(result.degraded).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceId: 'weibo',
      matchedItemId: 'item-1',
      matchedEventId: 'event-1',
    });
    expect([
      '相似用户也在关注',
      '匹配近期事件偏好',
      '匹配近期阅读偏好',
      '匹配近期主题偏好',
    ]).toContain(result.items[0]?.reasonLabel);
    expect(result.items[0]?.scoreBreakdown.collaborative).toBeGreaterThan(0);
  });

  it('falls back to source and hotness signals when hottest analysis is unavailable', async () => {
    hottestAnalysis.getHottestAnalysis.mockRejectedValue(new Error('upstream unavailable'));

    const result = await service.getRecommendedFeed({
      orgId: 'org-1',
      userId: 'user-1',
      limit: 10,
    });

    expect(result.degraded).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.scoreBreakdown.content).toBeGreaterThanOrEqual(0);
    expect(result.items[0]?.scoreBreakdown.hotness).toBeGreaterThan(0);
  });
});
