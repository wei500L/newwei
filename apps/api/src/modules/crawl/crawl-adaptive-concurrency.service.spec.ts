import { CrawlAdaptiveConcurrencyService } from "./crawl-adaptive-concurrency.service";

describe("CrawlAdaptiveConcurrencyService", () => {
  const createService = () => {
    const prisma = {
      crawlTask: {
        count: jest.fn(),
        findMany: jest.fn()
      }
    } as any;

    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      withLock: jest.fn().mockResolvedValue(undefined)
    } as any;

    const crawlSettings = {
      getSettings: jest.fn(),
      updateMaxConcurrencyInternal: jest.fn().mockResolvedValue(undefined)
    } as any;

    const crawlQueue = {
      setGlobalConcurrency: jest.fn().mockResolvedValue(undefined)
    } as any;

    const crawlProcessor = {
      setWorkerConcurrency: jest.fn()
    } as any;

    const service = new CrawlAdaptiveConcurrencyService(
      prisma,
      cache,
      crawlSettings,
      crawlQueue,
      crawlProcessor
    );

    return {
      service,
      prisma,
      cache,
      crawlSettings,
      crawlQueue,
      crawlProcessor
    };
  };

  it("does not change concurrency when adaptive mode is disabled", async () => {
    const { service, prisma, crawlSettings, crawlQueue, crawlProcessor } = createService();
    crawlSettings.getSettings.mockResolvedValue({
      adaptiveConcurrencyEnabled: false,
      maxConcurrency: 4,
      requestTimeoutNormalMs: 120_000,
      adaptiveWindowMinutes: 15,
      adaptiveCooldownMinutes: 5,
      adaptiveLatencyThresholdRatio: 0.85,
      adaptiveErrorRateThreshold: 0.2,
      adaptiveMemoryHeadroomThreshold: 0.12
    });
    await service.adjustConcurrency(new Date("2026-01-01T00:00:00.000Z"));

    expect(prisma.crawlTask.count).not.toHaveBeenCalled();
    expect(prisma.crawlTask.findMany).not.toHaveBeenCalled();
    expect(crawlSettings.updateMaxConcurrencyInternal).not.toHaveBeenCalled();
    expect(crawlQueue.setGlobalConcurrency).not.toHaveBeenCalled();
    expect(crawlProcessor.setWorkerConcurrency).not.toHaveBeenCalled();
  });

  it("decreases concurrency when latency/error thresholds are exceeded", async () => {
    const { service, prisma, cache, crawlSettings, crawlQueue, crawlProcessor } = createService();
    const now = new Date("2026-01-01T00:00:00.000Z");

    crawlSettings.getSettings.mockResolvedValue({
      adaptiveConcurrencyEnabled: true,
      maxConcurrency: 4,
      requestTimeoutNormalMs: 120_000,
      adaptiveWindowMinutes: 15,
      adaptiveCooldownMinutes: 5,
      adaptiveLatencyThresholdRatio: 0.85,
      adaptiveErrorRateThreshold: 0.2,
      adaptiveMemoryHeadroomThreshold: 0.12
    });

    prisma.crawlTask.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    prisma.crawlTask.findMany.mockResolvedValue([
      {
        lastRunAt: new Date(now.getTime() - 119_000),
        updatedAt: now,
        lastServerMemoryMb: 100,
        lastPeakMemoryMb: 95
      },
      {
        lastRunAt: new Date(now.getTime() - 130_000),
        updatedAt: now,
        lastServerMemoryMb: 100,
        lastPeakMemoryMb: 94
      }
    ]);

    cache.get.mockResolvedValue(null);

    await service.adjustConcurrency(now);

    expect(crawlSettings.updateMaxConcurrencyInternal).toHaveBeenCalledWith(3);
    expect(crawlQueue.setGlobalConcurrency).toHaveBeenCalledWith(3);
    expect(crawlProcessor.setWorkerConcurrency).toHaveBeenCalledWith(3);
    expect(cache.set).toHaveBeenCalledWith(
      "crawl:adaptive-concurrency:state",
      expect.objectContaining({
        lastDecision: "decrease",
        currentMaxConcurrency: 3,
        metrics: expect.objectContaining({
          latencySampleCount: 2,
          samplingMode: "recent_sample"
        })
      }),
      expect.any(Number)
    );
  });

  it("respects cooldown and skips repeated decrease", async () => {
    const { service, prisma, cache, crawlSettings, crawlQueue, crawlProcessor } = createService();
    const now = new Date("2026-01-01T00:10:00.000Z");

    crawlSettings.getSettings.mockResolvedValue({
      adaptiveConcurrencyEnabled: true,
      maxConcurrency: 4,
      requestTimeoutNormalMs: 120_000,
      adaptiveWindowMinutes: 15,
      adaptiveCooldownMinutes: 5,
      adaptiveLatencyThresholdRatio: 0.85,
      adaptiveErrorRateThreshold: 0.2,
      adaptiveMemoryHeadroomThreshold: 0.12
    });

    prisma.crawlTask.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    prisma.crawlTask.findMany.mockResolvedValue([
      {
        lastRunAt: new Date(now.getTime() - 130_000),
        updatedAt: now,
        lastServerMemoryMb: 100,
        lastPeakMemoryMb: 95
      }
    ]);

    cache.get.mockResolvedValue({
      enabled: true,
      lastDecision: "decrease",
      lastAdjustedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
      reason: "previous",
      currentMaxConcurrency: 3,
      updatedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
      metrics: {
        taskCount: 1,
        failedCount: 1,
        errorRate: 1,
        p95LatencyMs: 130_000,
        memoryHeadroom: 0.05,
        memorySampleCount: 1,
        latencySampleCount: 1,
        samplingMode: "recent_sample"
      }
    });

    await service.adjustConcurrency(now);

    expect(crawlSettings.updateMaxConcurrencyInternal).not.toHaveBeenCalled();
    expect(crawlQueue.setGlobalConcurrency).not.toHaveBeenCalled();
    expect(crawlProcessor.setWorkerConcurrency).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledWith(
      "crawl:adaptive-concurrency:state",
      expect.objectContaining({
        lastDecision: "cooldown",
        currentMaxConcurrency: 4
      }),
      expect.any(Number)
    );
  });

  it("exposes adaptive tuning values from crawl settings in status", async () => {
    const { service, cache, crawlSettings } = createService();
    crawlSettings.getSettings.mockResolvedValue({
      adaptiveConcurrencyEnabled: true,
      maxConcurrency: 4,
      requestTimeoutNormalMs: 120_000,
      adaptiveWindowMinutes: 30,
      adaptiveCooldownMinutes: 7,
      adaptiveLatencyThresholdRatio: 0.9,
      adaptiveErrorRateThreshold: 0.25,
      adaptiveMemoryHeadroomThreshold: 0.15
    });
    cache.get.mockResolvedValue(null);

    const status = await service.getStatus();

    expect(status.windowMinutes).toBe(30);
    expect(status.cooldownMinutes).toBe(7);
    expect(status.thresholds).toEqual({
      latencyRatio: 0.9,
      errorRate: 0.25,
      memoryHeadroom: 0.15
    });
    expect(status.metrics).toEqual(
      expect.objectContaining({
        latencySampleCount: 0,
        samplingMode: "recent_sample"
      })
    );
  });
});
