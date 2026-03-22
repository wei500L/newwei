import { ServiceUnavailableException } from "@nestjs/common";

import { ItemStatus } from "../../common/pipeline-status";

import { ItemsService } from "./items.service";

const mockProcessedItemAggregate = jest.fn();
const mockProcessedItemFind = jest.fn();

jest.mock(
  "@modular/vector-client",
  () => ({
    VectorBadResponseError: class VectorBadResponseError extends Error {},
    VectorClient: class VectorClient {
      search = jest.fn();
      upsert = jest.fn();
    },
    VectorServiceUnavailableError: class VectorServiceUnavailableError extends Error {},
    VectorUnauthorizedError: class VectorUnauthorizedError extends Error {},
  }),
  { virtual: true }
);

jest.mock("@modular/mongo", () => ({
  RawItemModel: {
    create: jest.fn()
  },
  ProcessedItemModel: {
    aggregate: (...args: unknown[]) => mockProcessedItemAggregate(...args),
    find: (...args: unknown[]) => mockProcessedItemFind(...args)
  }
}));

beforeEach(() => {
  mockProcessedItemAggregate.mockReset();
  mockProcessedItemFind.mockReset();
});

describe("ItemsService.list", () => {
  it("returns total consistent with filtered item rows", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "meta-1",
            orgId: "org-1",
            createdAt: new Date("2024-01-03T00:00:00.000Z"),
            updatedAt: new Date("2024-01-04T00:00:00.000Z")
          }
        ]),
        count: jest.fn().mockResolvedValue(1)
      }
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    (service as any).resolveScopedIds = jest.fn().mockResolvedValue(["meta-1", "meta-2"]);

    const result = await service.list(
      "org-1",
      1,
      10,
      "hello world",
      undefined,
      "CREATED_DESC"
    );

    expect(prisma.itemMeta.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 10,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        where: {
          orgId: "org-1",
          status: { not: ItemStatus.Duplicate },
          id: { in: ["meta-1", "meta-2"] }
        }
      })
    );

    expect(prisma.itemMeta.count).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        status: { not: ItemStatus.Duplicate },
        id: { in: ["meta-1", "meta-2"] }
      }
    });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
  });

  it("returns relevance-ranked rows when ranking mode is RELEVANCE", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn(),
        count: jest.fn()
      }
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      {
        liteLlmConfig: {},
        itemsSearchRankingConfig: {
          rerankEnabled: false,
          recallMaxCandidates: 120,
          rerankMaxCandidates: 40,
          rerankTimeoutMs: 300,
          recencyHalfLifeHours: 48
        }
      } as any,
      {} as any,
      {} as any
    );

    (service as any).resolveScopedIds = jest.fn().mockResolvedValue(["meta-2", "meta-1"]);
    (service as any).rankScopedIdsByRelevance = jest
      .fn()
      .mockResolvedValue([
        { id: "meta-1", score: 0.91 },
        { id: "meta-2", score: 0.77 }
      ]);
    (service as any).fetchItemMetaRowsByIds = jest.fn().mockResolvedValue(
      new Map([
        [
          "meta-1",
          {
            id: "meta-1",
            name: "Item 1",
            status: "active",
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
            updatedAt: new Date("2024-01-02T00:00:00.000Z"),
            sortAt: new Date("2024-01-02T00:00:00.000Z"),
            orgId: "org-1"
          }
        ],
        [
          "meta-2",
          {
            id: "meta-2",
            name: "Item 2",
            status: "active",
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
            updatedAt: new Date("2024-01-02T00:00:00.000Z"),
            sortAt: new Date("2024-01-01T00:00:00.000Z"),
            orgId: "org-1"
          }
        ]
      ])
    );

    const result = await service.list(
      "org-1",
      1,
      10,
      "fed rate",
      undefined,
      "CREATED_DESC",
      "RELEVANCE"
    );

    expect((service as any).rankScopedIdsByRelevance).toHaveBeenCalledWith(
      "org-1",
      "fed rate",
      ["meta-2", "meta-1"]
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ id: "meta-1", relevanceScore: 0.91 });
    expect(result.items[1]).toMatchObject({ id: "meta-2", relevanceScore: 0.77 });
  });

  it("throws explicit RERANK_UNAVAILABLE code when rerank service fails", async () => {
    const liteLlmMock = {
      rerank: jest.fn().mockRejectedValue(new Error("upstream unavailable"))
    };

    const service = new ItemsService(
      {
        itemMeta: {
          findMany: jest.fn(),
          count: jest.fn()
        }
      } as any,
      {} as any,
      {} as any,
      {
        liteLlmConfig: {},
        itemsSearchRankingConfig: {
          rerankEnabled: true,
          recallMaxCandidates: 120,
          rerankMaxCandidates: 40,
          rerankTimeoutMs: 300,
          recencyHalfLifeHours: 48
        }
      } as any,
      liteLlmMock as any,
      {} as any
    );

    await expect(
      (service as any).tryRerankCandidates({
        orgId: "org-1",
        query: "fed policy",
        candidates: [{ id: "meta-1", document: "Fed signals higher for longer" }],
        timeoutMs: 300
      })
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    try {
      await (service as any).tryRerankCandidates({
        orgId: "org-1",
        query: "fed policy",
        candidates: [{ id: "meta-1", document: "Fed signals higher for longer" }],
        timeoutMs: 300
      });
    } catch (error) {
      const response = (error as ServiceUnavailableException).getResponse() as {
        code?: string;
      };
      expect(response.code).toBe("RERANK_UNAVAILABLE");
    }
  });
});

describe("ItemsService.listWithCursor", () => {
  it("uses sortAt keyset pagination for published desc", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "meta-1",
            orgId: "org-1",
            createdAt: new Date("2024-01-03T00:00:00.000Z"),
            sortAt: new Date("2024-01-03T00:00:00.000Z")
          },
          {
            id: "meta-0",
            orgId: "org-1",
            createdAt: new Date("2024-01-02T00:00:00.000Z"),
            sortAt: new Date("2024-01-02T00:00:00.000Z")
          }
        ]),
        count: jest.fn().mockResolvedValue(2),
        findFirst: jest.fn()
      }
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    await service.listWithCursor(
      "org-1",
      1,
      { id: "meta-2", sortAt: "2024-01-02T00:00:00.000Z" },
      undefined,
      undefined,
      "PUBLISHED_DESC"
    );

    expect(prisma.itemMeta.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ sortAt: "desc" }, { id: "desc" }],
        take: 2,
        where: {
          AND: [
            { orgId: "org-1", status: { not: ItemStatus.Duplicate } },
            {
              OR: [
                { sortAt: { lt: new Date("2024-01-02T00:00:00.000Z") } },
                { sortAt: new Date("2024-01-02T00:00:00.000Z"), id: { lt: "meta-2" } }
              ]
            }
          ]
        }
      })
    );

    expect(prisma.itemMeta.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to loading cursor timestamps when missing", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({
          id: "meta-1",
          orgId: "org-1",
          createdAt: new Date("2024-01-02T00:00:00.000Z"),
          sortAt: new Date("2024-01-05T00:00:00.000Z")
        })
      }
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    await service.listWithCursor(
      "org-1",
      1,
      { id: "meta-1" },
      undefined,
      undefined,
      "PUBLISHED_DESC"
    );

    expect(prisma.itemMeta.findFirst).toHaveBeenCalledWith({
      where: { id: "meta-1", orgId: "org-1" },
      select: { createdAt: true, sortAt: true }
    });

    expect(prisma.itemMeta.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ sortAt: "desc" }, { id: "desc" }],
        take: 2
      })
    );
  });

  it("anchors relevance cursor pagination to cursor id before offset", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn()
      }
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    (service as any).resolveScopedIds = jest
      .fn()
      .mockResolvedValue(["meta-1", "meta-2", "meta-3", "meta-4"]);
    (service as any).rankScopedIdsByRelevance = jest.fn().mockResolvedValue([
      { id: "meta-1", score: 0.98 },
      { id: "meta-2", score: 0.88 },
      { id: "meta-3", score: 0.78 },
      { id: "meta-4", score: 0.68 }
    ]);
    (service as any).fetchItemMetaRowsByIds = jest.fn().mockImplementation(async (_orgId: string, ids: string[]) => {
      return new Map(
        ids.map((id, index) => [
          id,
          {
            id,
            orgId: "org-1",
            status: ItemStatus.Completed,
            createdAt: new Date(`2024-01-0${index + 1}T00:00:00.000Z`),
            updatedAt: new Date(`2024-01-0${index + 1}T01:00:00.000Z`)
          }
        ])
      );
    });

    const result = await service.listWithCursor(
      "org-1",
      2,
      { id: "meta-2", offset: 0 },
      "fed rate",
      undefined,
      "PUBLISHED_DESC",
      "RELEVANCE"
    );

    expect(result.items.map((item) => item.id)).toEqual(["meta-3", "meta-4"]);
    expect(result.items[0]).toMatchObject({ rankOffset: 2 });
    expect(result.items[1]).toMatchObject({ rankOffset: 3 });
    expect(result.hasNextPage).toBe(false);
  });
});

describe("ItemsService personalized pagination cap", () => {
  const buildCandidateRows = (count: number) => {
    const baseMs = Date.parse("2024-01-01T00:00:00.000Z");
    return Array.from({ length: count }, (_, index) => ({
      id: `meta-${index + 1}`,
      createdAt: new Date(baseMs - index * 60_000),
      sortAt: new Date(baseMs - index * 60_000)
    }));
  };

  const buildService = () => {
    const candidates = buildCandidateRows(1600);
    const prisma = {
      itemMeta: {
        count: jest.fn().mockResolvedValue(5000),
        findMany: jest.fn().mockImplementation(async (args: { take?: number }) => {
          const take = typeof args?.take === "number" ? args.take : candidates.length;
          return candidates.slice(0, take);
        })
      }
    };
    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );
    (service as any).resolveScopedIds = jest.fn().mockResolvedValue(undefined);
    (service as any).loadItemPersonalizationProfile = jest.fn().mockResolvedValue({
      sources: {},
      topics: {},
      entities: {},
      items: {},
      events: {},
      domains: {}
    });
    (service as any).rankPersonalizedCandidates = jest
      .fn()
      .mockImplementation(async (input: { candidates: Array<{ id: string }> }) =>
        input.candidates.map((candidate, index) => ({
          id: candidate.id,
          score: 1,
          rankOffset: index
        }))
      );
    return { service };
  };

  it("caps page-mode total to the personalized candidate window", async () => {
    const { service } = buildService();

    const result = await service.list(
      "org-1",
      161,
      10,
      undefined,
      undefined,
      "PERSONALIZED",
      "RECENCY",
      "user-1"
    );

    expect(result.items).toEqual([]);
    expect(result.total).toBe(1600);
  });

  it("caps cursor-mode totalCount to avoid phantom hasNext pages", async () => {
    const { service } = buildService();

    const result = await service.listWithCursor(
      "org-1",
      10,
      { id: "meta-1600", offset: 1599 },
      undefined,
      undefined,
      "PERSONALIZED",
      "RECENCY",
      "user-1"
    );

    expect(result.items).toEqual([]);
    expect(result.hasNextPage).toBe(false);
    expect(result.totalCount).toBe(1600);
  });
});

describe("ItemsService.createFromCrawlResult", () => {
  it("creates an item meta + raw item and enqueues the pipeline job", async () => {
    const { RawItemModel } = jest.requireMock("@modular/mongo") as {
      RawItemModel: { create: jest.Mock };
    };

    const prisma = {
      crawlResult: {
        findFirst: jest.fn().mockResolvedValue({
          id: "crawl-result-1",
          taskId: "crawl-task-1",
          sourceUrl: "https://example.com/story",
          fetchedAt: new Date("2024-01-01T00:00:00.000Z"),
          contentHash: "hash-1",
          metadata: { thumbnail: "https://example.com/thumb.jpg" },
          task: { id: "crawl-task-1", displayName: "Example", targetUrl: "https://example.com" }
        })
      },
      itemMeta: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "meta-1",
          orgId: "org-1",
          externalId: "crawlResult:crawl-result-1",
          name: "Example: https://example.com/story",
          status: ItemStatus.Pending,
          mongoRef: "",
          createdAt: new Date("2024-01-02T00:00:00.000Z"),
          updatedAt: new Date("2024-01-02T00:00:00.000Z")
        }),
        update: jest.fn().mockResolvedValue(null)
      },
      $transaction: jest.fn(async (cb: any) => cb(prisma))
    };

    RawItemModel.create.mockResolvedValue({ id: "raw-1" });

    const queueService = { enqueueItem: jest.fn().mockResolvedValue(null) };

    const service = new ItemsService(
      prisma as any,
      queueService as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    const created = await service.createFromCrawlResult("org-1", "user-1", "crawl-result-1");

    expect(prisma.crawlResult.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "crawl-result-1",
          task: { orgId: "org-1" }
        }
      })
    );
    expect(prisma.itemMeta.create).toHaveBeenCalledTimes(1);
    expect(RawItemModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        itemMetaId: "meta-1",
        source: "crawl-task",
        payload: expect.objectContaining({
          url: "https://example.com/story",
          sourceName: "Example",
          metadata: expect.objectContaining({
            crawlResultId: "crawl-result-1",
            crawlTaskId: "crawl-task-1"
          })
        })
      })
    );
    expect(queueService.enqueueItem).toHaveBeenCalledWith(
      "org-1",
      "meta-1",
      "raw-1",
      {},
      { pipelineJobId: undefined, sourceId: undefined }
    );
    expect(created.id).toBe("meta-1");
  });
});

describe("ItemsService filters", () => {
  it("applies sourceIds in processed filter aggregation", async () => {
    mockProcessedItemFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([])
    });

    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0)
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([])
      }
    };

    mockProcessedItemAggregate.mockResolvedValue([]);

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    await (service as any).resolveFilterIds("org-1", {
      sourceIds: ["source-1", "source-2"]
    });

    expect(mockProcessedItemAggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          $match: expect.objectContaining({
            $and: expect.arrayContaining([{ sourceId: { $in: ["source-1", "source-2"] } }])
          }),
        })
      ])
    );
  });

  it("applies contentTypes in processed filter aggregation", async () => {
    mockProcessedItemFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([])
    });

    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0)
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([])
      }
    };

    mockProcessedItemAggregate.mockResolvedValue([]);

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    await (service as any).resolveFilterIds("org-1", {
      contentTypes: ["news_fact", "analysis"]
    });

    expect(mockProcessedItemAggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          $match: expect.objectContaining({
            $and: expect.arrayContaining([
              {
                $or: [
                  { "result.content_type": { $in: expect.any(Array) } },
                  { "result.contentType": { $in: expect.any(Array) } }
                ]
              }
            ])
          }),
        })
      ])
    );
  });

  it("falls back to ProcessedArticle links when ProcessedItem.sourceId is missing", async () => {
    mockProcessedItemAggregate.mockResolvedValue([]);
    mockProcessedItemFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ itemMetaId: "meta-fallback-1" }])
    });

    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0)
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            cleanedMarkdownRef: "507f1f77bcf86cd799439011"
          }
        ])
      }
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    const ids = await (service as any).resolveFilterIds("org-1", {
      sourceIds: ["rss-1"]
    });

    expect(ids).toEqual(["meta-fallback-1"]);
    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(1);
    expect(mockProcessedItemFind).toHaveBeenCalledTimes(1);
  });

  it("builds facets from the latest processed snapshot per item", async () => {
    mockProcessedItemFind.mockReturnValueOnce({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: "507f1f77bcf86cd799439011",
          itemMetaId: "meta-1",
          createdAt: new Date("2024-01-03T00:00:00.000Z"),
          result: {
            location: "US",
            topics: [{ name: "AI" }],
            entities: [{ name: "OpenAI" }],
            sentiment: "positive",
            contentType: "analysis",
          },
          tags: ["AI"],
        },
        {
          _id: "507f1f77bcf86cd799439012",
          itemMetaId: "meta-1",
          createdAt: new Date("2024-01-02T00:00:00.000Z"),
          result: {
            location: "APAC",
            topics: ["Old topic"],
            sentiment: "negative",
            contentType: "opinion",
          },
          tags: ["legacy"],
        },
        {
          _id: "507f1f77bcf86cd799439013",
          itemMetaId: "meta-2",
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
          result: {
            region: "EU",
            topics: ["Macro"],
            sentiment_label: "neutral",
            content_type: "news_fact",
          },
          tags: [],
        },
      ]),
    });
    mockProcessedItemFind.mockReturnValueOnce({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });

    const service = new ItemsService(
      {} as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );
    (service as any).resolveScopedIds = jest.fn().mockResolvedValue(null);

    const facets = await service.getFacets("org-1");

    expect(facets.regions).toEqual([
      { value: "EU", count: 1 },
      { value: "US", count: 1 },
    ]);
    expect(facets.topics).toEqual([
      { value: "AI", count: 1 },
      { value: "Macro", count: 1 },
      { value: "OpenAI", count: 1 },
    ]);
    expect(facets.sentiments).toEqual([
      { value: "neutral", count: 1 },
      { value: "positive", count: 1 },
    ]);
    expect(facets.contentTypes).toEqual([
      { value: "analysis", count: 1 },
      { value: "news_fact", count: 1 },
    ]);
  });

  it("ranks merged search ids before recall truncation", async () => {
    const service = new ItemsService(
      {} as any,
      {} as any,
      {} as any,
      {
        liteLlmConfig: {},
        itemsSearchRankingConfig: {
          rerankEnabled: false,
          recallMaxCandidates: 2,
          rerankMaxCandidates: 2,
          rerankTimeoutMs: 300,
          recencyHalfLifeHours: 48,
        },
      } as any,
      {} as any,
      {} as any
    );

    (service as any).resolveMetaSearchIds = jest
      .fn()
      .mockResolvedValue(["meta-a", "meta-b", "meta-c"]);
    (service as any).resolveProcessedSearchIds = jest
      .fn()
      .mockResolvedValue(["meta-b"]);
    (service as any).resolveProcessedArticleSearchIds = jest
      .fn()
      .mockResolvedValue(["meta-c"]);
    (service as any).resolveVectorSearchIds = jest
      .fn()
      .mockResolvedValue(["meta-c", "meta-b"]);
    (service as any).fetchItemMetaRowsByIds = jest.fn().mockResolvedValue(
      new Map([
        [
          "meta-b",
          {
            id: "meta-b",
            name: "B",
            status: "active",
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
            updatedAt: new Date("2024-01-01T00:00:00.000Z"),
            sortAt: new Date("2024-01-01T00:00:00.000Z"),
            orgId: "org-1",
          },
        ],
        [
          "meta-c",
          {
            id: "meta-c",
            name: "C",
            status: "active",
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
            updatedAt: new Date("2024-01-01T00:00:00.000Z"),
            sortAt: new Date("2024-01-01T00:00:00.000Z"),
            orgId: "org-1",
          },
        ],
      ]),
    );
    mockProcessedItemFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });

    const ranked = await (service as any).rankScopedIdsByRelevance(
      "org-1",
      "fed policy",
      await (service as any).resolveSearchIds("org-1", "fed policy"),
    );

    expect(ranked.map((entry: { id: string }) => entry.id)).toEqual([
      "meta-b",
      "meta-c",
    ]);
  });
});

describe("ItemsService.listRssSourcesForReading", () => {
  it("returns rss sources with item stats and excludes non-rss configs", async () => {
    const prisma = {
      newsSource: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "rss-1",
            name: "Feed One",
            language: "en",
            url: "https://example.com",
            config: { seed: { mode: "rss", feedUrl: "https://example.com/rss.xml" } }
          },
          {
            id: "rss-2",
            name: "Feed Two",
            language: "zh",
            url: "https://example.org",
            config: { seed: { mode: "rss", feedUrl: "https://example.org/feed" } }
          },
          {
            id: "list-1",
            name: "List Source",
            language: "en",
            url: "https://list.example.com",
            config: { seed: { mode: "list" } }
          }
        ])
      },
      article: {
        groupBy: jest.fn().mockResolvedValue([
          {
            sourceId: "rss-2",
            _count: { _all: 2 },
            _max: { crawlAt: new Date("2026-02-09T00:00:00.000Z") }
          }
        ])
      }
    };

    mockProcessedItemAggregate.mockResolvedValue([
      {
        _id: "rss-1",
        itemCountWindow: 3,
        latestItemAt: new Date("2026-02-10T00:00:00.000Z")
      }
    ]);

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    const rows = await service.listRssSourcesForReading("org-1", {
      windowDays: 7,
      onlyWithItems: true
    });

    expect(rows).toEqual([
      {
        id: "rss-1",
        name: "Feed One",
        language: "en",
        siteUrl: "https://example.com",
        feedUrl: "https://example.com/rss.xml",
        latestItemAt: "2026-02-10T00:00:00.000Z",
        itemCountWindow: 3
      },
      {
        id: "rss-2",
        name: "Feed Two",
        language: "zh",
        siteUrl: "https://example.org",
        feedUrl: "https://example.org/feed",
        latestItemAt: "2026-02-09T00:00:00.000Z",
        itemCountWindow: 2
      }
    ]);
    expect(mockProcessedItemAggregate).toHaveBeenCalledTimes(1);
    expect(prisma.article.groupBy).toHaveBeenCalledTimes(1);
  });
});

describe("ItemsService.searchSuggestions", () => {
  it("merges lexical + semantic scores and exposes hybrid origin", async () => {
    const cacheMock = {
      wrap: jest.fn(async (_key: string, _ttlSeconds: number, loader: () => Promise<unknown>) =>
        loader()
      )
    };
    const service = new ItemsService(
      {} as any,
      {} as any,
      cacheMock as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    (service as any).getFacets = jest.fn().mockResolvedValue({
      topics: [{ value: "AI", count: 12 }],
      regions: [{ value: "Asia", count: 5 }],
      sentiments: [{ value: "positive", count: 6 }]
    });
    (service as any).resolveSourceSuggestionCounts = jest
      .fn()
      .mockResolvedValue(new Map([["Reuters", 4]]));
    (service as any).resolveSemanticSuggestions = jest.fn().mockResolvedValue([
      { type: "TOPIC", value: "AI", score: 88 },
      { type: "SOURCE", value: "OpenAI", score: 66 }
    ]);

    const suggestions = await service.searchSuggestions("org-1", "ai", 6);

    expect(cacheMock.wrap).toHaveBeenCalledTimes(1);
    expect((service as any).resolveSemanticSuggestions).toHaveBeenCalledWith("org-1", "ai", 36);
    expect(suggestions).toEqual(
      expect.arrayContaining([
        { type: "TOPIC", value: "AI", origin: "HYBRID" },
        { type: "SOURCE", value: "OpenAI", origin: "SEMANTIC" },
        { type: "SOURCE", value: "Reuters", origin: "LEXICAL" }
      ])
    );
    expect(suggestions.filter((entry: { value: string }) => entry.value === "AI")).toHaveLength(1);
  });

  it("returns lexical-only origins when semantic suggestions are empty", async () => {
    const cacheMock = {
      wrap: jest.fn(async (_key: string, _ttlSeconds: number, loader: () => Promise<unknown>) =>
        loader()
      )
    };
    const service = new ItemsService(
      {} as any,
      {} as any,
      cacheMock as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    (service as any).getFacets = jest.fn().mockResolvedValue({
      topics: [],
      regions: [],
      sentiments: []
    });
    (service as any).resolveSourceSuggestionCounts = jest
      .fn()
      .mockResolvedValue(new Map([["Reuters", 3]]));
    (service as any).resolveSemanticSuggestions = jest.fn().mockResolvedValue([]);

    const suggestions = await service.searchSuggestions("org-1", "re", 3);

    expect(suggestions).toEqual([{ type: "SOURCE", value: "Reuters", origin: "LEXICAL" }]);
  });
});
