import { CrawlQualityMetricsService } from "../crawl-quality-metrics.service";

function createAggregates() {
  return {
    taskCount: 2,
    lowSignalRatio: 0.5,
    emptyMarkdownRate: 0.25,
    expansionTriggerRate: 0.5,
    expansionSuccessRate: 1,
    avgMarkdownChars: 120,
    candidateRejects: {
      includePattern: 2,
      excludePattern: 3,
      publishConfidence: 4,
    },
    publishConfidenceBuckets: {
      lt04: 1,
      from04To06: 2,
      from06To08: 3,
      gte08: 4,
    },
    fitMarkdownPreferenceRate: 0.5,
    headSignalSuccessRate: 0.75,
    headSignalSoftFailureRate: 0.25,
    headSignalTruncatedRate: 0.25,
    headSignalNoPublishSignalRate: 0.25,
    http304HitRate: 0.5,
    orgHashDedupeHitRate: 0.2,
    preflightFailureRate: 0.25,
    groupedBySource: [
      {
        sourceId: "source-1",
        taskCount: 2,
        lowSignalRatio: 0.5,
        expansionSuccessRate: 1,
        avgMarkdownChars: 120,
        candidateRejects: {
          includePattern: 2,
          excludePattern: 3,
          publishConfidence: 4,
        },
        publishConfidenceBuckets: {
          lt04: 1,
          from04To06: 2,
          from06To08: 3,
          gte08: 4,
        },
        fitMarkdownPreferenceRate: 0.5,
        headSignalSuccessRate: 0.75,
        headSignalSoftFailureRate: 0.25,
        headSignalTruncatedRate: 0.25,
        headSignalNoPublishSignalRate: 0.25,
        http304HitRate: 0.5,
        orgHashDedupeHitRate: 0.2,
        preflightFailureRate: 0.25,
      },
    ],
  };
}

describe("CrawlQualityMetricsService", () => {
  function createService() {
    const prisma = {
      crawlTask: {
        findMany: jest.fn(),
      },
      alertRule: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;
    const snapshots = {
      getOrCreate: jest.fn(
        async ({ loader }: { loader: () => Promise<unknown> }) => ({
          payload: await loader(),
        }),
      ),
    } as any;
    const taskSnapshots = {
      ensureSnapshotsForWindow: jest.fn().mockResolvedValue(undefined),
      readAggregates: jest.fn().mockResolvedValue(createAggregates()),
    } as any;

    return {
      prisma,
      snapshots,
      taskSnapshots,
      service: new CrawlQualityMetricsService(prisma, snapshots, taskSnapshots),
    };
  }

  it("hydrates task snapshots before reading aggregate metrics", async () => {
    const { prisma, taskSnapshots, service } = createService();
    const updatedAt = new Date("2026-03-22T10:00:00.000Z");
    prisma.crawlTask.findMany.mockResolvedValue([
      {
        id: "task-1",
        status: "completed",
        updatedAt,
      },
      {
        id: "task-2",
        status: "running",
        updatedAt,
      },
    ]);
    prisma.alertRule.findMany.mockResolvedValue([
      {
        metricSlug: "crawl_quality.preflight_failure_rate",
        operator: "gte",
        thresholdValue: 0.2,
      },
      {
        metricSlug: "crawl_quality.http_304_hit_rate",
        operator: "lte",
        thresholdValue: 0.06,
      },
      {
        metricSlug: "crawl_quality.org_hash_dedupe_hit_rate",
        operator: "gte",
        thresholdValue: 0.35,
      },
    ]);

    const snapshot = await service.getSnapshot("org-1");

    expect(taskSnapshots.ensureSnapshotsForWindow).toHaveBeenCalledWith(
      "org-1",
      expect.any(Date),
      expect.any(Date),
      [
        { id: "task-1", status: "completed", updatedAt },
        { id: "task-2", status: "running", updatedAt },
      ],
      expect.any(Date),
    );
    expect(taskSnapshots.readAggregates).toHaveBeenCalledWith(
      "org-1",
      expect.any(Date),
      expect.any(Date),
    );
    expect(snapshot.taskCount).toBe(2);
    expect(snapshot.alertThresholds).toEqual({
      preflightFailureRateHigh: 0.2,
      http304HitRateLow: 0.06,
      orgHashDedupeHitRateHigh: 0.35,
    });
  });

  it("returns an empty snapshot when no tasks match the lookback window", async () => {
    const { prisma, taskSnapshots, service } = createService();
    prisma.crawlTask.findMany.mockResolvedValue([]);

    const snapshot = await service.getSnapshot("org-1");

    expect(taskSnapshots.ensureSnapshotsForWindow).not.toHaveBeenCalled();
    expect(taskSnapshots.readAggregates).not.toHaveBeenCalled();
    expect(snapshot.taskCount).toBe(0);
    expect(snapshot.groupedBySource).toEqual([]);
  });
});
