jest.mock("@modular/mongo", () => ({
  CrawlResultContentModel: {
    find: jest.fn(),
  },
  TaskLogModel: {
    find: jest.fn(),
  },
}));

import { CrawlResultContentModel, TaskLogModel } from "@modular/mongo";

import { CrawlQualityMetricsService } from "../crawl-quality-metrics.service";

const mockedTaskLogFind = TaskLogModel.find as jest.Mock;
const mockedCrawlResultFind = CrawlResultContentModel.find as jest.Mock;

function mockFindChain(findMock: jest.Mock, docs: unknown[]) {
  findMock.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(docs),
    }),
  });
}

function mockTaskLogFindByStage(logs: {
  expansion?: unknown[];
  preflight?: unknown[];
  dedupe?: unknown[];
}) {
  mockedTaskLogFind.mockImplementation(() => {
    const docs = [
      ...(logs.expansion ?? []).map((entry) => ({
        stage: "expansion",
        ...((entry ?? {}) as object),
      })),
      ...(logs.preflight ?? []).map((entry) => ({
        stage: "preflight",
        ...((entry ?? {}) as object),
      })),
      ...(logs.dedupe ?? []).map((entry) => ({
        stage: "dedupe",
        ...((entry ?? {}) as object),
      })),
    ];
    return {
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(docs),
      }),
    };
  });
}

describe("CrawlQualityMetricsService", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockFindChain(mockedCrawlResultFind, []);
  });

  function createServiceWithTaskLogs(logs: {
    expansion?: unknown[];
    preflight?: unknown[];
    dedupe?: unknown[];
    alertRules?: unknown[];
  }) {
    mockTaskLogFindByStage(logs);
    const prisma = {
      crawlTask: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "task-1", displayName: null, config: null },
          ]),
      },
      alertRule: {
        findMany: jest.fn().mockResolvedValue(logs.alertRules ?? []),
      },
    } as any;
    const snapshots = {
      getOrCreate: jest.fn(
        async ({ loader }: { loader: () => Promise<unknown> }) => ({
          payload: await loader(),
        }),
      ),
    } as any;
    return new CrawlQualityMetricsService(prisma, snapshots);
  }

  function createServiceWithLogs(expansionLogs: unknown[]) {
    return createServiceWithTaskLogs({ expansion: expansionLogs });
  }

  it("reads candidate rejects from *Rejected fields in expansion logs", async () => {
    const service = createServiceWithLogs([
      {
        jobId: "task-1",
        status: "processing",
        data: {
          candidateRejects: {
            includePatternRejected: 2,
            excludePatternRejected: 3,
            publishConfidenceRejected: 4,
          },
        },
      },
    ]);

    const snapshot = await service.getSnapshot("org-1");

    expect(snapshot.candidateRejects).toEqual({
      includePattern: 2,
      excludePattern: 3,
      publishConfidence: 4,
    });
    expect(snapshot.groupedBySource[0]?.candidateRejects).toEqual({
      includePattern: 2,
      excludePattern: 3,
      publishConfidence: 4,
    });
  });

  it("falls back to legacy candidate reject field names", async () => {
    const service = createServiceWithLogs([
      {
        jobId: "task-1",
        status: "processing",
        data: {
          candidateRejects: {
            includePattern: 5,
            excludePattern: 6,
            publishConfidence: 7,
          },
        },
      },
    ]);

    const snapshot = await service.getSnapshot("org-1");

    expect(snapshot.candidateRejects).toEqual({
      includePattern: 5,
      excludePattern: 6,
      publishConfidence: 7,
    });
  });

  it("aggregates preflight and org-hash dedupe rates", async () => {
    const service = createServiceWithTaskLogs({
      expansion: [],
      preflight: [
        {
          jobId: "task-1",
          status: "completed",
          data: { status: 304 },
        },
        {
          jobId: "task-1",
          status: "failed",
          data: {},
        },
      ],
      dedupe: [
        {
          jobId: "task-1",
          status: "completed",
          data: { evaluatedCount: 20, orgReuseCount: 5 },
        },
      ],
    });

    const snapshot = await service.getSnapshot("org-1");

    expect(snapshot.http304HitRate).toBe(0.5);
    expect(snapshot.preflightFailureRate).toBe(0.5);
    expect(snapshot.orgHashDedupeHitRate).toBe(0.25);
    expect(snapshot.groupedBySource[0]?.http304HitRate).toBe(0.5);
    expect(snapshot.groupedBySource[0]?.preflightFailureRate).toBe(0.5);
    expect(snapshot.groupedBySource[0]?.orgHashDedupeHitRate).toBe(0.25);
  });

  it("reads crawl quality alert thresholds from active alert rules", async () => {
    const service = createServiceWithTaskLogs({
      expansion: [],
      preflight: [],
      dedupe: [],
      alertRules: [
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
      ],
    });

    const snapshot = await service.getSnapshot("org-1");
    expect(snapshot.alertThresholds).toEqual({
      preflightFailureRateHigh: 0.2,
      http304HitRateLow: 0.06,
      orgHashDedupeHitRateHigh: 0.35,
    });
  });
});
