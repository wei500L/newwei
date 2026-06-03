jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    find: jest.fn(),
  },
}));

import { TaskLogModel } from "@modular/mongo";

import { CrawlQualityTaskSnapshotService } from "../crawl-quality-task-snapshot.service";

describe("CrawlQualityTaskSnapshotService", () => {
  function createService() {
    const prisma = {
      org: {
        findMany: jest.fn(),
      },
      crawlTask: {
        findMany: jest.fn(),
      },
      crawlResult: {
        findMany: jest.fn(),
      },
      crawlQualityTaskSnapshot: {
        findMany: jest.fn(),
      },
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
    } as any;
    const cache = {
      setIfAbsent: jest.fn().mockResolvedValue(true),
      withLock: jest.fn(),
    } as any;
    const schedulerSettings = {
      getRuntimeSettings: jest.fn().mockResolvedValue({
        crawlQualityTaskSnapshotOrgConcurrency: 2,
      }),
    } as any;

    return {
      prisma,
      cache,
      schedulerSettings,
      service: new CrawlQualityTaskSnapshotService(
        prisma,
        cache,
        schedulerSettings,
      ),
    };
  }

  it("refreshes missing, stale, and stale-active task snapshots in a window", async () => {
    const { prisma, service } = createService();
    prisma.crawlQualityTaskSnapshot.findMany.mockResolvedValue([
      {
        taskId: "task-stale",
        taskUpdatedAt: new Date("2026-03-22T10:00:00.000Z"),
        rolledAt: new Date("2026-03-22T10:04:30.000Z"),
      },
      {
        taskId: "task-active-old",
        taskUpdatedAt: new Date("2026-03-22T10:04:00.000Z"),
        rolledAt: new Date("2026-03-22T09:50:00.000Z"),
      },
      {
        taskId: "task-fresh",
        taskUpdatedAt: new Date("2026-03-22T10:04:00.000Z"),
        rolledAt: new Date("2026-03-22T10:04:30.000Z"),
      },
    ]);
    const refreshSpy = jest
      .spyOn(service, "refreshSnapshotsForTaskIds")
      .mockResolvedValue(undefined);

    await service.ensureSnapshotsForWindow(
      "org-1",
      new Date("2026-03-22T09:00:00.000Z"),
      new Date("2026-03-22T11:00:00.000Z"),
      [
        {
          id: "task-missing",
          status: "completed" as any,
          updatedAt: new Date("2026-03-22T10:04:00.000Z"),
        },
        {
          id: "task-stale",
          status: "completed" as any,
          updatedAt: new Date("2026-03-22T10:04:00.000Z"),
        },
        {
          id: "task-active-old",
          status: "running" as any,
          updatedAt: new Date("2026-03-22T10:04:00.000Z"),
        },
        {
          id: "task-fresh",
          status: "completed" as any,
          updatedAt: new Date("2026-03-22T10:04:00.000Z"),
        },
      ],
      new Date("2026-03-22T10:05:01.000Z"),
    );

    expect(refreshSpy).toHaveBeenCalledWith("org-1", [
      "task-missing",
      "task-stale",
      "task-active-old",
    ]);
  });

  it("maps aggregate SQL rows into snapshot metrics", async () => {
    const { prisma, service } = createService();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          taskCount: 4,
          lowSignalTaskCount: 2,
          expansionTriggeredTaskCount: 2,
          expansionImprovedTaskCount: 1,
          markdownCount: 4,
          markdownCharsTotal: 100,
          emptyMarkdownCount: 1,
          candidateRejectIncludePatternCount: 2,
          candidateRejectExcludePatternCount: 3,
          candidateRejectPublishConfidenceCount: 4,
          publishConfidenceLt04Count: 1,
          publishConfidenceFrom04To06Count: 2,
          publishConfidenceFrom06To08Count: 3,
          publishConfidenceGte08Count: 4,
          fitMarkdownPreferenceTaskCount: 1,
          headSignalAttemptedCount: 4,
          headSignalSucceededCount: 3,
          headSignalSoftFailureCount: 1,
          headSignalTruncatedCount: 1,
          headSignalNoPublishSignalCount: 1,
          preflightRunCount: 4,
          preflightFailureCount: 1,
          preflight304HitCount: 2,
          dedupeEvaluatedCount: 10,
          dedupeOrgReuseCount: 2,
        },
      ])
      .mockResolvedValueOnce([
        {
          sourceId: "source-b",
          taskCount: 1,
          lowSignalTaskCount: 0,
          expansionTriggeredTaskCount: 1,
          expansionImprovedTaskCount: 1,
          markdownCount: 1,
          markdownCharsTotal: 70,
          emptyMarkdownCount: 0,
          candidateRejectIncludePatternCount: 0,
          candidateRejectExcludePatternCount: 1,
          candidateRejectPublishConfidenceCount: 1,
          publishConfidenceLt04Count: 0,
          publishConfidenceFrom04To06Count: 0,
          publishConfidenceFrom06To08Count: 1,
          publishConfidenceGte08Count: 2,
          fitMarkdownPreferenceTaskCount: 1,
          headSignalAttemptedCount: 2,
          headSignalSucceededCount: 2,
          headSignalSoftFailureCount: 0,
          headSignalTruncatedCount: 0,
          headSignalNoPublishSignalCount: 0,
          preflightRunCount: 2,
          preflightFailureCount: 0,
          preflight304HitCount: 1,
          dedupeEvaluatedCount: 4,
          dedupeOrgReuseCount: 1,
        },
        {
          sourceId: "source-a",
          taskCount: 3,
          lowSignalTaskCount: 2,
          expansionTriggeredTaskCount: 1,
          expansionImprovedTaskCount: 0,
          markdownCount: 3,
          markdownCharsTotal: 30,
          emptyMarkdownCount: 1,
          candidateRejectIncludePatternCount: 2,
          candidateRejectExcludePatternCount: 2,
          candidateRejectPublishConfidenceCount: 3,
          publishConfidenceLt04Count: 1,
          publishConfidenceFrom04To06Count: 2,
          publishConfidenceFrom06To08Count: 2,
          publishConfidenceGte08Count: 2,
          fitMarkdownPreferenceTaskCount: 0,
          headSignalAttemptedCount: 2,
          headSignalSucceededCount: 1,
          headSignalSoftFailureCount: 1,
          headSignalTruncatedCount: 1,
          headSignalNoPublishSignalCount: 1,
          preflightRunCount: 2,
          preflightFailureCount: 1,
          preflight304HitCount: 1,
          dedupeEvaluatedCount: 6,
          dedupeOrgReuseCount: 1,
        },
      ]);

    const metrics = await service.readAggregates(
      "org-1",
      new Date("2026-03-22T09:00:00.000Z"),
      new Date("2026-03-22T11:00:00.000Z"),
    );

    expect(metrics).toMatchObject({
      taskCount: 4,
      lowSignalRatio: 0.5,
      emptyMarkdownRate: 0.25,
      expansionTriggerRate: 0.5,
      expansionSuccessRate: 0.5,
      avgMarkdownChars: 25,
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
    });
    expect(metrics.groupedBySource.map((entry) => entry.sourceId)).toEqual([
      "source-a",
      "source-b",
    ]);
    expect(metrics.groupedBySource[0]).toMatchObject({
      taskCount: 3,
      lowSignalRatio: 0.6667,
      expansionSuccessRate: 0,
      avgMarkdownChars: 10,
      http304HitRate: 0.5,
      orgHashDedupeHitRate: 0.1667,
      preflightFailureRate: 0.5,
    });
  });

  it("splits crawl task discovery into created and updated branches without duplicate ids", async () => {
    const { prisma, service } = createService();
    prisma.crawlTask.findMany
      .mockResolvedValueOnce([{ id: "task-created" }, { id: "task-shared" }])
      .mockResolvedValueOnce([{ id: "task-updated" }, { id: "task-shared" }]);
    prisma.crawlResult.findMany.mockResolvedValue([{ taskId: "task-result" }]);

    const taskLogLean = jest
      .fn()
      .mockResolvedValue([{ jobId: "task-log" }, { jobId: "task-shared" }]);
    (TaskLogModel.find as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: taskLogLean }),
    });

    const result = await (service as any).discoverRecentlyChangedTaskIds(
      "org-1",
      new Date("2026-03-22T10:00:00.000Z"),
    );

    expect(prisma.crawlTask.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          orgId: "org-1",
          createdAt: { gte: new Date("2026-03-22T10:00:00.000Z") },
        },
      }),
    );
    expect(prisma.crawlTask.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          orgId: "org-1",
          createdAt: { lt: new Date("2026-03-22T10:00:00.000Z") },
          updatedAt: { gte: new Date("2026-03-22T10:00:00.000Z") },
        },
      }),
    );
    expect(result).toEqual([
      "task-created",
      "task-shared",
      "task-updated",
      "task-log",
      "task-result",
    ]);
  });
});
