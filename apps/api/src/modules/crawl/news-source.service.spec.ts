import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { NewsSourceService } from "./news-source.service";

describe("NewsSourceService.createSource", () => {
  it("throws ConflictException when URL already exists", async () => {
    const prisma = {
      newsSource: {
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "0",
            meta: { target: ["NewsSource_orgId_url_key"] },
          }),
        ),
      },
    } as any;
    const metadataService = {} as any;
    const workflows = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    await expect(
      service.createSource("org-1", {
        name: "Politico",
        url: "https://www.politico.eu/latest/",
        siteType: "general" as any,
        crawlTemplateId: null,
        config: null,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects crawlOptions containing crawl4ai LLM extraction config", async () => {
    const prisma = {
      newsSource: {
        create: jest.fn(),
      },
    } as any;
    const metadataService = {} as any;
    const workflows = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    await expect(
      service.createSource("org-1", {
        name: "Bad Source",
        url: "https://example.com",
        siteType: "general" as any,
        frequencySeconds: 3600,
        priority: 0,
        crawlTemplateId: null,
        config: {
          crawlOptions: {
            extraction_strategy: { type: "llm" },
          },
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.newsSource.create).not.toHaveBeenCalled();
  });

  it("strips legacy rss cache ttl override of 600 seconds on create", async () => {
    const prisma = {
      newsSource: {
        create: jest.fn().mockResolvedValue({ id: "source-1" }),
      },
    } as any;
    const metadataService = {} as any;
    const workflows = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    await service.createSource("org-1", {
      name: "RSS Source",
      url: "https://example.com",
      siteType: "general" as any,
      frequencySeconds: 3600,
      priority: 0,
      crawlTemplateId: null,
      config: {
        seed: {
          enabled: true,
          mode: "rss",
          feedUrl: "https://example.com/rss.xml",
          cacheTtlSeconds: 600,
        },
      },
    });

    const createArgs = (prisma.newsSource.create as jest.Mock).mock
      .calls[0]?.[0];
    const savedConfig = createArgs?.data?.config as Record<string, unknown>;
    expect((savedConfig.seed as Record<string, unknown>).mode).toBe("rss");
    expect(
      (savedConfig.seed as Record<string, unknown>).cacheTtlSeconds,
    ).toBeUndefined();
  });

  it("keeps cache ttl override for non-rss seed mode", async () => {
    const prisma = {
      newsSource: {
        create: jest.fn().mockResolvedValue({ id: "source-1" }),
      },
    } as any;
    const metadataService = {} as any;
    const workflows = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    await service.createSource("org-1", {
      name: "List Source",
      url: "https://example.com/list",
      siteType: "general" as any,
      frequencySeconds: 3600,
      priority: 0,
      crawlTemplateId: null,
      config: {
        seed: {
          enabled: true,
          mode: "list",
          cacheTtlSeconds: 600,
        },
      },
    });

    const createArgs = (prisma.newsSource.create as jest.Mock).mock
      .calls[0]?.[0];
    const savedConfig = createArgs?.data?.config as Record<string, unknown>;
    expect((savedConfig.seed as Record<string, unknown>).mode).toBe("list");
    expect((savedConfig.seed as Record<string, unknown>).cacheTtlSeconds).toBe(
      600,
    );
  });
});

describe("NewsSourceService.updateSource", () => {
  it("throws ConflictException when name already exists", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue({
          id: "source-1",
          orgId: "org-1",
          isActive: true,
        }),
        update: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "0",
            meta: { target: ["orgId", "name"] },
          }),
        ),
      },
    } as any;
    const metadataService = {} as any;
    const workflows = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    await expect(
      service.updateSource("org-1", "source-1", { name: "Duplicate" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("strips legacy rss cache ttl override of 600 seconds on update", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue({
          id: "source-1",
          orgId: "org-1",
          isActive: true,
          frequencySeconds: 3600,
        }),
        update: jest.fn().mockResolvedValue({ id: "source-1" }),
      },
    } as any;
    const metadataService = {} as any;
    const workflows = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    await service.updateSource("org-1", "source-1", {
      config: {
        seed: {
          enabled: true,
          mode: "rss",
          feedUrl: "https://example.com/rss.xml",
          cacheTtlSeconds: "600",
        },
      },
    });

    const updateArgs = (prisma.newsSource.update as jest.Mock).mock
      .calls[0]?.[0];
    const savedConfig = updateArgs?.data?.config as Record<string, unknown>;
    expect((savedConfig.seed as Record<string, unknown>).mode).toBe("rss");
    expect(
      (savedConfig.seed as Record<string, unknown>).cacheTtlSeconds,
    ).toBeUndefined();
  });
});

describe("NewsSourceService seed normalization", () => {
  it("accepts deep mode and forces deep.ignoreRobotsTxt=true", () => {
    const prisma = {} as any;
    const metadataService = {} as any;
    const workflows = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    const seedConfig = (service as any).normalizeSeedConfig(
      {
        seed: {
          enabled: true,
          mode: "deep",
          pattern: "https://example.com/article/*",
          deep: {
            maxPages: 120,
            maxDepth: 3,
            timeBudgetSeconds: 75,
            pageConcurrency: 3,
            scoreThreshold: 0.4,
            candidatePoolSize: 160,
            headFetchTopK: 50,
            preferPathDate: false,
            enableSecondaryHubs: false,
            ignoreRobotsTxt: false,
          },
        },
      },
      "https://example.com/latest/",
    );

    expect(seedConfig).toEqual(
      expect.objectContaining({
        enabled: true,
        mode: "deep",
        domain: "https://example.com",
        pattern: "https://example.com/article/*",
        deep: expect.objectContaining({
          maxPages: 120,
          maxDepth: 3,
          timeBudgetSeconds: 75,
          pageConcurrency: 3,
          scoreThreshold: 0.4,
          candidatePoolSize: 160,
          headFetchTopK: 50,
          preferPathDate: false,
          enableSecondaryHubs: false,
          ignoreRobotsTxt: true,
        }),
      }),
    );
  });
});

describe("NewsSourceService.preview", () => {
  it("returns deep preview error details and deep failure stats panel payload", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue({
          id: "source-1",
          orgId: "org-1",
          name: "Example",
          url: "https://example.com/latest/",
          siteType: "general",
          crawlTemplateId: null,
          config: {
            seed: {
              enabled: true,
              mode: "deep",
              maxUrls: 20,
              maxNewUrlsPerRun: 5,
              dedupeWindowHours: 24,
              deep: {
                maxPages: 80,
                maxDepth: 2,
                timeBudgetSeconds: 60,
                pageConcurrency: 2,
                scoreThreshold: 0.2,
                candidatePoolSize: 120,
                headFetchTopK: 40,
                preferPathDate: true,
                enableSecondaryHubs: true,
                ignoreRobotsTxt: true,
              },
            },
          },
        }),
      },
      crawlTemplate: {
        findUnique: jest.fn(),
      },
      pipelineJob: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      article: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;

    const metadataService = {
      discoverDeepCandidates: jest
        .fn()
        .mockRejectedValue(
          new Error(
            "[SEED_DEEP_CRAWL_FAILED] Deep discovery crawl failed: timeout",
          ),
        ),
      extract: jest.fn(),
    } as any;

    const env = {
      newsSourceSchedulerConfig: {
        inFlightLookbackMs: 6 * 60 * 60 * 1000,
      },
    } as any;

    const cache = {
      get: jest
        .fn()
        .mockResolvedValueOnce({
          streak: 2,
          lastFailureAt: "2026-01-01T00:00:00.000Z",
          lastCode: "SEED_DEEP_CRAWL_FAILED",
          lastMessage: "Deep discovery crawl failed: timeout",
          retryAt: "2026-01-01T00:15:00.000Z",
          nextRunAt: "2026-01-01T00:15:00.000Z",
          circuitOpenUntil: null,
        })
        .mockResolvedValueOnce({
          total: 4,
          byCode: {
            SEED_DEEP_CRAWL_FAILED: 3,
            SEED_DEEP_EMPTY_RESULT: 1,
          },
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
    } as any;

    const workflows = {
      compileNewsSourceOverlay: jest.fn().mockResolvedValue(null),
    } as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );
    const result = await service.preview("org-1", "source-1");

    expect(result.deepPreviewError).toEqual(
      expect.objectContaining({
        code: "SEED_DEEP_CRAWL_FAILED",
      }),
    );
    expect(result.deepFailureStats).toEqual(
      expect.objectContaining({
        total24h: 4,
        streak: 2,
        byCode: expect.arrayContaining([
          { code: "SEED_DEEP_CRAWL_FAILED", count: 3 },
          { code: "SEED_DEEP_EMPTY_RESULT", count: 1 },
        ]),
      }),
    );
    expect(result.scheduleCount).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("returns preview time signals with published-first and crawled fallback", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue({
          id: "source-1",
          orgId: "org-1",
          name: "Example",
          url: "https://example.com/latest/",
          siteType: "general",
          crawlTemplateId: null,
          config: {
            seed: {
              enabled: true,
              mode: "list",
              maxUrls: 20,
              maxNewUrlsPerRun: 5,
              dedupeWindowHours: 24,
            },
          },
        }),
      },
      crawlTemplate: {
        findUnique: jest.fn(),
      },
      pipelineJob: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      article: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;

    const metadataService = {
      discoverListCandidates: jest.fn().mockResolvedValue([
        {
          url: "https://example.com/news/with-published",
          publishedAtTs: Date.parse("2026-02-14T10:00:00.000Z"),
          crawledAtTs: Date.parse("2026-02-14T10:05:00.000Z"),
        },
        {
          url: "https://example.com/news/no-published",
          crawledAtTs: Date.parse("2026-02-14T10:06:00.000Z"),
        },
      ]),
      extract: jest.fn().mockResolvedValue([
        {
          url: "https://example.com/news/with-published",
          status: "success",
          title: "One",
        },
        {
          url: "https://example.com/news/no-published",
          status: "success",
          title: "Two",
        },
      ]),
    } as any;

    const env = {
      newsSourceSchedulerConfig: {
        inFlightLookbackMs: 6 * 60 * 60 * 1000,
      },
    } as any;

    const cache = {
      get: jest.fn().mockResolvedValue(null),
    } as any;

    const workflows = {
      compileNewsSourceOverlay: jest.fn().mockResolvedValue(null),
    } as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );
    const result = await service.preview("org-1", "source-1");

    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://example.com/news/with-published",
          timestampSource: "published",
          publishDateMissing: false,
          effectiveAt: "2026-02-14T10:00:00.000Z",
          publishedAt: "2026-02-14T10:00:00.000Z",
        }),
        expect.objectContaining({
          url: "https://example.com/news/no-published",
          timestampSource: "crawled",
          publishDateMissing: true,
          effectiveAt: "2026-02-14T10:06:00.000Z",
          crawledAt: "2026-02-14T10:06:00.000Z",
        }),
      ]),
    );
  });

  it("passes rssFetch settings through preview for RSS sources", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue({
          id: "source-rss-1",
          orgId: "org-1",
          name: "RSS Source",
          url: "https://example.com",
          siteType: "general",
          crawlTemplateId: "template-1",
          config: {
            crawlOptions: {
              userAgent: "UA",
            },
            seed: {
              enabled: true,
              mode: "rss",
              feedUrl: "https://example.com/feed.xml",
              maxUrls: 10,
              maxNewUrlsPerRun: 5,
              dedupeWindowHours: 24,
              rssFetch: {
                enabled: true,
                requestTimeoutMs: 20000,
                bodySourceStrategy: "summary_only",
                noBodyPolicy: "title_description_stub",
              },
            },
          },
        }),
      },
      crawlTemplate: {
        findUnique: jest.fn().mockResolvedValue({
          isActive: true,
          crawlOptions: {
            headless: true,
          },
        }),
      },
      pipelineJob: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      article: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;

    const metadataService = {
      discoverRssCandidates: jest.fn().mockResolvedValue([
        {
          url: "https://example.com/rss/story-1",
          publishedAtTs: Date.parse("2026-02-14T10:00:00.000Z"),
          prefetchedArticle: {
            title: "Story 1",
            markdown: "Summary only",
          },
        },
      ]),
      extract: jest.fn().mockResolvedValue([
        {
          url: "https://example.com/rss/story-1",
          status: "success",
          title: "Story 1",
        },
      ]),
    } as any;

    const env = {
      newsSourceSchedulerConfig: {
        inFlightLookbackMs: 6 * 60 * 60 * 1000,
      },
    } as any;

    const cache = {
      get: jest.fn().mockResolvedValue(null),
    } as any;

    const workflows = {
      compileNewsSourceOverlay: jest.fn().mockResolvedValue(null),
    } as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );
    const result = await service.preview("org-1", "source-rss-1");

    expect(metadataService.discoverRssCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        feedUrl: "https://example.com/feed.xml",
        maxUrls: 10,
        rssFetch: expect.objectContaining({
          enabled: true,
          requestTimeoutMs: 20000,
          bodySourceStrategy: "summary_only",
          noBodyPolicy: "title_description_stub",
        }),
      }),
    );
    expect(result.mode).toBe("rss");
    expect(result.seed).toEqual(
      expect.objectContaining({
        mode: "rss",
        feedUrl: "https://example.com/feed.xml",
        rssFetch: expect.objectContaining({
          enabled: true,
          requestTimeoutMs: 20000,
          bodySourceStrategy: "summary_only",
          noBodyPolicy: "title_description_stub",
        }),
      }),
    );
  });
});

describe("NewsSourceService.updateFrequencyForAll", () => {
  it("updates all frequencies and reschedules active sources", async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 5 })
      .mockResolvedValueOnce({ count: 3 });
    const prisma = {
      newsSource: {
        updateMany,
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (operations: Promise<unknown>[]) =>
          Promise.all(operations),
        ),
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const workflows = {
      compileNewsSourceOverlay: jest.fn().mockResolvedValue(null),
    } as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    const result = await service.updateFrequencyForAll("org-1", 3600);

    expect(prisma.newsSource.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.newsSource.updateMany).toHaveBeenNthCalledWith(1, {
      where: { orgId: "org-1" },
      data: { frequencySeconds: 3600 },
    });
    expect(prisma.newsSource.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { orgId: "org-1", isActive: true },
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        orgId: "org-1",
        frequencySeconds: 3600,
        updatedCount: 5,
        activeRescheduledCount: 3,
      }),
    );
  });
});

describe("NewsSourceService.schedule", () => {
  it("throws when source is missing", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const workflows = {
      compileNewsSourceOverlay: jest.fn().mockResolvedValue(null),
    } as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    await expect(
      service.schedule("org-1", "source-1", {
        nextRunAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws when source belongs to another org", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "source-1", orgId: "org-2" }),
        update: jest.fn(),
      },
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const workflows = {
      compileNewsSourceOverlay: jest.fn().mockResolvedValue(null),
    } as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    await expect(
      service.schedule("org-1", "source-1", {
        nextRunAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws when nextRunAt is invalid", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "source-1", orgId: "org-1" }),
        update: jest.fn(),
      },
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const workflows = {
      compileNewsSourceOverlay: jest.fn().mockResolvedValue(null),
    } as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    await expect(
      service.schedule("org-1", "source-1", { nextRunAt: "not-a-date" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.newsSource.update).not.toHaveBeenCalled();
  });

  it("updates nextRunAt and clears circuit open", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "source-1", orgId: "org-1" }),
        update: jest.fn().mockResolvedValue({ id: "source-1" }),
      },
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const workflows = {
      compileNewsSourceOverlay: jest.fn().mockResolvedValue(null),
    } as any;
    const service = new NewsSourceService(
      prisma,
      metadataService,
      workflows,
      env,
      cache,
    );

    const nextRunAt = "2026-01-31T12:34:56.000Z";
    await service.schedule("org-1", "source-1", { nextRunAt });

    expect(prisma.newsSource.update).toHaveBeenCalledTimes(1);
    const [call] = prisma.newsSource.update.mock.calls[0];
    expect(call.where).toEqual({ id: "source-1" });
    expect(call.data).toMatchObject({ isActive: true, circuitOpenUntil: null });
    expect(call.data.nextRunAt).toBeInstanceOf(Date);
    expect(call.data.nextRunAt.toISOString()).toBe(nextRunAt);
  });
});
