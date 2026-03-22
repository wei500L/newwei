import { ServiceUnavailableException } from "@nestjs/common";

import { ItemStatus } from "../../common/pipeline-status";

import { ItemsService } from "./items.service";

const mockRawItemCreate = jest.fn();
const mockRawItemFind = jest.fn();
const mockRawItemAggregate = jest.fn();
const mockProcessedItemAggregate = jest.fn();
const mockProcessedItemFind = jest.fn();
const mockItemReadModelFind = jest.fn();
const mockItemReadModelFindOne = jest.fn();
const mockItemReadModelUpdateOne = jest.fn();
const mockItemReadModelBulkWrite = jest.fn();

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
    create: (...args: unknown[]) => mockRawItemCreate(...args),
    find: (...args: unknown[]) => mockRawItemFind(...args),
    aggregate: (...args: unknown[]) => mockRawItemAggregate(...args)
  },
  ProcessedItemModel: {
    aggregate: (...args: unknown[]) => mockProcessedItemAggregate(...args),
    find: (...args: unknown[]) => mockProcessedItemFind(...args)
  },
  ItemReadModelModel: {
    find: (...args: unknown[]) => mockItemReadModelFind(...args),
    findOne: (...args: unknown[]) => mockItemReadModelFindOne(...args),
    updateOne: (...args: unknown[]) => mockItemReadModelUpdateOne(...args),
    bulkWrite: (...args: unknown[]) => mockItemReadModelBulkWrite(...args)
  }
}));

beforeEach(() => {
  mockRawItemCreate.mockReset();
  mockRawItemFind.mockReset();
  mockRawItemAggregate.mockReset();
  mockProcessedItemAggregate.mockReset();
  mockProcessedItemFind.mockReset();
  mockItemReadModelFind.mockReset();
  mockItemReadModelFindOne.mockReset();
  mockItemReadModelUpdateOne.mockReset();
  mockItemReadModelBulkWrite.mockReset();
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
      .mockImplementation(async (input: { candidates: { id: string }[] }) =>
        input.candidates.map((candidate, index) => ({
          id: candidate.id,
          score: 1,
          rankOffset: index
        }))
      );
    return { service };
  };

  const asSortedLeanResult = <T>(value: T) => ({
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(value),
      }),
    }),
  });

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

  it("fetches additional Prisma candidates incrementally and ranks once", async () => {
    const baseMs = Date.parse("2024-01-01T00:00:00.000Z");
    const firstBatch = Array.from({ length: 800 }, (_, index) => ({
      id: `meta-${(index % 80) + 1}`,
      createdAt: new Date(baseMs - index * 60_000),
      sortAt: new Date(baseMs - index * 60_000),
    }));
    const secondBatch = Array.from({ length: 800 }, (_, index) => ({
      id: `meta-${81 + index}`,
      createdAt: new Date(baseMs - (800 + index) * 60_000),
      sortAt: new Date(baseMs - (800 + index) * 60_000),
    }));
    const prisma = {
      itemMeta: {
        count: jest.fn().mockResolvedValue(1600),
        findMany: jest
          .fn()
          .mockResolvedValueOnce(firstBatch)
          .mockResolvedValueOnce(secondBatch),
      },
    };
    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any,
    );
    const where = {
      orgId: "org-1",
      status: { not: ItemStatus.Duplicate },
    };
    const rankPersonalizedCandidates = jest
      .fn()
      .mockImplementation(async (input: { candidates: { id: string }[] }) =>
        input.candidates.map((candidate, index) => ({
          id: candidate.id,
          score: 1,
          rankOffset: index,
        })),
      );

    (service as any).loadItemPersonalizationProfile = jest.fn().mockResolvedValue({
      sources: {},
      topics: {},
      entities: {},
      items: {},
      events: {},
      domains: {},
    });
    (service as any).rankPersonalizedCandidates = rankPersonalizedCandidates;

    const result = await (service as any).getPersonalizedRanking({
      orgId: "org-1",
      userId: "user-1",
      where,
      requiredCount: 100,
    });

    expect(prisma.itemMeta.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.itemMeta.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where,
        orderBy: [{ sortAt: "desc" }, { id: "desc" }],
        take: 800,
      }),
    );
    expect(prisma.itemMeta.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          AND: [
            where,
            {
              OR: [
                { sortAt: { lt: firstBatch[799].sortAt } },
                { sortAt: firstBatch[799].sortAt, id: { lt: firstBatch[799].id } },
              ],
            },
          ],
        },
        orderBy: [{ sortAt: "desc" }, { id: "desc" }],
        take: 800,
      }),
    );
    expect(rankPersonalizedCandidates).toHaveBeenCalledTimes(1);
    const rankedCandidates = rankPersonalizedCandidates.mock.calls[0][0].candidates as Array<{
      id: string;
    }>;
    expect(rankedCandidates).toHaveLength(880);
    expect(new Set(rankedCandidates.map((candidate) => candidate.id)).size).toBe(
      rankedCandidates.length,
    );
    expect(result.total).toBe(1600);
  });

  it("applies a keyset cursor when fetching read-model personalized candidates", async () => {
    const cursorSortAt = new Date("2024-01-02T00:00:00.000Z");
    mockItemReadModelFind.mockReturnValueOnce(
      asSortedLeanResult([
        {
          itemMetaId: "meta-11",
          createdAt: new Date("2024-01-01T23:59:00.000Z"),
          sortAt: new Date("2024-01-01T23:59:00.000Z"),
        },
        {
          itemMetaId: "meta-10",
          createdAt: new Date("2024-01-01T23:58:00.000Z"),
          sortAt: new Date("2024-01-01T23:58:00.000Z"),
        },
      ]),
    );

    const service = new ItemsService(
      {} as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {}, itemsReadModelEnabled: true } as any,
      {} as any,
      {} as any,
    );

    const result = await (service as any).fetchPersonalizedCandidateBatch({
      orgId: "org-1",
      where: {},
      take: 2,
      cursor: {
        id: "meta-12",
        sortAt: cursorSortAt,
      },
    });

    expect(mockItemReadModelFind).toHaveBeenCalledWith(
      {
        $and: [
          {
            orgId: "org-1",
            status: { $ne: ItemStatus.Duplicate },
          },
          {
            $or: [
              { sortAt: { $lt: cursorSortAt } },
              { sortAt: cursorSortAt, itemMetaId: { $lt: "meta-12" } },
            ],
          },
        ],
      },
      {
        itemMetaId: 1,
        createdAt: 1,
        sortAt: 1,
      },
    );
    expect(result.candidates.map((candidate: { id: string }) => candidate.id)).toEqual([
      "meta-11",
      "meta-10",
    ]);
    expect(result.nextCursor).toEqual({
      id: "meta-10",
      sortAt: new Date("2024-01-01T23:58:00.000Z"),
    });
    expect(result.exhausted).toBe(false);
  });
});

describe("ItemsService.createFromCrawlResult", () => {
  it("creates an item meta + raw item and enqueues the pipeline job", async () => {
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

    mockRawItemCreate.mockResolvedValue({ id: "raw-1" });

    const queueService = { enqueueItem: jest.fn().mockResolvedValue(null) };

    const service = new ItemsService(
      prisma as any,
      queueService as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );
    (service as any).hydrateItemReadModel = jest.fn().mockResolvedValue(null);

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
    expect(mockRawItemCreate).toHaveBeenCalledWith(
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

  it("skips ProcessedArticle search for prefix queries", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn(),
      },
      $queryRaw: jest.fn(),
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    const ids = await (service as any).resolveProcessedArticleSearchIds("org-1", {
      type: "prefix",
      term: "ai",
    });

    expect(ids).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.processedArticle.findMany).not.toHaveBeenCalled();
    expect(mockProcessedItemFind).not.toHaveBeenCalled();
  });

  it("uses ProcessedArticle fulltext matches when a boolean query is available", async () => {
    mockProcessedItemFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ itemMetaId: "meta-fulltext-1" }])
    });

    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        { cleanedMarkdownRef: "507f1f77bcf86cd799439011", score: 4.2 },
        { cleanedMarkdownRef: null, score: 1.1 },
        { cleanedMarkdownRef: "not-an-object-id", score: 0.8 }
      ])
    };

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    const ids = await (service as any).resolveProcessedArticleSearchIds("org-1", {
      type: "fulltext",
      query: "federal* policy*",
    });

    expect(ids).toEqual(["meta-fulltext-1"]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
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

  it("keeps merging non-ProcessedArticle sources for short queries", async () => {
    const service = new ItemsService(
      {} as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any
    );

    (service as any).resolveMetaSearchIds = jest.fn().mockResolvedValue(["meta-a"]);
    (service as any).resolveProcessedSearchIds = jest.fn().mockResolvedValue(["meta-b"]);
    (service as any).resolveVectorSearchIds = jest.fn().mockResolvedValue(["meta-b", "meta-c"]);

    const ids = await (service as any).resolveSearchIds("org-1", "ai");

    expect(ids).toEqual(["meta-b", "meta-c", "meta-a"]);
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

describe("ItemsService read model hydration", () => {
  const asLeanResult = <T>(value: T) => ({
    lean: jest.fn().mockResolvedValue(value),
  });

  const buildMetaRow = (
    id: string,
    overrides: Partial<{
      externalId: string;
      name: string;
      status: string;
      mongoRef: string;
      version: number;
      publishedAt: Date | null;
      sortAt: Date;
      createdAt: Date;
      updatedAt: Date;
    }> = {},
  ) => ({
    id,
    orgId: "org-1",
    externalId: overrides.externalId ?? `external-${id}`,
    name: overrides.name ?? `Item ${id}`,
    status: overrides.status ?? ItemStatus.Pending,
    mongoRef: overrides.mongoRef ?? "",
    version: overrides.version ?? 1,
    publishedAt: overrides.publishedAt ?? null,
    sortAt: overrides.sortAt ?? new Date("2024-01-02T00:00:00.000Z"),
    createdAt: overrides.createdAt ?? new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2024-01-03T00:00:00.000Z"),
  });

  const buildRawDoc = (
    id: string,
    itemMetaId: string,
    overrides: Partial<{
      source: string;
      payload: Record<string, unknown>;
      createdAt: Date;
      updatedAt: Date;
    }> = {},
  ) => ({
    id,
    itemMetaId,
    source: overrides.source ?? "manual",
    payload: overrides.payload ?? { url: `https://example.com/${itemMetaId}` },
    createdAt: overrides.createdAt ?? new Date("2024-01-01T01:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2024-01-01T02:00:00.000Z"),
  });

  const buildProcessedDoc = (
    id: string,
    itemMetaId: string,
    overrides: Partial<{
      rawItemId: string | null;
      pipelineJobId: string | null;
      sourceId: string | null;
      status: string;
      tags: string[];
      result: Record<string, unknown> | null;
      createdAt: Date;
      updatedAt: Date;
    }> = {},
  ) => ({
    id,
    itemMetaId,
    rawItemId: overrides.rawItemId ?? `raw-${itemMetaId}`,
    pipelineJobId: overrides.pipelineJobId ?? null,
    sourceId: overrides.sourceId ?? null,
    status: overrides.status ?? "completed",
    tags: overrides.tags ?? [],
    result:
      overrides.result ??
      {
        title: `Processed ${itemMetaId}`,
        summary: `Summary ${itemMetaId}`,
      },
    createdAt: overrides.createdAt ?? new Date("2024-01-02T01:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2024-01-02T02:00:00.000Z"),
  });

  it("hydrates missing read models in batch with shared queries and one bulk write", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([
          buildMetaRow("meta-1", { mongoRef: "507f1f77bcf86cd799439011" }),
          buildMetaRow("meta-2"),
        ]),
      },
      pipelineJob: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      crawlResult: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    mockItemReadModelFind.mockReturnValue(asLeanResult([]));
    mockRawItemFind.mockReturnValue(
      asLeanResult([
        buildRawDoc("raw-1", "meta-1", {
          payload: {
            url: "https://example.com/meta-1",
            metadata: { sourceId: "raw-source-1" },
          },
        }),
      ]),
    );
    mockRawItemAggregate.mockResolvedValue([
      buildRawDoc("raw-2", "meta-2", {
        payload: {
          url: "https://example.com/meta-2",
          metadata: { sourceId: "raw-source-2" },
        },
      }),
    ]);
    mockProcessedItemAggregate.mockResolvedValue([
      buildProcessedDoc("processed-1", "meta-1", {
        sourceId: "processed-source-1",
        result: { title: "Title 1", summary: "Summary 1" },
      }),
      buildProcessedDoc("processed-2", "meta-2", {
        result: { title: "Title 2", summary: "Summary 2" },
      }),
    ]);
    mockItemReadModelBulkWrite.mockResolvedValue({ modifiedCount: 0 });

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any,
    );

    const docsById = await (service as any).loadItemReadModelsByIds("org-1", ["meta-1", "meta-2"]);

    expect(prisma.itemMeta.findMany).toHaveBeenCalledTimes(1);
    expect(mockItemReadModelFind).toHaveBeenCalledTimes(1);
    expect(mockRawItemFind).toHaveBeenCalledTimes(1);
    expect(mockRawItemAggregate).toHaveBeenCalledTimes(1);
    expect(mockProcessedItemAggregate).toHaveBeenCalledTimes(1);
    expect(mockItemReadModelBulkWrite).toHaveBeenCalledTimes(1);
    expect(prisma.pipelineJob.findMany).not.toHaveBeenCalled();
    expect(prisma.crawlResult.findMany).not.toHaveBeenCalled();
    expect(docsById.get("meta-1")).toMatchObject({
      itemMetaId: "meta-1",
      sourceId: "processed-source-1",
      title: "Title 1",
    });
    expect(docsById.get("meta-2")).toMatchObject({
      itemMetaId: "meta-2",
      sourceId: "raw-source-2",
      title: "Title 2",
    });
    expect(mockItemReadModelBulkWrite).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: { orgId: "org-1", itemMetaId: "meta-1" },
            upsert: true,
          }),
        }),
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: { orgId: "org-1", itemMetaId: "meta-2" },
            upsert: true,
          }),
        }),
      ]),
      { ordered: false },
    );
  });

  it("resolves source ids by processed, raw metadata, pipeline job, then crawl result config", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([
          buildMetaRow("meta-processed"),
          buildMetaRow("meta-raw"),
          buildMetaRow("meta-pipeline"),
          buildMetaRow("meta-crawl", { externalId: "crawlResult:crawl-1" }),
        ]),
      },
      pipelineJob: {
        findMany: jest.fn().mockResolvedValue([{ id: "job-1", sourceId: "pipeline-source" }]),
      },
      crawlResult: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "crawl-1",
            task: {
              config: {
                sourceId: "crawl-source",
              },
            },
          },
        ]),
      },
    };

    mockItemReadModelFind.mockReturnValue(asLeanResult([]));
    mockRawItemFind.mockReturnValue(asLeanResult([]));
    mockRawItemAggregate.mockResolvedValue([
      buildRawDoc("raw-processed", "meta-processed", {
        payload: { url: "https://example.com/processed", metadata: {} },
      }),
      buildRawDoc("raw-raw", "meta-raw", {
        payload: {
          url: "https://example.com/raw",
          metadata: { sourceId: "raw-source" },
        },
      }),
      buildRawDoc("raw-pipeline", "meta-pipeline", {
        payload: {
          url: "https://example.com/pipeline",
          metadata: { pipelineJobId: "job-1" },
        },
      }),
      buildRawDoc("raw-crawl", "meta-crawl", {
        payload: { url: "https://example.com/crawl", metadata: {} },
      }),
    ]);
    mockProcessedItemAggregate.mockResolvedValue([
      buildProcessedDoc("processed-processed", "meta-processed", {
        sourceId: "processed-source",
      }),
      buildProcessedDoc("processed-raw", "meta-raw", {
        pipelineJobId: "job-ignored",
      }),
      buildProcessedDoc("processed-pipeline", "meta-pipeline", {
        pipelineJobId: "job-1",
      }),
      buildProcessedDoc("processed-crawl", "meta-crawl"),
    ]);
    mockItemReadModelBulkWrite.mockResolvedValue({ modifiedCount: 0 });

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any,
    );

    const docsById = await (service as any).loadItemReadModelsByIds("org-1", [
      "meta-processed",
      "meta-raw",
      "meta-pipeline",
      "meta-crawl",
    ]);

    expect(docsById.get("meta-processed")?.sourceId).toBe("processed-source");
    expect(docsById.get("meta-raw")?.sourceId).toBe("raw-source");
    expect(docsById.get("meta-pipeline")?.sourceId).toBe("pipeline-source");
    expect(docsById.get("meta-crawl")?.sourceId).toBe("crawl-source");
    expect(prisma.pipelineJob.findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        id: { in: ["job-1"] },
        sourceId: { not: null },
      },
      select: {
        id: true,
        sourceId: true,
      },
    });
    expect(prisma.crawlResult.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["crawl-1"] },
        task: { orgId: "org-1" },
      },
      select: {
        id: true,
        task: {
          select: {
            config: true,
          },
        },
      },
    });
  });

  it("dedupes ids and does not fall back to latest raw when mongoRef is present but missing", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest.fn().mockResolvedValue([
          buildMetaRow("meta-1", { mongoRef: "507f1f77bcf86cd799439099" }),
          buildMetaRow("meta-2"),
        ]),
      },
      pipelineJob: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      crawlResult: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    mockItemReadModelFind.mockReturnValue(asLeanResult([]));
    mockRawItemFind.mockReturnValue(asLeanResult([]));
    mockRawItemAggregate.mockResolvedValue([
      buildRawDoc("raw-2", "meta-2", {
        payload: { url: "https://example.com/meta-2", metadata: {} },
      }),
    ]);
    mockProcessedItemAggregate.mockResolvedValue([]);
    mockItemReadModelBulkWrite.mockResolvedValue({ modifiedCount: 0 });

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any,
    );

    const docsById = await (service as any).loadItemReadModelsByIds("org-1", [
      "meta-1",
      "meta-1",
      "meta-2",
      "meta-missing",
    ]);

    expect(prisma.itemMeta.findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        id: { in: ["meta-1", "meta-2", "meta-missing"] },
      },
      select: {
        id: true,
        orgId: true,
        externalId: true,
        name: true,
        status: true,
        mongoRef: true,
        version: true,
        publishedAt: true,
        sortAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(mockRawItemAggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          $match: {
            itemMetaId: { $in: ["meta-2"] },
          },
        }),
      ]),
    );
    expect(docsById.has("meta-missing")).toBe(false);
    expect(docsById.get("meta-1")).toMatchObject({
      itemMetaId: "meta-1",
      raw: null,
    });
    expect(docsById.get("meta-2")).toMatchObject({
      itemMetaId: "meta-2",
      raw: expect.objectContaining({ itemMetaId: "meta-2" }),
    });
  });

  it("backfills a page through the batch hydration path", async () => {
    const prisma = {
      itemMeta: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: "meta-1" }, { id: "meta-2" }])
          .mockResolvedValueOnce([buildMetaRow("meta-1"), buildMetaRow("meta-2")]),
      },
      pipelineJob: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      crawlResult: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    mockRawItemFind.mockReturnValue(asLeanResult([]));
    mockRawItemAggregate.mockResolvedValue([]);
    mockProcessedItemAggregate.mockResolvedValue([]);
    mockItemReadModelBulkWrite.mockResolvedValue({ modifiedCount: 0 });

    const service = new ItemsService(
      prisma as any,
      {} as any,
      {} as any,
      { liteLlmConfig: {} } as any,
      {} as any,
      {} as any,
    );

    const result = await service.backfillReadModels("org-1", { take: 2 });

    expect(result).toEqual({ processed: 2, nextAfterId: "meta-2" });
    expect(prisma.itemMeta.findMany).toHaveBeenCalledTimes(2);
    expect(mockItemReadModelBulkWrite).toHaveBeenCalledTimes(1);
    expect(mockItemReadModelFindOne).not.toHaveBeenCalled();
  });
});
