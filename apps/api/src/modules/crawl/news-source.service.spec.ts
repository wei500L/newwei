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
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

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
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

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
});

describe("NewsSourceService.updateSource", () => {
  it("throws ConflictException when name already exists", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
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
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

    await expect(
      service.updateSource("org-1", "source-1", { name: "Duplicate" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("NewsSourceService seed normalization", () => {
  it("accepts deep mode and forces deep.ignoreRobotsTxt=true", () => {
    const prisma = {} as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

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
      discoverDeepUrls: jest
        .fn()
        .mockRejectedValue(
          new Error(
            "[SEED_DEEP_NO_PUBLISHED_AT] Deep discovery could not determine publish time for discovered links. discovered=3, unresolved=3",
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
          lastCode: "SEED_DEEP_NO_PUBLISHED_AT",
          lastMessage:
            "Deep discovery could not determine publish time for discovered links.",
          retryAt: "2026-01-01T00:15:00.000Z",
          nextRunAt: "2026-01-01T00:15:00.000Z",
          circuitOpenUntil: null,
        })
        .mockResolvedValueOnce({
          total: 4,
          byCode: {
            SEED_DEEP_NO_PUBLISHED_AT: 3,
            SEED_DEEP_EMPTY_RESULT: 1,
          },
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
    } as any;

    const service = new NewsSourceService(prisma, metadataService, env, cache);
    const result = await service.preview("org-1", "source-1");

    expect(result.deepPreviewError).toEqual(
      expect.objectContaining({
        code: "SEED_DEEP_NO_PUBLISHED_AT",
      }),
    );
    expect(result.deepFailureStats).toEqual(
      expect.objectContaining({
        total24h: 4,
        streak: 2,
        byCode: expect.arrayContaining([
          { code: "SEED_DEEP_NO_PUBLISHED_AT", count: 3 },
          { code: "SEED_DEEP_EMPTY_RESULT", count: 1 },
        ]),
      }),
    );
    expect(result.scheduleCount).toBe(0);
    expect(result.candidates).toEqual([]);
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
        .mockImplementation(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

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
    const service = new NewsSourceService(prisma, metadataService, env, cache);

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
    const service = new NewsSourceService(prisma, metadataService, env, cache);

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
    const service = new NewsSourceService(prisma, metadataService, env, cache);

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
    const service = new NewsSourceService(prisma, metadataService, env, cache);

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
