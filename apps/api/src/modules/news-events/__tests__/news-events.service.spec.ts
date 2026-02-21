jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockProcessedItemFindById = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    findById: (...args: unknown[]) => mockProcessedItemFindById(...args),
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

  const makeSettings = (overrides: Partial<any> = {}) => ({
    enabled: true,
    ingestionEnabled: true,
    maxBatchSize: 100,
    backfillDays: 30,
    lookbackDays: 30,
    vectorMinScore: 0.82,
    crossLanguagePenalty: 0.1,
    cacheTtlSeconds: 60,
    ...overrides,
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
});
