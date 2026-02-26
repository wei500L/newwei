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
      discoverDeepUrls: jest.fn(),
    } as any;

    const crawlQueue = {
      enqueueTask: jest.fn(),
    } as any;

    const cache = {
      withLock: jest.fn(),
      wrap: jest.fn(
        async (_key: string, _ttl: number, fn: () => Promise<any>) => fn(),
      ),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      setIfAbsent: jest.fn().mockResolvedValue(true),
      incr: jest.fn().mockResolvedValue(1),
    } as any;

    const env = {
      newsSourceSchedulerConfig: {
        enabled: true,
        batchSize: 20,
        lockTtlMs: 60_000,
        inFlightLookbackMs: 6 * 60 * 60 * 1000,
        inFlightRescheduleDelayMs: 5 * 60 * 1000,
        maxEnqueuePerTick: 100,
        backpressureMaxPendingJobs: 0,
        backpressureDelayMs: 5 * 60 * 1000,
        failureRecoveryDelayMs: 10 * 60 * 1000,
        failureMaxDelayMs: 6 * 60 * 60 * 1000,
        circuitBreakerThreshold: 3,
        circuitBreakerBaseDelayMs: 60 * 60 * 1000,
        circuitBreakerMaxDelayMs: 24 * 60 * 60 * 1000,
        autoDisableThreshold: 0,
      },
    } as any;

    const crawlTaskService = {} as any;
    const notifications = { notify: jest.fn() } as any;
    const schedulerSettings = {
      getSettings: jest.fn().mockResolvedValue({
        source: "default",
        seedFreshnessWindowDays: 365,
        seedCacheTtlSecondsSitemapRss: 60,
        seedCacheTtlSecondsListDeep: 180,
        seedCacheTtlForceGlobal: false,
      }),
    } as any;

    const service = new NewsSourceSchedulerService(
      prisma,
      metadataService,
      crawlQueue,
      cache,
      env,
      crawlTaskService,
      notifications,
      schedulerSettings,
    );

    return {
      service,
      prisma,
      metadataService,
      crawlQueue,
      cache,
      env,
      crawlTaskService,
      notifications,
      schedulerSettings,
    };
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

    (prisma.membership.findFirst as jest.Mock).mockResolvedValue({
      userId: "user-actor",
    });
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
            update: jest.fn(async (args: any) => ({
              id: args?.where?.id ?? `task-${taskIndex}`,
            })),
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
    expect(crawlQueue.enqueueTask).toHaveBeenNthCalledWith(
      1,
      "task-1",
      "org-1",
      "user-actor",
      {
        priorityClass: "normal",
        sourcePriority: 0,
      },
    );
    expect(crawlQueue.enqueueTask).toHaveBeenNthCalledWith(
      2,
      "task-2",
      "org-1",
      "user-actor",
      {
        priorityClass: "normal",
        sourcePriority: 0,
      },
    );
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

    (prisma.membership.findFirst as jest.Mock).mockResolvedValue({
      userId: "user-actor",
    });
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
            create: jest.fn(async () => ({
              id: `job-${++jobIndex}`,
              metadata: null,
            })),
            update: jest.fn(async () => ({})),
          },
          crawlTask: {
            findFirst: jest.fn(async () => null),
            create: jest.fn(async () => ({ id: `task-${++taskIndex}` })),
            update: jest.fn(async (args: any) => ({
              id: args?.where?.id ?? `task-${taskIndex}`,
            })),
          },
        }),
    );

    (prisma.newsSource.update as jest.Mock).mockResolvedValue(undefined);
    (prisma.crawlTask.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (crawlQueue.enqueueTask as jest.Mock).mockResolvedValue(undefined);

    await (service as any).scheduleDueSources(now, 10);

    expect(crawlQueue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(crawlQueue.enqueueTask).toHaveBeenCalledWith(
      "task-1",
      "org-1",
      "user-actor",
      {
        priorityClass: "normal",
        sourcePriority: 0,
      },
    );
  });

  it("filters stale path-dated URLs and prioritizes fresh articles", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-02-15T00:00:00.000Z"));
    try {
      const { service, prisma, metadataService, crawlQueue } = createService();
      const now = new Date("2026-02-15T00:00:00.000Z");

      (metadataService.discoverSitemapUrls as jest.Mock).mockResolvedValue([
        "https://example.com/news/2023/01/02/old-story",
        "https://example.com/news/2026/02/14/new-story",
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
            keywords: ["economy"],
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

      (prisma.membership.findFirst as jest.Mock).mockResolvedValue({
        userId: "user-actor",
      });
      (prisma.article.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.pipelineJob.findMany as jest.Mock).mockResolvedValue([]);

      let jobIndex = 0;
      let taskIndex = 0;

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (fn: (tx: any) => Promise<any>) =>
          fn({
            pipelineJob: {
              create: jest.fn(async () => ({
                id: `job-${++jobIndex}`,
                metadata: null,
              })),
              update: jest.fn(async () => ({})),
            },
            crawlTask: {
              findFirst: jest.fn(async () => null),
              create: jest.fn(async () => ({ id: `task-${++taskIndex}` })),
              update: jest.fn(async (args: any) => ({
                id: args?.where?.id ?? `task-${taskIndex}`,
              })),
            },
          }),
      );

      (prisma.newsSource.update as jest.Mock).mockResolvedValue(undefined);
      (prisma.crawlTask.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (crawlQueue.enqueueTask as jest.Mock).mockResolvedValue(undefined);

      await (service as any).scheduleDueSources(now, 10);

      expect(crawlQueue.enqueueTask).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const txCallArg = (prisma.$transaction as jest.Mock).mock.calls[0]?.[0];
      expect(typeof txCallArg).toBe("function");
    } finally {
      jest.useRealTimers();
    }
  });

  it("uses MySQL-backed scheduler freshness window settings for seed filtering", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-02-15T00:00:00.000Z"));
    try {
      const {
        service,
        prisma,
        metadataService,
        crawlQueue,
        schedulerSettings,
      } =
        createService();
      const now = new Date("2026-02-15T00:00:00.000Z");
      schedulerSettings.getSettings = jest
        .fn()
        .mockResolvedValue({
          source: "db",
          seedFreshnessWindowDays: 30,
          seedCacheTtlSecondsSitemapRss: 60,
          seedCacheTtlSecondsListDeep: 180,
          seedCacheTtlForceGlobal: false,
        });

      (metadataService.discoverSitemapUrls as jest.Mock).mockResolvedValue([
        "https://example.com/news/2025/12/01/stale-under-30-day-window",
        "https://example.com/news/2026/02/14/fresh-under-30-day-window",
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
            keywords: ["economy"],
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

      (prisma.membership.findFirst as jest.Mock).mockResolvedValue({
        userId: "user-actor",
      });
      (prisma.article.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.pipelineJob.findMany as jest.Mock).mockResolvedValue([]);

      let taskIndex = 0;
      (prisma.$transaction as jest.Mock).mockImplementation(
        async (fn: (tx: any) => Promise<any>) =>
          fn({
            pipelineJob: {
              create: jest.fn(async () => ({
                id: "job-1",
                metadata: null,
              })),
              update: jest.fn(async () => ({})),
            },
            crawlTask: {
              findFirst: jest.fn(async () => null),
              create: jest.fn(async () => ({ id: `task-${++taskIndex}` })),
              update: jest.fn(async (args: any) => ({
                id: args?.where?.id ?? `task-${taskIndex}`,
              })),
            },
          }),
      );

      (prisma.newsSource.update as jest.Mock).mockResolvedValue(undefined);
      (prisma.crawlTask.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (crawlQueue.enqueueTask as jest.Mock).mockResolvedValue(undefined);

      await (service as any).scheduleDueSources(now, 10);

      expect(schedulerSettings.getSettings).toHaveBeenCalledTimes(1);
      expect(crawlQueue.enqueueTask).toHaveBeenCalledTimes(1);
      expect(crawlQueue.enqueueTask).toHaveBeenCalledWith(
        "task-1",
        "org-1",
        "user-actor",
        {
          priorityClass: "normal",
          sourcePriority: 0,
        },
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("reschedules when a seed source is at in-flight capacity", async () => {
    const { service, prisma, metadataService, crawlQueue, env } =
      createService();
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
        nextRunAt: new Date(
          now.getTime() +
            env.newsSourceSchedulerConfig.inFlightRescheduleDelayMs,
        ),
      },
    });
    expect(crawlQueue.enqueueTask).not.toHaveBeenCalled();
    expect(prisma.newsSource.update).not.toHaveBeenCalled();
  });

  it("fails scheduling when scheduler freshness settings cannot be loaded", async () => {
    const { service, prisma, schedulerSettings } = createService();
    const now = new Date("2026-01-01T00:00:00.000Z");

    schedulerSettings.getSettings = jest
      .fn()
      .mockRejectedValue(new Error("settings unavailable"));
    (prisma.newsSource.findMany as jest.Mock).mockResolvedValue([]);

    await expect((service as any).scheduleDueSources(now, 10)).rejects.toThrow(
      "settings unavailable",
    );
  });

  it("injects hardened anti-bot defaults for list crawl options", () => {
    const { service } = createService();

    const options = (service as any).withAutoCrawlQualityDefaults(
      undefined,
      "list",
    ) as Record<string, unknown>;

    expect(options).toEqual(
      expect.objectContaining({
        headless: false,
        enableUndetectedBrowser: true,
        enableStealthMode: true,
        simulateUser: true,
        overrideNavigator: true,
        userAgentMode: "random",
        waitUntil: "networkidle",
        waitForTimeoutMs: 12_000,
        delayBeforeReturnHtmlMs: 2_000,
        meanDelayMs: 900,
        maxDelayRangeMs: 1_600,
        extractLinks: true,
        prefetch: true,
        scanFullPage: false,
      }),
    );
    expect(options.virtualScroll).toEqual(
      expect.objectContaining({
        containerSelector: "body",
        scrollCount: 8,
        scrollBy: "page_height",
        waitAfterScrollMs: 700,
      }),
    );
    expect(options.cleanMarkdown).toEqual(
      expect.objectContaining({
        removeOverlayElements: true,
        wordCountThreshold: 20,
      }),
    );
    expect(
      (options.cleanMarkdown as Record<string, unknown>).excludedTags,
    ).toEqual(expect.arrayContaining(["nav", "footer", "script", "style"]));
  });

  it("normalizes list seed pagination settings and expanded caps", () => {
    const { service } = createService();

    const seedConfig = (service as any).normalizeSeedConfig({
      url: "https://example.com/latest/",
      config: {
        seed: {
          enabled: true,
          mode: "list",
          maxUrls: 5000,
          maxNewUrlsPerRun: 900,
          listMaxPages: 99,
          listPageConcurrency: 99,
          followPagination: false,
        },
      },
    });

    expect(seedConfig).toEqual(
      expect.objectContaining({
        mode: "list",
        maxUrls: 2000,
        maxNewUrlsPerRun: 500,
        listMaxPages: 20,
        listPageConcurrency: 5,
        followPagination: false,
      }),
    );
  });

  it("uses mode-aware default seed cache ttl when cacheTtlSeconds is not configured", () => {
    const { service } = createService();

    const sitemapSeed = (service as any).normalizeSeedConfig({
      url: "https://example.com",
      config: { seed: { enabled: true, mode: "sitemap" } },
    });
    const rssSeed = (service as any).normalizeSeedConfig({
      url: "https://example.com",
      config: { seed: { enabled: true, mode: "rss" } },
    });
    const listSeed = (service as any).normalizeSeedConfig({
      url: "https://example.com/latest",
      config: { seed: { enabled: true, mode: "list" } },
    });
    const deepSeed = (service as any).normalizeSeedConfig({
      url: "https://example.com/latest",
      config: { seed: { enabled: true, mode: "deep" } },
    });

    expect(sitemapSeed?.cacheTtlSeconds).toBe(60);
    expect(rssSeed?.cacheTtlSeconds).toBe(60);
    expect(listSeed?.cacheTtlSeconds).toBe(180);
    expect(deepSeed?.cacheTtlSeconds).toBe(180);
  });

  it("keeps per-source seed cache ttl when global force strategy is disabled", () => {
    const { service } = createService();

    const seedConfig = (service as any).normalizeSeedConfig(
      {
        url: "https://example.com",
        config: {
          seed: {
            enabled: true,
            mode: "sitemap",
            cacheTtlSeconds: 900,
          },
        },
      },
      {
        seedFreshnessWindowDays: 365,
        seedCacheTtlSecondsSitemapRss: 60,
        seedCacheTtlSecondsListDeep: 180,
        seedCacheTtlForceGlobal: false,
      },
    );

    expect(seedConfig?.cacheTtlSeconds).toBe(900);
  });

  it("forces global seed cache ttl when global force strategy is enabled", () => {
    const { service } = createService();

    const seedConfig = (service as any).normalizeSeedConfig(
      {
        url: "https://example.com/latest",
        config: {
          seed: {
            enabled: true,
            mode: "list",
            cacheTtlSeconds: 900,
          },
        },
      },
      {
        seedFreshnessWindowDays: 365,
        seedCacheTtlSecondsSitemapRss: 60,
        seedCacheTtlSecondsListDeep: 180,
        seedCacheTtlForceGlobal: true,
      },
    );

    expect(seedConfig?.cacheTtlSeconds).toBe(180);
  });

  it("changes seed discovery cache key when ttl policy changes", async () => {
    const { service, cache, metadataService } = createService();
    (metadataService.discoverSitemapUrls as jest.Mock).mockResolvedValue([]);

    const source = {
      id: "source-1",
      url: "https://example.com",
      config: {
        seed: {
          enabled: true,
          mode: "sitemap",
          cacheTtlSeconds: 900,
          maxUrls: 20,
          maxNewUrlsPerRun: 5,
        },
      },
      crawlTemplate: null,
    };

    const seedFromSource = (service as any).normalizeSeedConfig(source, {
      seedFreshnessWindowDays: 365,
      seedCacheTtlSecondsSitemapRss: 60,
      seedCacheTtlSecondsListDeep: 180,
      seedCacheTtlForceGlobal: false,
    });
    await (service as any).resolveSeedCandidates(source as any, seedFromSource, 365);
    const keyFromSource = (cache.wrap as jest.Mock).mock.calls[0]?.[0] as string;

    const seedFromGlobal = (service as any).normalizeSeedConfig(source, {
      seedFreshnessWindowDays: 365,
      seedCacheTtlSecondsSitemapRss: 60,
      seedCacheTtlSecondsListDeep: 180,
      seedCacheTtlForceGlobal: true,
    });
    await (service as any).resolveSeedCandidates(source as any, seedFromGlobal, 365);
    const keyFromGlobal = (cache.wrap as jest.Mock).mock.calls[1]?.[0] as string;

    expect(keyFromSource).toMatch(/^news-source:sitemap:source-1:/);
    expect(keyFromGlobal).toMatch(/^news-source:sitemap:source-1:/);
    expect(keyFromSource).not.toBe(keyFromGlobal);
  });

  it("changes seed discovery cache key when discovery params change", async () => {
    const { service, cache, metadataService } = createService();
    (metadataService.discoverSitemapUrls as jest.Mock).mockResolvedValue([]);

    const source = {
      id: "source-1",
      url: "https://example.com",
      config: {
        seed: {
          enabled: true,
          mode: "sitemap",
          maxUrls: 20,
          maxNewUrlsPerRun: 5,
        },
      },
      crawlTemplate: null,
    };

    const seedA = (service as any).normalizeSeedConfig(source);
    await (service as any).resolveSeedCandidates(source as any, seedA, 365);
    const keyA = (cache.wrap as jest.Mock).mock.calls[0]?.[0] as string;

    const seedB = { ...seedA, pattern: "https://example.com/news/*" };
    await (service as any).resolveSeedCandidates(source as any, seedB, 365);
    const keyB = (cache.wrap as jest.Mock).mock.calls[1]?.[0] as string;

    expect(keyA).toMatch(/^news-source:sitemap:source-1:/);
    expect(keyB).toMatch(/^news-source:sitemap:source-1:/);
    expect(keyA).not.toBe(keyB);
  });

  it("schedules deep seeds via deep discovery and enforces robots ignore", async () => {
    const { service, prisma, metadataService, crawlQueue } = createService();
    const now = new Date("2026-01-01T00:00:00.000Z");

    (metadataService.discoverDeepUrls as jest.Mock).mockResolvedValue([
      "https://example.com/2026/02/13/news/alpha/",
      "https://example.com/2026/02/12/news/bravo/",
      "https://example.com/2026/02/11/news/charlie/",
    ]);

    (prisma.newsSource.findMany as jest.Mock).mockResolvedValue([
      {
        id: "source-1",
        orgId: "org-1",
        name: "Example",
        url: "https://example.com/latest/",
        siteType: "general",
        language: "en",
        crawlTemplateId: null,
        frequencySeconds: 3600,
        priority: 0,
        nextRunAt: now,
        config: {
          keywords: ["economy"],
          seed: {
            enabled: true,
            mode: "deep",
            maxUrls: 20,
            maxNewUrlsPerRun: 2,
            scoreThreshold: 0,
            dedupeWindowHours: 24,
            cacheTtlSeconds: 600,
            deep: {
              maxPages: 90,
              maxDepth: 3,
              timeBudgetSeconds: 75,
              pageConcurrency: 3,
              scoreThreshold: 0.25,
              candidatePoolSize: 140,
              headFetchTopK: 40,
              preferPathDate: false,
              enableSecondaryHubs: true,
              ignoreRobotsTxt: false,
            },
          },
        },
        crawlTemplate: null,
      },
    ]);

    (prisma.membership.findFirst as jest.Mock).mockResolvedValue({
      userId: "user-actor",
    });
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
            update: jest.fn(async (args: any) => ({
              id: args?.where?.id ?? `task-${taskIndex}`,
            })),
          },
        }),
    );

    (prisma.newsSource.update as jest.Mock).mockResolvedValue(undefined);
    (prisma.crawlTask.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (crawlQueue.enqueueTask as jest.Mock).mockResolvedValue(undefined);

    await (service as any).scheduleDueSources(now, 10);

    expect(metadataService.discoverDeepUrls).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/latest/",
        deep: expect.objectContaining({
          maxPages: 90,
          maxDepth: 3,
          ignoreRobotsTxt: true,
        }),
      }),
    );
    expect(crawlQueue.enqueueTask).toHaveBeenCalledTimes(2);
  });

  it("applies deep discovery failure backoff and records failure stats", async () => {
    const { service, prisma, metadataService, cache } = createService();
    const now = new Date("2026-01-01T00:00:00.000Z");

    (metadataService.discoverDeepUrls as jest.Mock).mockRejectedValue(
      new Error(
        "[SEED_DEEP_NO_PUBLISHED_AT] Deep discovery could not determine publish time for discovered links. discovered=3, unresolved=3",
      ),
    );
    (cache.get as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    (prisma.newsSource.findMany as jest.Mock).mockResolvedValue([
      {
        id: "source-1",
        orgId: "org-1",
        name: "Example",
        url: "https://example.com/latest/",
        siteType: "general",
        language: "en",
        crawlTemplateId: null,
        frequencySeconds: 3600,
        priority: 0,
        nextRunAt: now,
        config: {
          seed: {
            enabled: true,
            mode: "deep",
            maxUrls: 20,
            maxNewUrlsPerRun: 2,
            scoreThreshold: 0,
            dedupeWindowHours: 24,
            cacheTtlSeconds: 600,
            deep: {
              maxPages: 90,
              maxDepth: 2,
              timeBudgetSeconds: 45,
              pageConcurrency: 2,
              headFetchTopK: 20,
            },
          },
        },
        crawlTemplate: null,
      },
    ]);
    (prisma.pipelineJob.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.newsSource.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await (service as any).scheduleDueSources(now, 10);

    expect(prisma.newsSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "source-1", isActive: true },
        data: expect.objectContaining({
          lastFailureAt: expect.any(Date),
          nextRunAt: expect.any(Date),
        }),
      }),
    );

    expect(cache.set).toHaveBeenCalledWith(
      "news-source:deep-failure:state:source-1",
      expect.objectContaining({
        streak: 1,
        lastCode: "SEED_DEEP_NO_PUBLISHED_AT",
      }),
      expect.any(Number),
    );
    expect(cache.set).toHaveBeenCalledWith(
      "news-source:deep-failure:stats24h:source-1",
      expect.objectContaining({
        total: 1,
        byCode: expect.objectContaining({
          SEED_DEEP_NO_PUBLISHED_AT: 1,
        }),
      }),
      expect.any(Number),
    );
  });

  it("normalizes deep seed caps and hard-locks ignoreRobotsTxt", () => {
    const { service } = createService();

    const seedConfig = (service as any).normalizeSeedConfig({
      url: "https://example.com/latest/",
      config: {
        seed: {
          enabled: true,
          mode: "deep",
          maxUrls: 5000,
          maxNewUrlsPerRun: 900,
          deep: {
            maxPages: 999,
            maxDepth: 99,
            timeBudgetSeconds: 999,
            pageConcurrency: 99,
            scoreThreshold: 3,
            candidatePoolSize: 999,
            headFetchTopK: 999,
            preferPathDate: false,
            enableSecondaryHubs: false,
            ignoreRobotsTxt: false,
          },
        },
      },
    });

    expect(seedConfig).toEqual(
      expect.objectContaining({
        mode: "deep",
        maxUrls: 2000,
        maxNewUrlsPerRun: 500,
        deep: expect.objectContaining({
          maxPages: 300,
          maxDepth: 4,
          timeBudgetSeconds: 180,
          pageConcurrency: 6,
          scoreThreshold: 1,
          candidatePoolSize: 400,
          headFetchTopK: 120,
          preferPathDate: false,
          enableSecondaryHubs: false,
          ignoreRobotsTxt: true,
        }),
      }),
    );
  });
});
