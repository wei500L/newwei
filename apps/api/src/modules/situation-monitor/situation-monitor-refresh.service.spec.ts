import { SituationMonitorRefreshService } from "./situation-monitor-refresh.service";

describe("SituationMonitorRefreshService", () => {
  function createService() {
    const cache = {
      delByPrefix: jest.fn().mockResolvedValue(1),
    } as any;
    const prisma = {
      newsSource: {
        findMany: jest.fn().mockResolvedValue([
          { id: "source-1" },
          { id: "source-2" },
          { id: "source-3" },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      pipelineJob: {
        count: jest.fn().mockResolvedValue(5),
      },
      crawlTask: {
        count: jest.fn().mockResolvedValue(3),
      },
    } as any;
    const scheduler = {
      scheduleCron: jest.fn().mockResolvedValue(undefined),
    } as any;
    const signals = {
      runJob: jest.fn().mockResolvedValue(undefined),
      getTelegramFeed: jest.fn().mockResolvedValue({
        updatedAt: "2026-03-24T15:40:00.000Z",
      }),
      getOrefAlerts: jest.fn().mockResolvedValue({
        timestamp: "2026-03-24T15:40:01.000Z",
      }),
    } as any;

    return {
      service: new SituationMonitorRefreshService(
        cache,
        prisma,
        scheduler,
        signals,
      ),
      cache,
      prisma,
      scheduler,
      signals,
    };
  }

  it("queues active news sources and refreshes signals when crawl.write is available", async () => {
    const { service, cache, prisma, scheduler, signals } = createService();

    const result = await service.refresh("org-1", ["items.read", "crawl.write"]);

    expect(cache.delByPrefix).toHaveBeenCalledTimes(2);
    expect(prisma.newsSource.findMany).toHaveBeenCalledWith({
      where: { orgId: "org-1", isActive: true },
      select: { id: true },
    });
    expect(prisma.newsSource.updateMany).toHaveBeenCalledTimes(1);
    expect(scheduler.scheduleCron).toHaveBeenCalledTimes(1);
    expect(signals.runJob).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("accepted");
    expect(result.crawl.permitted).toBe(true);
    expect(result.crawl.scheduledSourceCount).toBe(3);
    expect(result.crawl.schedulerTriggered).toBe(true);
    expect(result.crawl.crawlTaskCount).toBe(3);
    expect(result.crawl.analysisTaskCount).toBe(2);
    expect(result.signals.telegram.ok).toBe(true);
    expect(result.signals.oref.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("returns explicit warnings when crawl permission is missing or signals report errors", async () => {
    const { service, prisma, scheduler, signals } = createService();
    signals.getTelegramFeed.mockResolvedValue({
      updatedAt: null,
      error: "Telegram polling is disabled",
    });
    signals.getOrefAlerts.mockResolvedValue({
      timestamp: "2026-03-24T15:40:01.000Z",
      error: "OREF polling is disabled",
    });

    const result = await service.refresh("org-1", ["items.read"]);

    expect(prisma.newsSource.updateMany).not.toHaveBeenCalled();
    expect(scheduler.scheduleCron).not.toHaveBeenCalled();
    expect(result.status).toBe("partial");
    expect(result.crawl.permitted).toBe(false);
    expect(result.signals.telegram.ok).toBe(false);
    expect(result.signals.oref.ok).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "situation_monitor_crawl_permission_required",
          source: "crawl",
        }),
        expect.objectContaining({
          code: "situation_monitor_telegram_refresh_failed",
          source: "telegram",
        }),
        expect.objectContaining({
          code: "situation_monitor_oref_refresh_failed",
          source: "oref",
        }),
      ]),
    );
  });

  it("returns an explicit warning when the crawl scheduler is already busy", async () => {
    const { service, scheduler } = createService();
    scheduler.scheduleCron.mockResolvedValue(null);

    const result = await service.refresh("org-1", ["items.read", "crawl.write"]);

    expect(result.status).toBe("partial");
    expect(result.crawl.schedulerTriggered).toBe(false);
    expect(result.crawl.crawlTaskCount).toBe(0);
    expect(result.crawl.analysisTaskCount).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "situation_monitor_crawl_scheduler_busy",
          source: "crawl",
        }),
      ]),
    );
  });
});
