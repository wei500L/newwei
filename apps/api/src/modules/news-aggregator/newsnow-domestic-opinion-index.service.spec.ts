import { ProcessedItemModel } from '@modular/mongo';

import {
  NewsnowDataState,
  NewsnowDomesticOpinionEmptyReason,
} from './news-aggregator.types';
import { NewsnowDomesticOpinionIndexService } from './newsnow-domestic-opinion-index.service';

describe('NewsnowDomesticOpinionIndexService', () => {
  const candidateSnapshotDelegate = {
    deleteMany: jest.fn(),
    upsert: jest.fn(),
    findMany: jest.fn(),
  };
  const domesticIndexDelegate = {
    upsert: jest.fn(),
    findMany: jest.fn(),
  };
  const processedArticleDelegate = {
    findMany: jest.fn(),
  };
  const prismaMock = {
    runInTransaction: jest.fn(),
    newsnowCandidateSnapshot: candidateSnapshotDelegate,
    newsnowDomesticOpinionIndexSnapshot: domesticIndexDelegate,
    processedArticle: processedArticleDelegate,
  } as any;
  const processedItemFindLean = jest.fn();

  let service: NewsnowDomesticOpinionIndexService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useRealTimers();
    prismaMock.runInTransaction.mockImplementation(
      async (runner: (tx: typeof prismaMock) => Promise<unknown>) => await runner(prismaMock),
    );
    candidateSnapshotDelegate.deleteMany.mockResolvedValue({ count: 0 });
    candidateSnapshotDelegate.upsert.mockResolvedValue(undefined);
    candidateSnapshotDelegate.findMany.mockResolvedValue([]);
    domesticIndexDelegate.upsert.mockResolvedValue(undefined);
    domesticIndexDelegate.findMany.mockResolvedValue([]);
    processedArticleDelegate.findMany.mockResolvedValue([]);
    jest.spyOn(ProcessedItemModel, 'aggregate').mockResolvedValue([] as never);
    processedItemFindLean.mockResolvedValue([]);
    jest.spyOn(ProcessedItemModel, 'find').mockReturnValue({
      lean: processedItemFindLean,
    } as never);
    service = new NewsnowDomesticOpinionIndexService(prismaMock);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('persists topic/entity keywords ahead of title fallback', async () => {
    await service.persistSnapshots({
      orgId: 'org-1',
      generatedAt: new Date('2026-03-13T10:15:00.000Z'),
      totalDomesticSourceCount: 3,
      candidates: [
        {
          candidateHash: 'candidate-1',
          label: '新能源车热度',
          summary: 'summary',
          representativeTitle: '新能源汽车销量大涨',
          themes: ['新能源车热度'],
          topics: ['新能源'],
          entities: ['比亚迪'],
          sourceIds: ['weibo', 'thepaper'],
          domesticSourceIds: ['weibo', 'thepaper'],
          sourceCount: 2,
          itemCount: 2,
          heatScore: 0.8,
          freshnessScore: 0.7,
          candidateScore: 0.75,
          authorityScore: 0.6,
          domesticSourceCount: 2,
          domesticItemCount: 2,
          matchedItemIds: [],
        },
      ],
    });

    const create = candidateSnapshotDelegate.upsert.mock.calls[0]?.[0]?.create;
    expect(create.keywords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: '新能源', source: 'topic' }),
        expect.objectContaining({ keyword: '比亚迪', source: 'entity' }),
      ]),
    );
    expect(create.keywords).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'title' })]),
    );
  });

  it('falls back to representative title keywords when topics/entities are absent', async () => {
    await service.persistSnapshots({
      orgId: 'org-1',
      generatedAt: new Date('2026-03-13T10:15:00.000Z'),
      totalDomesticSourceCount: 2,
      candidates: [
        {
          candidateHash: 'candidate-1',
          label: 'OpenAI 热点',
          summary: null,
          representativeTitle: 'OpenAI 发布 GPT-5.4 新模型',
          themes: [],
          topics: [],
          entities: [],
          sourceIds: ['weibo'],
          domesticSourceIds: ['weibo'],
          sourceCount: 1,
          itemCount: 1,
          heatScore: 0.7,
          freshnessScore: 0.9,
          candidateScore: 0.8,
          authorityScore: 0.55,
          domesticSourceCount: 1,
          domesticItemCount: 1,
          matchedItemIds: [],
        },
      ],
    });

    const create = candidateSnapshotDelegate.upsert.mock.calls[0]?.[0]?.create;
    expect(create.keywords.length).toBeGreaterThan(0);
    expect(create.keywords).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'title' })]),
    );
  });

  it('cleans stale bucket candidates and stores zero sentiment pressure when no sentiment exists', async () => {
    await service.persistSnapshots({
      orgId: 'org-1',
      generatedAt: new Date('2026-03-13T10:15:00.000Z'),
      totalDomesticSourceCount: 4,
      candidates: [
        {
          candidateHash: 'domestic-1',
          label: '国内主题',
          summary: null,
          representativeTitle: '国内主题',
          themes: ['国内主题'],
          topics: ['主题'],
          entities: [],
          sourceIds: ['weibo', 'thepaper'],
          domesticSourceIds: ['weibo', 'thepaper'],
          sourceCount: 2,
          itemCount: 2,
          heatScore: 0.8,
          freshnessScore: 0.6,
          candidateScore: 0.7,
          authorityScore: 0.5,
          domesticSourceCount: 2,
          domesticItemCount: 2,
          matchedItemIds: ['item-meta-1'],
        },
        {
          candidateHash: 'world-1',
          label: '国际主题',
          summary: null,
          representativeTitle: '国际主题',
          themes: ['国际主题'],
          topics: ['国际'],
          entities: [],
          sourceIds: ['hackernews'],
          domesticSourceIds: [],
          sourceCount: 1,
          itemCount: 1,
          heatScore: 0.9,
          freshnessScore: 0.8,
          candidateScore: 0.9,
          authorityScore: 1,
          domesticSourceCount: 0,
          domesticItemCount: 0,
          matchedItemIds: [],
        },
      ],
    });

    expect(candidateSnapshotDelegate.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        orgId: 'org-1',
        candidateHash: { notIn: ['domestic-1', 'world-1'] },
      }),
    });

    const domesticCreate = candidateSnapshotDelegate.upsert.mock.calls[0]?.[0]?.create;
    expect(domesticCreate.sentimentPressure).toBe(0);

    const indexCreate = domesticIndexDelegate.upsert.mock.calls[0]?.[0]?.create;
    expect(indexCreate.candidateCount).toBe(1);
    expect(indexCreate.keywordSummary).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: '主题' })]),
    );
  });

  it('returns a stable empty response when no domestic opinion snapshots exist', async () => {
    const response = await service.getDomesticOpinionIndex('org-1');

    expect(response).toEqual({
      generatedAt: expect.any(String),
      dataState: NewsnowDataState.Empty,
      emptyReason: NewsnowDomesticOpinionEmptyReason.NoRecentSnapshotsOrPipelineData,
      diagnostics: {
        requestedHours: 24,
        snapshotCount: 0,
        pipelineBucketCount: 0,
      },
      latest: null,
      trend: [],
      topKeywords: [],
      topCandidates: [],
      breakdown: {
        latest: null,
        trend: [],
        topKeywords: {
          newsnow: [],
          pipeline: [],
        },
      },
    });
  });

  it('returns latest trend, keywords, top candidates, and breakdown for a NewsNow-only bucket', async () => {
    domesticIndexDelegate.findMany.mockResolvedValue([
      {
        bucketStart: new Date('2026-03-13T09:00:00.000Z'),
        indexValue: 0.51,
        attentionScore: 0.49,
        breadthScore: 0.4,
        freshnessScore: 0.55,
        sentimentPressure: 0.2,
        candidateCount: 2,
        keywordSummary: [{ keyword: '新能源', weight: 1.2 }],
      },
      {
        bucketStart: new Date('2026-03-13T10:00:00.000Z'),
        indexValue: 0.64,
        attentionScore: 0.61,
        breadthScore: 0.58,
        freshnessScore: 0.62,
        sentimentPressure: 0.24,
        candidateCount: 3,
        keywordSummary: [{ keyword: 'AI', weight: 1.5 }],
      },
    ]);
    candidateSnapshotDelegate.findMany.mockResolvedValue([
      { label: '候选 A', candidateScore: 0.66, domesticRatio: 1, sourceCount: 3 },
      { label: '候选 B', candidateScore: 0.9, domesticRatio: 0.4, sourceCount: 2 },
    ]);

    const response = await service.getDomesticOpinionIndex('org-1', { hours: 48 });

    expect(response.dataState).toBe(NewsnowDataState.Ready);
    expect(response.emptyReason).toBeNull();
    expect(response.diagnostics).toEqual({
      requestedHours: 48,
      snapshotCount: 2,
      pipelineBucketCount: 0,
    });
    expect(response.latest).toMatchObject({
      bucketStart: '2026-03-13T10:00:00.000Z',
      indexValue: 0.64,
      candidateCount: 3,
    });
    expect(response.topKeywords).toEqual([{ keyword: 'AI', weight: 1.5 }]);
    expect(response.topCandidates[0]).toMatchObject({ label: '候选 A' });
    expect(response.trend).toHaveLength(2);
    expect(response.breakdown.latest).toMatchObject({
      bucketStart: '2026-03-13T10:00:00.000Z',
      newsnow: expect.objectContaining({
        candidateCount: 3,
        indexValue: 0.64,
      }),
      pipeline: null,
    });
    expect(response.breakdown.topKeywords).toEqual({
      newsnow: [{ keyword: 'AI', weight: 1.5 }],
      pipeline: [],
    });
  });

  it('returns pipeline-only domestic opinion data when no NewsNow bucket exists', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-13T11:30:00.000Z'));
    processedArticleDelegate.findMany.mockResolvedValue([
      {
        id: 'processed-article-1',
        title: '国内基建政策继续加码',
        summary: '多地推进基建投资与项目审批。',
        topics: ['基建'],
        entities: [{ name: '国家发改委' }],
        qualityScore: 0.8,
        language: 'zh-CN',
        location: '中国',
        publishedAt: new Date('2026-03-13T10:35:00.000Z'),
        processedAt: new Date('2026-03-13T10:36:00.000Z'),
        cleanedMarkdownRef: 'processed-item-1',
        article: {
          crawlAt: new Date('2026-03-13T10:36:00.000Z'),
          sourceId: 'custom-source-1',
          source: {
            language: 'zh-CN',
          },
        },
      },
    ]);
    processedItemFindLean.mockResolvedValue([
      {
        _id: 'processed-item-1',
        sourceId: null,
        result: {
          sentiment_label: 'negative',
        },
      },
    ]);

    const response = await service.getDomesticOpinionIndex('org-1');

    expect(response.latest).toMatchObject({
      bucketStart: '2026-03-13T10:00:00.000Z',
      candidateCount: 0,
    });
    expect(response.topCandidates).toEqual([]);
    expect(response.topKeywords).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: '基建' })]),
    );
    expect(response.breakdown.latest?.newsnow).toBeNull();
    expect(response.breakdown.latest?.pipeline).toMatchObject({
      articleCount: 1,
      sourceCount: 1,
      sentimentPressure: 1,
    });
    expect(response.breakdown.topKeywords.pipeline).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: '基建' })]),
    );
  });

  it('merges NewsNow and pipeline buckets with weighted breakdowns', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-13T11:30:00.000Z'));
    domesticIndexDelegate.findMany.mockResolvedValue([
      {
        bucketStart: new Date('2026-03-13T10:00:00.000Z'),
        indexValue: 0.6,
        attentionScore: 0.6,
        breadthScore: 0.5,
        freshnessScore: 0.7,
        sentimentPressure: 0.2,
        candidateCount: 4,
        keywordSummary: [{ keyword: 'AI', weight: 1.5 }],
      },
    ]);
    candidateSnapshotDelegate.findMany.mockResolvedValue([
      { label: '候选 A', candidateScore: 0.72, domesticRatio: 1, sourceCount: 3 },
    ]);
    processedArticleDelegate.findMany.mockResolvedValue([
      {
        id: 'processed-article-1',
        title: '国内基建政策继续加码',
        summary: '多地推进基建投资与项目审批。',
        topics: ['基建'],
        entities: [{ name: '国家发改委' }],
        qualityScore: 0.8,
        language: 'zh-CN',
        location: '中国',
        publishedAt: new Date('2026-03-13T10:35:00.000Z'),
        processedAt: new Date('2026-03-13T10:36:00.000Z'),
        cleanedMarkdownRef: 'processed-item-1',
        article: {
          crawlAt: new Date('2026-03-13T10:36:00.000Z'),
          sourceId: 'custom-source-1',
          source: {
            language: 'zh-CN',
          },
        },
      },
    ]);
    processedItemFindLean.mockResolvedValue([
      {
        _id: 'processed-item-1',
        sourceId: null,
        result: {
          sentiment_label: 'negative',
        },
      },
    ]);

    const response = await service.getDomesticOpinionIndex('org-1');

    expect(response.latest?.bucketStart).toBe('2026-03-13T10:00:00.000Z');
    expect(response.latest?.candidateCount).toBe(4);
    expect(response.latest?.attentionScore).toBeCloseTo(0.5175, 4);
    expect(response.latest?.breadthScore).toBeCloseTo(0.464, 3);
    expect(response.latest?.freshnessScore).toBeCloseTo(0.671, 3);
    expect(response.latest?.sentimentPressure).toBeCloseTo(0.36, 3);
    expect(response.latest?.indexValue).toBeCloseTo(0.5217, 4);
    expect(response.breakdown.latest).toMatchObject({
      newsnow: expect.objectContaining({
        candidateCount: 4,
        indexValue: 0.6,
      }),
      pipeline: expect.objectContaining({
        articleCount: 1,
        sourceCount: 1,
      }),
    });
    expect(response.topKeywords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'AI' }),
        expect.objectContaining({ keyword: '基建' }),
      ]),
    );
    expect(response.topCandidates[0]).toMatchObject({ label: '候选 A' });
  });

  it('treats known china-column processed item sources as domestic even without domestic-affairs semantics', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-13T11:30:00.000Z'));
    processedArticleDelegate.findMany.mockResolvedValue([
      {
        id: 'processed-article-2',
        title: '科技公司发布新手机',
        summary: '新品发布会聚焦芯片和影像升级。',
        topics: ['手机'],
        entities: [{ name: '某科技公司' }],
        qualityScore: 0.6,
        language: 'en',
        location: null,
        publishedAt: new Date('2026-03-13T10:20:00.000Z'),
        processedAt: new Date('2026-03-13T10:25:00.000Z'),
        cleanedMarkdownRef: 'processed-item-2',
        article: {
          crawlAt: new Date('2026-03-13T10:25:00.000Z'),
          sourceId: null,
          source: {
            language: 'en',
          },
        },
      },
    ]);
    processedItemFindLean.mockResolvedValue([
      {
        _id: 'processed-item-2',
        sourceId: 'weibo',
        result: {
          sentiment_label: 'neutral',
        },
      },
    ]);

    const response = await service.getDomesticOpinionIndex('org-1');

    expect(response.breakdown.latest?.pipeline).toMatchObject({
      articleCount: 1,
      sourceCount: 1,
      sentimentPressure: 0,
    });
  });
});
