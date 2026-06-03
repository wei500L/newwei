jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockProcessedItemFind = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: (...args: unknown[]) => mockProcessedItemFind(...args),
  },
}));

import { NewsEventsTimelineService } from "../news-events-timeline.service";

describe("NewsEventsTimelineService", () => {
  const makeMongoFindQuery = (docs: unknown[]) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(docs),
  });
  const makeSchedulerDeps = () => ({
    cache: {
      setIfAbsent: jest.fn().mockResolvedValue(true),
      withLock: jest.fn(
        async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) =>
          await runner(),
      ),
    },
    schedulerSettings: {
      getRuntimeSettings: jest.fn().mockResolvedValue({
        newsEventsTimelineOrgConcurrency: 2,
      }),
    },
  });

  beforeEach(() => {
    mockProcessedItemFind.mockReset();
  });

  it("writes confidence-aware timeline metadata and topic drift warnings", async () => {
    mockProcessedItemFind.mockReturnValueOnce(
      makeMongoFindQuery([
        {
          _id: "pi-1",
          result: {
            category: "tech",
            category_path: "tech/ai/model-release",
            category_confidence: 0.91,
          },
        },
        {
          _id: "pi-2",
          result: {
            category: "gov",
            category_path: "gov/regulation/sanctions",
            category_confidence: 0.42,
          },
        },
      ]),
    );

    const prisma = {
      newsEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "event-1",
            metadata: {
              classification: { legacyCategory: "tech" },
              timeline: {
                entries: {
                  "2025-12-31T00:00:00.000Z": {
                    categoryPath: "tech",
                    categoryConfidence: 0.6,
                    tentative: false,
                    anchor: false,
                    importanceScore: 0.5,
                    itemCount: 1,
                  },
                },
              },
            },
            startAt: new Date("2026-01-01T00:00:00.000Z"),
            lastAt: new Date("2026-01-02T12:00:00.000Z"),
          },
        ]),
        update: jest.fn().mockResolvedValue(null),
      },
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            processedItemId: "pi-1",
            processedArticle: {
              id: "pa-1",
              articleId: "article-1",
              category: "tech",
              title: "Model release",
              summary: "A new foundation model was released.",
              keyPoints: ["release"],
              qualityScore: 0.82,
              publishedAt: new Date("2026-01-01T09:00:00.000Z"),
              processedAt: new Date("2026-01-01T10:00:00.000Z"),
              article: {
                crawlAt: new Date("2026-01-01T09:30:00.000Z"),
              },
            },
          },
          {
            processedItemId: "pi-2",
            processedArticle: {
              id: "pa-2",
              articleId: "article-2",
              category: "gov",
              title: "Regulation response",
              summary: "Regulators responded to the release.",
              keyPoints: ["response"],
              qualityScore: 0.71,
              publishedAt: new Date("2026-01-02T08:00:00.000Z"),
              processedAt: new Date("2026-01-02T09:00:00.000Z"),
              article: {
                crawlAt: new Date("2026-01-02T08:30:00.000Z"),
              },
            },
          },
        ]),
      },
      newsEventTimelineEntry: {
        upsert: jest.fn().mockResolvedValue(null),
      },
    };

    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        enabled: true,
        ingestionEnabled: true,
        timelineEnabled: true,
        backfillDays: 30,
        lookbackDays: 30,
        timelineMaxEventsPerRun: 50,
        minCategoryConfidenceForGate: 0.4,
      }),
    };

    const { cache, schedulerSettings } = makeSchedulerDeps();
    const service = new NewsEventsTimelineService(
      cache as any,
      prisma as any,
      schedulerSettings as any,
      settings as any,
    );

    await (service as any).rebuildOrg("org-1");

    expect(prisma.newsEventTimelineEntry.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.newsEvent.update).toHaveBeenCalledTimes(1);

    const updatePayload = (prisma.newsEvent.update as jest.Mock).mock
      .calls[0]?.[0];
    expect(updatePayload).toEqual(
      expect.objectContaining({
        where: { id: "event-1" },
        data: expect.objectContaining({
          metadata: expect.any(Object),
        }),
      }),
    );

    const timelineMeta = updatePayload.data.metadata.timeline as {
      topicDriftWarning: boolean;
      categoryDistribution: { categoryPath: string; share: number }[];
      entries: Record<
        string,
        { tentative: boolean; anchor: boolean; categoryPath: string | null }
      >;
      phaseSummaries: unknown[];
      subEvents: unknown[];
    };

    expect(timelineMeta.topicDriftWarning).toBe(true);
    expect(timelineMeta.categoryDistribution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryPath: "tech/ai/model-release" }),
        expect.objectContaining({ categoryPath: "gov/regulation/sanctions" }),
      ]),
    );
    expect(timelineMeta.entries["2026-01-01T00:00:00.000Z"]).toEqual(
      expect.objectContaining({
        categoryPath: "tech/ai/model-release",
        anchor: true,
        tentative: false,
      }),
    );
    expect(timelineMeta.entries["2026-01-02T00:00:00.000Z"]).toEqual(
      expect.objectContaining({
        categoryPath: "gov/regulation/sanctions",
        anchor: false,
        tentative: true,
      }),
    );
    expect(timelineMeta.entries["2025-12-31T00:00:00.000Z"]).toEqual(
      expect.objectContaining({
        categoryPath: "tech",
      }),
    );
    expect(Array.isArray(timelineMeta.phaseSummaries)).toBe(true);
    expect(Array.isArray(timelineMeta.subEvents)).toBe(true);
  });

  it("applies timeline thresholds from settings for tentative and anchor markers", async () => {
    mockProcessedItemFind.mockReturnValueOnce(
      makeMongoFindQuery([
        {
          _id: "pi-3",
          result: {
            category: "tech",
            category_path: "tech/ai/research",
            category_confidence: 0.75,
          },
        },
      ]),
    );

    const prisma = {
      newsEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "event-2",
            metadata: {},
            startAt: new Date("2026-01-03T00:00:00.000Z"),
            lastAt: new Date("2026-01-03T12:00:00.000Z"),
          },
        ]),
        update: jest.fn().mockResolvedValue(null),
      },
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            processedItemId: "pi-3",
            processedArticle: {
              id: "pa-3",
              articleId: "article-3",
              category: "tech",
              title: "Research update",
              summary: "A model research update was published.",
              keyPoints: ["research"],
              qualityScore: 0.7,
              publishedAt: new Date("2026-01-03T08:00:00.000Z"),
              processedAt: new Date("2026-01-03T09:00:00.000Z"),
              article: {
                crawlAt: new Date("2026-01-03T08:20:00.000Z"),
              },
            },
          },
        ]),
      },
      newsEventTimelineEntry: {
        upsert: jest.fn().mockResolvedValue(null),
      },
    };

    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        enabled: true,
        ingestionEnabled: true,
        timelineEnabled: true,
        backfillDays: 30,
        lookbackDays: 30,
        timelineMaxEventsPerRun: 50,
        minCategoryConfidenceForGate: 0.4,
        timelineLowConfidenceThreshold: 0.7,
        timelineHighConfidenceThreshold: 0.74,
        timelineDriftKlThreshold: 0.8,
        timelineMinBucketItemsForDrift: 5,
        timelineCrossCategoryWarningShare: 0.95,
        timelineMaxCategoryDistributionItems: 4,
        timelineMaxPhaseSummaries: 2,
      }),
    };

    const { cache, schedulerSettings } = makeSchedulerDeps();
    const service = new NewsEventsTimelineService(
      cache as any,
      prisma as any,
      schedulerSettings as any,
      settings as any,
    );

    await (service as any).rebuildOrg("org-1");

    const updatePayload = (prisma.newsEvent.update as jest.Mock).mock
      .calls[0]?.[0];
    const timelineMeta = updatePayload.data.metadata.timeline as {
      entries: Record<
        string,
        {
          tentative: boolean;
          anchor: boolean;
          categoryConfidence: number | null;
        }
      >;
      phaseSummaries: unknown[];
      categoryDistribution: unknown[];
    };
    const entry = timelineMeta.entries["2026-01-03T00:00:00.000Z"];

    expect(entry).toEqual(
      expect.objectContaining({
        anchor: true,
        tentative: false,
      }),
    );
    expect(Array.isArray(timelineMeta.phaseSummaries)).toBe(true);
    expect(timelineMeta.phaseSummaries.length).toBeLessThanOrEqual(2);
    expect(Array.isArray(timelineMeta.categoryDistribution)).toBe(true);
    expect(timelineMeta.categoryDistribution.length).toBeLessThanOrEqual(4);
  });

  it("prunes expired timeline classification cache entries proactively", async () => {
    mockProcessedItemFind.mockReturnValueOnce(makeMongoFindQuery([]));

    const { cache, schedulerSettings } = makeSchedulerDeps();
    const service = new NewsEventsTimelineService(
      cache as any,
      {} as any,
      schedulerSettings as any,
      {} as any,
    );

    (
      (service as any).processedItemClassificationCache as Map<
        string,
        { expiresAt: number; value: unknown }
      >
    ).set("stale-id", {
      expiresAt: Date.now() - 10_000,
      value: null,
    });

    await (service as any).loadProcessedItemClassificationMap(["pi-new"]);

    expect(
      (
        (service as any).processedItemClassificationCache as Map<
          string,
          unknown
        >
      ).has("stale-id"),
    ).toBe(false);
    expect(mockProcessedItemFind).toHaveBeenCalledWith({
      _id: { $in: ["pi-new"] },
    });
  });
});
