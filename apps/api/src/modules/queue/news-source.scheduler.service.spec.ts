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

jest.mock("@modular/mongo", () => ({
  RawItemModel: {
    create: jest.fn(),
  },
}));

import { RawItemModel } from "@modular/mongo";
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
      article: {
        findMany: jest.fn(),
      },
      pipelineJob: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      itemMeta: {
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    } as any;

    const metadataService = {
      discoverSitemapUrls: jest.fn(),
    } as any;

    const queueService = {
      enqueueItem: jest.fn(),
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
      queueService,
      cache,
      env,
    );

    return { service, prisma, metadataService, queueService, cache, env };
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("schedules up to maxNewUrlsPerRun for sitemap seeds", async () => {
    const { service, prisma, metadataService, queueService } = createService();
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

    (prisma.article.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.pipelineJob.findMany as jest.Mock).mockResolvedValue([]);

    let jobIndex = 0;
    let metaIndex = 0;
    let rawIndex = 0;

    (RawItemModel.create as jest.Mock).mockImplementation(async () => ({
      id: `raw-${++rawIndex}`,
    }));

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
          itemMeta: {
            create: jest.fn(async () => ({ id: `meta-${++metaIndex}` })),
            update: jest.fn(async () => ({})),
          },
        }),
    );

    (prisma.newsSource.update as jest.Mock).mockResolvedValue(undefined);
    (queueService.enqueueItem as jest.Mock).mockResolvedValue(undefined);

    await (service as any).scheduleDueSources(now, 10);

    expect(prisma.newsSource.update).toHaveBeenCalledWith({
      where: { id: "source-1" },
      data: {
        lastRunAt: now,
        nextRunAt: new Date(now.getTime() + 3600 * 1000),
      },
    });

    expect(queueService.enqueueItem).toHaveBeenCalledTimes(2);
    expect(queueService.enqueueItem).toHaveBeenNthCalledWith(
      1,
      "org-1",
      "meta-1",
      "raw-1",
      { priority: 101 },
      { pipelineJobId: "job-1", sourceId: "source-1" },
    );
    expect(queueService.enqueueItem).toHaveBeenNthCalledWith(
      2,
      "org-1",
      "meta-2",
      "raw-2",
      { priority: 101 },
      { pipelineJobId: "job-2", sourceId: "source-1" },
    );
  });

  it("skips recently crawled and in-flight URLs during sitemap seeding", async () => {
    const { service, prisma, metadataService, queueService } = createService();
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

    (prisma.article.findMany as jest.Mock).mockResolvedValue([
      { url: "https://example.com/news/apple-1" },
    ]);
    (prisma.pipelineJob.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ url: "https://example.com/news/apple-2" }]);

    let jobIndex = 0;
    let metaIndex = 0;
    let rawIndex = 0;

    (RawItemModel.create as jest.Mock).mockImplementation(async () => ({
      id: `raw-${++rawIndex}`,
    }));

    (prisma.$transaction as jest.Mock).mockImplementation(
      async (fn: (tx: any) => Promise<any>) =>
        fn({
          pipelineJob: {
            create: jest.fn(async () => ({ id: `job-${++jobIndex}`, metadata: null })),
            update: jest.fn(async () => ({})),
          },
          itemMeta: {
            create: jest.fn(async () => ({ id: `meta-${++metaIndex}` })),
            update: jest.fn(async () => ({})),
          },
        }),
    );

    (prisma.newsSource.update as jest.Mock).mockResolvedValue(undefined);
    (queueService.enqueueItem as jest.Mock).mockResolvedValue(undefined);

    await (service as any).scheduleDueSources(now, 10);

    expect(queueService.enqueueItem).toHaveBeenCalledTimes(1);
    expect(queueService.enqueueItem).toHaveBeenCalledWith(
      "org-1",
      "meta-1",
      "raw-1",
      { priority: 101 },
      { pipelineJobId: "job-1", sourceId: "source-1" },
    );
  });

  it("reschedules when a seed source is at in-flight capacity", async () => {
    const { service, prisma, metadataService, queueService, env } = createService();
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
    expect(queueService.enqueueItem).not.toHaveBeenCalled();
    expect(prisma.newsSource.update).not.toHaveBeenCalled();
  });
});
