jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  };
});

import { PipelineJobStatus } from "@prisma/client";

import { NewsSourceSchedulerService } from "./news-source.scheduler.service";

describe("NewsSourceSchedulerService", () => {
  const createService = () => {
    const prisma = {
      newsSource: {
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      membership: {
        findFirst: jest.fn(),
      },
      article: {
        findMany: jest.fn(),
      },
      pipelineJob: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      crawlTask: {
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    } as any;

    const metadataService = {
      discoverSitemapUrls: jest.fn(),
    } as any;

    const crawlQueue = {
      enqueueTask: jest.fn(),
    } as any;

    const cache = {
      withLock: jest.fn(),
      wrap: jest.fn(async (_key: string, _ttl: number, fn: () => Promise<any>) => fn()),
    } as any;

    const env = {
      newsSourceSchedulerConfig: {
        enabled: true,
        batchSize: 20,
        lockTtlMs: 60_000,
        inFlightLookbackMs: 6 * 60 * 60 * 1000,
        inFlightRescheduleDelayMs: 5 * 60 * 1000,
      },
    } as any;

    const service = new NewsSourceSchedulerService(
      prisma,
      metadataService,
      crawlQueue,
      cache,
      env,
    );

    return { service, prisma, metadataService, crawlQueue, cache, env };
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("schedules up to maxNewUrlsPerRun for sitemap seeds", async () => {
    const { service, prisma, metadataService, crawlQueue } = createService();
    const now = new Date("2026-01-01T00:00:00.000Z");

    (metadataService.discoverSitemapUrls as jest.Mock).mockResolvedValue([
      "https://example.com/news/apple-1",
      "https://example.com/news/apple-2",
      "https://example.com/news/apple-3",
    ]);

    (prisma.newsSource.findMany as jest.Mock).mockResolvedValue([
      {
        id: "source-1",
        orgId: "org-1",
        name: "Example",
        url: "https://example.com",
        siteType: "general",
        language: "en",
        crawlTemplateId: null,
        frequencySeconds: 3600,
        priority: 0,
        nextRunAt: now,
        config: {
          keywords: ["apple"],
          seed: {
            enabled: true,
            maxUrls: 20,
            maxNewUrlsPerRun: 2,
            scoreThreshold: 0,
            dedupeWindowHours: 24,
            cacheTtlSeconds: 600,
          },
        },
        crawlTemplate: null,
      },
    ]);

    (prisma.membership.findFirst as jest.Mock).mockResolvedValue({ userId: "user-actor" });
    (prisma.article.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.pipelineJob.findMany as jest.Mock).mockResolvedValue([]);

    let jobIndex = 0;
    let taskIndex = 0;

    (prisma.$transaction as jest.Mock).mockImplementation(
      async (fn: (tx: any) => Promise<any>) =>
        fn({
          pipelineJob: {
            create: jest.fn(async (args: any) => ({
              id: `job-${++jobIndex}`,
              metadata: args?.data?.metadata ?? null,
            })),
            update: jest.fn(async () => ({})),
          },
          crawlTask: {
            findFirst: jest.fn(async () => null),
            create: jest.fn(async () => ({ id: `task-${++taskIndex}` })),
            update: jest.fn(async (args: any) => ({ id: args?.where?.id ?? `task-${taskIndex}` })),
          },
        }),
    );

    (prisma.newsSource.update as jest.Mock).mockResolvedValue(undefined);
    (prisma.crawlTask.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (crawlQueue.enqueueTask as jest.Mock).mockResolvedValue(undefined);

    await (service as any).scheduleDueSources(now, 10);

    expect(prisma.newsSource.update).toHaveBeenCalledWith({
      where: { id: "source-1" },
      data: {
        lastRunAt: now,
        nextRunAt: new Date(now.getTime() + 3600 * 1000),
      },
    });

    expect(crawlQueue.enqueueTask).toHaveBeenCalledTimes(2);
    expect(crawlQueue.enqueueTask).toHaveBeenNthCalledWith(1, "task-1", "org-1", "user-actor");
    expect(crawlQueue.enqueueTask).toHaveBeenNthCalledWith(2, "task-2", "org-1", "user-actor");
  });

  it("skips recently crawled and in-flight URLs during sitemap seeding", async () => {
    const { service, prisma, metadataService, crawlQueue } = createService();
    const now = new Date("2026-01-01T00:00:00.000Z");

    (metadataService.discoverSitemapUrls as jest.Mock).mockResolvedValue([
      "https://example.com/news/apple-1",
      "https://example.com/news/apple-2",
      "https://example.com/news/apple-3",
    ]);

    (prisma.newsSource.findMany as jest.Mock).mockResolvedValue([
      {
        id: "source-1",
        orgId: "org-1",
        name: "Example",
        url: "https://example.com",
        siteType: "general",
        language: "en",
        crawlTemplateId: null,
        frequencySeconds: 3600,
        priority: 0,
        nextRunAt: now,
        config: {
          keywords: ["apple"],
          seed: {
            enabled: true,
            maxUrls: 20,
            maxNewUrlsPerRun: 10,
            scoreThreshold: 0,
            dedupeWindowHours: 24,
            cacheTtlSeconds: 600,
          },
        },
        crawlTemplate: null,
      },
    ]);

    (prisma.membership.findFirst as jest.Mock).mockResolvedValue({ userId: "user-actor" });
    (prisma.article.findMany as jest.Mock).mockResolvedValue([
      { url: "https://example.com/news/apple-1" },
    ]);
    (prisma.pipelineJob.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ url: "https://example.com/news/apple-2" }]);

    let jobIndex = 0;
    let taskIndex = 0;

    (prisma.$transaction as jest.Mock).mockImplementation(
      async (fn: (tx: any) => Promise<any>) =>
        fn({
          pipelineJob: {
            create: jest.fn(async () => ({ id: `job-${++jobIndex}`, metadata: null })),
            update: jest.fn(async () => ({})),
          },
          crawlTask: {
            findFirst: jest.fn(async () => null),
            create: jest.fn(async () => ({ id: `task-${++taskIndex}` })),
            update: jest.fn(async (args: any) => ({ id: args?.where?.id ?? `task-${taskIndex}` })),
          },
        }),
    );

    (prisma.newsSource.update as jest.Mock).mockResolvedValue(undefined);
    (prisma.crawlTask.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (crawlQueue.enqueueTask as jest.Mock).mockResolvedValue(undefined);

    await (service as any).scheduleDueSources(now, 10);

    expect(crawlQueue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(crawlQueue.enqueueTask).toHaveBeenCalledWith("task-1", "org-1", "user-actor");
  });

  it("reschedules when a seed source is at in-flight capacity", async () => {
    const { service, prisma, metadataService, crawlQueue, env } = createService();
    const now = new Date("2026-01-01T00:00:00.000Z");

    (metadataService.discoverSitemapUrls as jest.Mock).mockResolvedValue([
      "https://example.com/news/apple-1",
    ]);

    (prisma.newsSource.findMany as jest.Mock).mockResolvedValue([
      {
        id: "source-1",
        orgId: "org-1",
        name: "Example",
        url: "https://example.com",
        siteType: "general",
        language: "en",
        crawlTemplateId: null,
        frequencySeconds: 3600,
        priority: 0,
        nextRunAt: now,
        config: {
          keywords: ["apple"],
          seed: {
            enabled: true,
            maxUrls: 20,
            maxNewUrlsPerRun: 2,
            scoreThreshold: 0,
            dedupeWindowHours: 24,
            cacheTtlSeconds: 600,
          },
        },
        crawlTemplate: null,
      },
    ]);

    (prisma.pipelineJob.findMany as jest.Mock).mockResolvedValue([
      { id: "job-active-1", status: PipelineJobStatus.running, createdAt: now },
      {
        id: "job-active-2",
        status: PipelineJobStatus.queued,
        createdAt: new Date(now.getTime() - 1000),
      },
    ]);

    await (service as any).scheduleDueSources(now, 10);

    expect(prisma.newsSource.updateMany).toHaveBeenCalledWith({
      where: {
        id: "source-1",
        OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
      },
      data: {
        nextRunAt: new Date(now.getTime() + env.newsSourceSchedulerConfig.inFlightRescheduleDelayMs),
      },
    });
    expect(crawlQueue.enqueueTask).not.toHaveBeenCalled();
    expect(prisma.newsSource.update).not.toHaveBeenCalled();
  });
});
