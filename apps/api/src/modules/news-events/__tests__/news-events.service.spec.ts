jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockProcessedItemFindById = jest.fn();
const mockProcessedItemFind = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    findById: (...args: unknown[]) => mockProcessedItemFindById(...args),
    find: (...args: unknown[]) => mockProcessedItemFind(...args),
  },
}));

import { NewsEventAssignmentMethod, NewsEventStatus } from "@prisma/client";

import { NewsEventsService } from "../news-events.service";

describe("NewsEventsService", () => {
  const makeEmbeddingQuery = (doc: unknown) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(doc),
  });
  const makeFindQuery = (docs: unknown[]) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(docs),
  });

  const makeSettings = (overrides: Partial<any> = {}) => ({
    enabled: true,
    ingestionEnabled: true,
    maxBatchSize: 100,
    backfillDays: 30,
    lookbackDays: 30,
    vectorMinScore: 0.82,
    crossLanguagePenalty: 0.1,
    classificationGateEnabled: true,
    categoryConflictReject: true,
    categorySoftPenalty: 0.15,
    minCategoryConfidenceForGate: 0.4,
    cacheTtlSeconds: 60,
    ...overrides,
  });

  beforeEach(() => {
    mockProcessedItemFindById.mockReset();
    mockProcessedItemFind.mockReset();
  });

  it("returns existing assignment without writes", async () => {
    const prisma = {
      newsEventItem: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "nei-1", eventId: "event-1" }),
      },
      runInTransaction: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    const result = await service.assignNewsSignalToEvent(
      "org-1",
      {
        articleId: "a-1",
        processedArticleId: "pa-1",
        processedItemId: "pi-1",
        timestamp: new Date("2026-01-03T00:00:00.000Z"),
        language: "en",
        title: "t",
        summary: "s",
        topics: [],
        entities: [],
        sentiment: null,
        qualityScore: null,
      },
      makeSettings(),
    );

    expect(result).toEqual({ eventId: "event-1", created: false });
    expect(prisma.runInTransaction).not.toHaveBeenCalled();
  });

  it("assigns to an existing event via vector search", async () => {
    mockProcessedItemFindById.mockReturnValueOnce(
      makeEmbeddingQuery({
        summaryEmbedding: [0.1, 0.2],
        summaryEmbeddingModel: "embed-1",
      }),
    );

    const prisma = {
      newsEventItem: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([{ eventId: "event-1", processedItemId: "pi-2" }]),
      },
      newsEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "event-1",
            language: "en",
            startAt: new Date("2026-01-01T00:00:00.000Z"),
            lastAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ]),
      },
      runInTransaction: jest.fn(),
    };

    const tx = {
      newsEventItem: {
        create: jest.fn().mockResolvedValue(null),
      },
      newsEvent: {
        findUnique: jest.fn().mockResolvedValue({
          startAt: new Date("2026-01-01T00:00:00.000Z"),
          lastAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
        update: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };

    prisma.runInTransaction.mockImplementation(async (fn: any) => fn(tx));

    const vectorClient = {
      searchBestEffort: jest
        .fn()
        .mockResolvedValue([{ processedItemId: "pi-2", score: 0.9 }]),
    };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    const result = await service.assignNewsSignalToEvent(
      "org-1",
      {
        articleId: "a-1",
        processedArticleId: "pa-1",
        processedItemId: "pi-1",
        timestamp: new Date("2026-01-03T00:00:00.000Z"),
        language: "en",
        title: "t",
        summary: "s",
        topics: ["topic-1"],
        entities: [{ name: "entity-1", type: null, confidence: 0.9 }],
        sentiment: null,
        qualityScore: null,
      },
      makeSettings(),
    );

    expect(result).toEqual({ eventId: "event-1", created: true });
    expect(vectorClient.searchBestEffort).toHaveBeenCalled();
    expect(tx.newsEventItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "event-1",
          assignedBy: NewsEventAssignmentMethod.vector,
          similarity: 0.9,
        }),
      }),
    );
    expect(tx.newsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "event-1" },
        data: expect.objectContaining({
          startAt: new Date("2026-01-01T00:00:00.000Z"),
          lastAt: new Date("2026-01-03T00:00:00.000Z"),
        }),
      }),
    );
    expect(prisma.newsEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: NewsEventStatus.active }),
      }),
    );
  });

  it("creates a new event when no candidates match", async () => {
    mockProcessedItemFindById.mockReturnValueOnce(
      makeEmbeddingQuery({
        summaryEmbedding: [0.1, 0.2],
        summaryEmbeddingModel: "embed-1",
      }),
    );

    const prisma = {
      newsEventItem: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      newsEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      runInTransaction: jest.fn(),
    };

    const tx = {
      newsEventItem: {
        create: jest.fn().mockResolvedValue(null),
      },
      newsEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: "event-new" }),
      },
    };

    prisma.runInTransaction.mockImplementation(async (fn: any) => fn(tx));

    const vectorClient = {
      searchBestEffort: jest.fn().mockResolvedValue([]),
    };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    const result = await service.assignNewsSignalToEvent(
      "org-1",
      {
        articleId: "a-1",
        processedArticleId: "pa-1",
        processedItemId: "pi-1",
        timestamp: new Date("2026-01-03T00:00:00.000Z"),
        language: "en",
        title: "t",
        summary: "s",
        topics: ["topic-1"],
        entities: [{ name: "entity-1", type: null, confidence: 0.9 }],
        sentiment: null,
        qualityScore: null,
      },
      makeSettings(),
    );

    expect(result).toEqual({ eventId: "event-new", created: true });
    expect(tx.newsEvent.create).toHaveBeenCalled();
    expect(tx.newsEventItem.create).toHaveBeenCalled();
    expect(tx.newsEvent.update).not.toHaveBeenCalled();
  });

  it("clamps future signal timestamp to now when creating a new event", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-02-15T12:00:00.000Z"));
    try {
      mockProcessedItemFindById.mockReturnValueOnce(
        makeEmbeddingQuery({
          summaryEmbedding: [0.1, 0.2],
          summaryEmbeddingModel: "embed-1",
        }),
      );

      const prisma = {
        newsEventItem: {
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        newsEvent: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        runInTransaction: jest.fn(),
      };

      const tx = {
        newsEventItem: {
          create: jest.fn().mockResolvedValue(null),
        },
        newsEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
          create: jest.fn().mockResolvedValue({ id: "event-new" }),
        },
      };

      prisma.runInTransaction.mockImplementation(async (fn: any) => fn(tx));

      const vectorClient = {
        searchBestEffort: jest.fn().mockResolvedValue([]),
      };
      const service = new NewsEventsService(prisma as any, vectorClient as any);

      await service.assignNewsSignalToEvent(
        "org-1",
        {
          articleId: "a-1",
          processedArticleId: "pa-1",
          processedItemId: "pi-1",
          timestamp: new Date("2026-08-05T00:00:00.000Z"),
          language: "en",
          title: "t",
          summary: "s",
          topics: ["topic-1"],
          entities: [{ name: "entity-1", type: null, confidence: 0.9 }],
          sentiment: null,
          qualityScore: null,
        },
        makeSettings(),
      );

      expect(tx.newsEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startAt: new Date("2026-02-15T12:00:00.000Z"),
            lastAt: new Date("2026-02-15T12:00:00.000Z"),
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects vector merge when category conflicts under gate settings", async () => {
    mockProcessedItemFindById.mockReturnValueOnce(
      makeEmbeddingQuery({
        summaryEmbedding: [0.1, 0.2],
        summaryEmbeddingModel: "embed-1",
      }),
    );

    const prisma = {
      newsEventItem: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([{ eventId: "event-1", processedItemId: "pi-2" }]),
      },
      newsEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "event-1",
            language: "en",
            metadata: { classification: { legacyCategory: "politics" } },
            startAt: new Date("2026-01-01T00:00:00.000Z"),
            lastAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ]),
      },
      runInTransaction: jest.fn(),
    };

    const tx = {
      newsEventItem: {
        create: jest.fn().mockResolvedValue(null),
      },
      newsEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: "event-new" }),
      },
    };

    prisma.runInTransaction.mockImplementation(async (fn: any) => fn(tx));

    const vectorClient = {
      searchBestEffort: jest
        .fn()
        .mockResolvedValue([{ processedItemId: "pi-2", score: 0.95 }]),
    };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    const result = await service.assignNewsSignalToEvent(
      "org-1",
      {
        articleId: "a-1",
        processedArticleId: "pa-1",
        processedItemId: "pi-1",
        timestamp: new Date("2026-01-03T00:00:00.000Z"),
        language: "en",
        title: "t",
        summary: "s",
        topics: [],
        entities: [],
        sentiment: null,
        qualityScore: null,
        legacyCategory: "finance",
        categoryPath: "finance/markets/equities",
        categoryConfidence: 0.92,
      },
      makeSettings(),
    );

    expect(result).toEqual({ eventId: "event-new", created: true });
    expect(tx.newsEvent.create).toHaveBeenCalled();
  });

  it("skips category gate when signal confidence is unavailable", async () => {
    mockProcessedItemFindById.mockReturnValueOnce(
      makeEmbeddingQuery({
        summaryEmbedding: [0.1, 0.2],
        summaryEmbeddingModel: "embed-1",
      }),
    );

    const prisma = {
      newsEventItem: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([{ eventId: "event-1", processedItemId: "pi-2" }]),
      },
      newsEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "event-1",
            language: "en",
            metadata: { classification: { legacyCategory: "politics" } },
            startAt: new Date("2026-01-01T00:00:00.000Z"),
            lastAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ]),
      },
      runInTransaction: jest.fn(),
    };

    const tx = {
      newsEventItem: {
        create: jest.fn().mockResolvedValue(null),
      },
      newsEvent: {
        findUnique: jest.fn().mockResolvedValue({
          startAt: new Date("2026-01-01T00:00:00.000Z"),
          lastAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
        update: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };

    prisma.runInTransaction.mockImplementation(async (fn: any) => fn(tx));

    const vectorClient = {
      searchBestEffort: jest
        .fn()
        .mockResolvedValue([{ processedItemId: "pi-2", score: 0.95 }]),
    };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    const result = await service.assignNewsSignalToEvent(
      "org-1",
      {
        articleId: "a-1",
        processedArticleId: "pa-1",
        processedItemId: "pi-1",
        timestamp: new Date("2026-01-03T00:00:00.000Z"),
        language: "en",
        title: "t",
        summary: "s",
        topics: [],
        entities: [],
        sentiment: null,
        qualityScore: null,
        legacyCategory: "finance",
        categoryPath: "finance/markets/equities",
      },
      makeSettings(),
    );

    expect(result).toEqual({ eventId: "event-1", created: true });
    expect(tx.newsEventItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "event-1",
          assignedBy: NewsEventAssignmentMethod.vector,
        }),
      }),
    );
    expect(tx.newsEvent.create).not.toHaveBeenCalled();
  });

  it("allows listEvents to fetch up to 300 candidates for downstream filtering", async () => {
    const prisma = {
      newsEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    await service.listEvents("org-1", {
      limit: 999,
      windowDays: 21,
      status: NewsEventStatus.active,
    });

    expect(prisma.newsEvent.findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        status: NewsEventStatus.active,
        lastAt: { gte: expect.any(Date) },
      },
      orderBy: [{ lastAt: "desc" }, { startAt: "desc" }],
      take: 300,
      include: {
        _count: { select: { items: true } },
      },
    });
  });

  it("applies entity contains filter for listEvents", async () => {
    const prisma = {
      newsEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    await service.listEvents("org-1", {
      limit: 50,
      windowDays: 30,
      status: NewsEventStatus.active,
      entity: "  Douglas Engelbart  ",
    });

    expect(prisma.newsEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: "org-1",
          status: NewsEventStatus.active,
          primaryEntity: { contains: "Douglas Engelbart" },
        }),
      }),
    );
  });

  it("filters event timeline by settings window when loading event detail", async () => {
    const prisma = {
      newsEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const settingsService = {
      getSettings: jest.fn().mockResolvedValue({
        backfillDays: 7,
        lookbackDays: 30,
      }),
    };
    const service = new NewsEventsService(
      prisma as any,
      vectorClient as any,
      undefined,
      settingsService as any,
    );

    await service.getEvent("org-1", "event-1", { timelineLimit: 50 });

    expect(settingsService.getSettings).toHaveBeenCalledWith("org-1");
    expect(prisma.newsEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: "org-1", id: "event-1" },
        include: expect.objectContaining({
          timeline: expect.objectContaining({
            where: {
              bucketStart: { gte: expect.any(Date) },
            },
            orderBy: [{ bucketStart: "asc" }],
            take: 50,
          }),
        }),
      }),
    );
  });

  it("aggregates category distribution with processed-item category_path priority", async () => {
    mockProcessedItemFind.mockReturnValueOnce(
      makeFindQuery([
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
            category: "tech",
            category_path: "tech/ai/model-release",
            category_confidence: 0.84,
          },
        },
        {
          _id: "pi-3",
          result: {
            category: "gov",
            category_path: "gov/regulation/sanctions",
            category_confidence: 0.78,
          },
        },
      ]),
    );

    const prisma = {
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            eventId: "event-1",
            processedItemId: "pi-1",
            processedArticle: { category: "tech" },
          },
          {
            eventId: "event-1",
            processedItemId: "pi-2",
            processedArticle: { category: "finance" },
          },
          {
            eventId: "event-1",
            processedItemId: null,
            processedArticle: { category: "finance" },
          },
          {
            eventId: "event-2",
            processedItemId: "pi-3",
            processedArticle: { category: "gov" },
          },
        ]),
      },
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    const result = await service.getEventCategoryDistributionMap(
      "org-1",
      ["event-1", "event-2"],
      { windowDays: 30 },
    );

    expect(prisma.newsEventItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: "org-1",
          eventId: { in: ["event-1", "event-2"] },
          processedArticle: {
            processedAt: { gte: expect.any(Date) },
          },
        }),
      }),
    );
    expect(mockProcessedItemFind).toHaveBeenCalledWith({
      _id: { $in: ["pi-1", "pi-2", "pi-3"] },
    });

    expect(result.get("event-1")).toEqual([
      {
        categoryPath: "tech/ai/model-release",
        legacyCategory: "tech",
        count: 2,
        share: 0.6667,
      },
      {
        categoryPath: "finance",
        legacyCategory: "finance",
        count: 1,
        share: 0.3333,
      },
    ]);
    expect(result.get("event-2")).toEqual([
      {
        categoryPath: "gov/regulation/sanctions",
        legacyCategory: "gov",
        count: 1,
        share: 1,
      },
    ]);
  });

  it("prunes expired event distribution cache entries proactively", async () => {
    const prisma = {
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    (
      (service as any).eventCategoryDistributionCache as Map<
        string,
        { expiresAt: number; value: Map<string, unknown> }
      >
    ).set("stale-entry", {
      expiresAt: Date.now() - 10_000,
      value: new Map([["event-stale", []]]),
    });

    await service.getEventCategoryDistributionMap("org-1", ["event-1"], {
      windowDays: 30,
    });

    expect(
      ((service as any).eventCategoryDistributionCache as Map<string, unknown>).has(
        "stale-entry",
      ),
    ).toBe(false);
  });

  it("calculates authority profile and credibility for events", async () => {
    const prisma = {
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            eventId: "event-mainstream",
            processedArticle: {
              article: {
                sourceLabel: "Reuters",
                url: "https://www.reuters.com/world/example",
              },
            },
          },
          {
            eventId: "event-mainstream",
            processedArticle: {
              article: {
                sourceLabel: "Bloomberg",
                url: "https://www.bloomberg.com/markets/example",
              },
            },
          },
          {
            eventId: "event-blog",
            processedArticle: {
              article: {
                sourceLabel: "Creator Notes",
                url: "https://example.substack.com/p/update",
              },
            },
          },
          {
            eventId: "event-blog",
            processedArticle: {
              article: {
                sourceLabel: "Opinion",
                url: "https://medium.com/@author/post",
              },
            },
          },
        ]),
      },
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    const result = await service.getEventAuthorityMap(
      "org-1",
      ["event-mainstream", "event-blog", "event-missing"],
      { windowDays: 30 },
    );

    expect(result.get("event-mainstream")).toEqual(
      expect.objectContaining({
        sourceType: "authoritative",
        uniqueSourceCount: 2,
        authoritativeSourceCount: 2,
        blogSourceCount: 0,
        corroborated: true,
      }),
    );
    expect((result.get("event-mainstream")?.credibilityScore ?? 0) > 70).toBe(
      true,
    );

    expect(result.get("event-blog")).toEqual(
      expect.objectContaining({
        sourceType: "blog",
        authoritativeSourceCount: 0,
        blogSourceCount: 2,
      }),
    );
    expect((result.get("event-blog")?.credibilityScore ?? 100) < 20).toBe(true);

    expect(result.get("event-missing")).toEqual(
      expect.objectContaining({
        sourceType: "unknown",
        credibilityScore: 0,
      }),
    );
  });

  it("applies org-level source policy overrides when classifying event sources", async () => {
    const prisma = {
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            eventId: "event-1",
            processedArticle: {
              article: {
                sourceLabel: "Reuters",
                url: "https://www.reuters.com/world/example",
              },
            },
          },
        ]),
      },
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const sourcePolicyService = {
      getPolicy: jest.fn().mockResolvedValue({
        authoritativeDomains: [],
        authoritativeLabels: [],
        blogDomains: ["reuters.com"],
        blogLabels: [],
      }),
    };

    const service = new NewsEventsService(
      prisma as any,
      vectorClient as any,
      sourcePolicyService as any,
    );
    const result = await service.getEventAuthorityMap("org-1", ["event-1"], {
      windowDays: 30,
    });

    expect(sourcePolicyService.getPolicy).toHaveBeenCalledWith("org-1");
    expect(result.get("event-1")).toEqual(
      expect.objectContaining({
        sourceType: "blog",
        authoritativeSourceCount: 0,
        blogSourceCount: 1,
      }),
    );
  });

  it("resolves referenced articles by event membership without capped event-item prefetch", async () => {
    const prisma = {
      newsEventItem: {
        findMany: jest.fn(),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "pa-2",
            articleId: "article-2",
            title: "Article 2",
            publishedAt: new Date("2026-01-02T00:00:00.000Z"),
            processedAt: new Date("2026-01-03T00:00:00.000Z"),
            article: {
              id: "article-2",
              url: "https://example.com/2",
              sourceLabel: "Example",
              crawlAt: new Date("2026-01-02T00:00:00.000Z"),
            },
          },
          {
            id: "pa-1",
            articleId: "article-1",
            title: "Article 1",
            publishedAt: new Date("2026-01-01T00:00:00.000Z"),
            processedAt: new Date("2026-01-02T00:00:00.000Z"),
            article: {
              id: "article-1",
              url: "https://example.com/1",
              sourceLabel: null,
              crawlAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          },
        ]),
      },
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const service = new NewsEventsService(prisma as any, vectorClient as any);

    const rows = await service.listEventReferencedArticles(
      "org-1",
      "event-1",
      [" article-2 ", "article-1", "article-1"],
      { limit: 50 },
    );

    expect(prisma.processedArticle.findMany).toHaveBeenCalledWith({
      where: {
        articleId: { in: ["article-2", "article-1"] },
        newsEventItems: {
          some: {
            orgId: "org-1",
            eventId: "event-1",
          },
        },
      },
      orderBy: [{ processedAt: "desc" }],
      take: 50,
      include: {
        article: {
          select: {
            id: true,
            url: true,
            sourceLabel: true,
            crawlAt: true,
          },
        },
      },
    });
    expect(prisma.newsEventItem.findMany).not.toHaveBeenCalled();
    expect(rows.map((row) => row.id)).toEqual(["article-2", "article-1"]);
    expect(rows.map((row) => row.processedArticleId)).toEqual(["pa-2", "pa-1"]);
  });
});
