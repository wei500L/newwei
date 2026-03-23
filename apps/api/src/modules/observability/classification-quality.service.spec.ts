jest.mock("@modular/mongo", () => ({
  ClassificationAnnotationModel: {
    create: jest.fn(),
    find: jest.fn(),
  },
  ClassificationReportJobModel: {
    create: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
  ClassificationReportResultModel: {
    create: jest.fn(),
    findOne: jest.fn(),
  },
  ClassificationReviewModel: {
    countDocuments: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    updateMany: jest.fn(),
  },
  ClassificationSampleModel: {
    create: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
  ProcessedItemModel: {
    aggregate: jest.fn(),
    countDocuments: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
  },
  TaskLogModel: {
    aggregate: jest.fn(),
    countDocuments: jest.fn(),
    find: jest.fn(),
  },
}));

import {
  ClassificationReviewModel,
  ProcessedItemModel,
  TaskLogModel,
} from "@modular/mongo";

import { ClassificationQualityService } from "./classification-quality.service";

describe("ClassificationQualityService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createService = () => {
    const prisma = {
      newsSource: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      membership: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;

    const cache = {
      wrap: jest.fn().mockImplementation(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      setIfAbsent: jest.fn().mockResolvedValue(true),
    } as any;

    const qualitySettings = {
      getSettings: jest.fn().mockResolvedValue({
        lowConfidenceThreshold: 0.4,
        llmP95LatencyWarnMs: 10_000,
        embeddingP95LatencyWarnMs: 10_000,
        rerankP95LatencyWarnMs: 10_000,
        gateRejectRateWarn: 0.9,
        gatePenalizedRateWarn: 0.9,
        reportMinPairCount: 2,
        reportMinPairErrorRate: 0.05,
      }),
    } as any;

    const notifications = {
      notify: jest.fn().mockResolvedValue(undefined),
    } as any;

    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as any;

    return {
      prisma,
      cache,
      qualitySettings,
      notifications,
      queue,
      service: new ClassificationQualityService(
        prisma,
        cache,
        qualitySettings,
        notifications,
        queue,
      ),
    };
  };

  it("keeps listReviewQueue read-only and applies window filter", async () => {
    const { service } = createService();

    const rows = [
      {
        _id: "review-1",
        orgId: "org-1",
        status: "pending",
        predictedConfidence: 0.3,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ];
    const lean = jest.fn().mockResolvedValue(rows);
    const limit = jest.fn().mockReturnValue({ lean });
    const sort = jest.fn().mockReturnValue({ limit });
    const select = jest.fn().mockReturnValue({ sort });
    (ClassificationReviewModel.find as jest.Mock).mockReturnValue({ select });

    await service.listReviewQueue({
      orgId: "org-1",
      actorId: "user-1",
      window: "24h",
      onlyUnreviewed: true,
      limit: 20,
      maxConfidence: 0.5,
    });

    const where = (ClassificationReviewModel.find as jest.Mock).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(where?.orgId).toBe("org-1");
    expect(where?.status).toBe("pending");
    expect(where?.predictedConfidence).toEqual({ $lte: 0.5 });
    expect(where?.createdAt).toEqual(
      expect.objectContaining({
        $gte: expect.any(Date),
        $lte: expect.any(Date),
      }),
    );
    expect(ClassificationReviewModel.updateOne).not.toHaveBeenCalled();
    expect(ClassificationReviewModel.updateMany).not.toHaveBeenCalled();
  });

  it("seeds pending review only for low-confidence processed item", async () => {
    const { service, prisma, cache } = createService();

    prisma.systemSetting.findUnique.mockImplementation(async (args: { where?: { key?: string } }) => {
      const key = args?.where?.key ?? "";
      if (key.startsWith("news_event_settings:")) {
        return {
          value: {
            minCategoryConfidenceForGate: 0.6,
          },
        };
      }
      if (key.startsWith("news_event_source_policy:")) {
        return null;
      }
      return null;
    });
    prisma.processedArticle.findMany.mockResolvedValue([
      {
        cleanedMarkdownRef: "processed-1",
        article: {
          url: "https://example.com/article",
          sourceId: "source-1",
        },
      },
    ]);
    prisma.newsSource.findFirst.mockResolvedValue({
      id: "source-1",
      name: "Example Source",
      url: "https://example.com",
    });
    cache.get.mockResolvedValue(null);

    const lean = jest.fn().mockResolvedValue({
      _id: "processed-1",
      orgId: "org-1",
      status: "completed",
      itemMetaId: "item-1",
      sourceId: "source-1",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      result: {
        title: "Title",
        summary: "Summary",
        category_path: "tech/ai",
        category: "technology",
        category_confidence: 0.3,
        category_method: "llm-embedding-rerank",
        category_candidates: [{ path: "tech/ai", score: 0.3 }],
      },
    });
    const select = jest.fn().mockReturnValue({ lean });
    (ProcessedItemModel.findOne as jest.Mock).mockReturnValue({ select });
    (ClassificationReviewModel.updateOne as jest.Mock).mockReturnValue({
      exec: jest.fn().mockResolvedValue({}),
    });

    await service.processReviewSeedItemJob({
      orgId: "org-1",
      processedItemId: "processed-1",
    });

    expect(ClassificationReviewModel.updateOne).toHaveBeenCalledWith(
      { orgId: "org-1", processedItemId: "processed-1" },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          orgId: "org-1",
          processedItemId: "processed-1",
          status: "pending",
          predictedConfidence: 0.3,
        }),
      }),
      { upsert: true },
    );
  });

  it("skips review seed when confidence is above gate threshold", async () => {
    const { service, prisma } = createService();

    prisma.systemSetting.findUnique.mockResolvedValue({
      value: {
        minCategoryConfidenceForGate: 0.4,
      },
    });
    const lean = jest.fn().mockResolvedValue({
      _id: "processed-2",
      orgId: "org-1",
      status: "completed",
      result: {
        category_confidence: 0.8,
      },
    });
    const select = jest.fn().mockReturnValue({ lean });
    (ProcessedItemModel.findOne as jest.Mock).mockReturnValue({ select });

    await service.processReviewSeedItemJob({
      orgId: "org-1",
      processedItemId: "processed-2",
    });

    expect(ClassificationReviewModel.updateOne).not.toHaveBeenCalled();
  });

  it("includes semantic summaries in classification quality notifications", async () => {
    const { service, notifications } = createService();

    await (service as any).notifyThresholdBreaches({
      orgId: "org-1",
      window: "24h",
      latencyAlerts: [
        {
          stage: "llm",
          thresholdMs: 1000,
          p95Ms: 1200,
          triggered: true,
        },
      ],
      gateAlerts: [
        {
          metric: "reject_rate",
          threshold: 0.2,
          value: 0.35,
          triggered: true,
        },
      ],
    });

    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        userId: null,
        type: "system",
        title: "Classification quality threshold exceeded",
        body:
          "Latency alerts: llm p95=1200ms > 1000ms | Category gate alerts: reject_rate=35% > 20%",
        data: expect.objectContaining({
          presentation: expect.objectContaining({
            kind: "classification_quality_threshold_exceeded",
            technicalDetail:
              "Latency alerts: llm p95=1200ms > 1000ms | Category gate alerts: reject_rate=35% > 20%",
            params: expect.objectContaining({
              window: "24h",
              latencyAlertCount: 1,
              gateAlertCount: 1,
              latencySummary: "llm p95=1200ms > 1000ms",
              gateSummary: "reject_rate=35% > 20%",
              latencyStages: ["llm"],
              gateMetrics: ["reject_rate"],
            }),
          }),
        }),
      }),
    );
  });

  it("builds summary via aggregate facets instead of count+find dual queries", async () => {
    const { service, prisma } = createService();

    (ProcessedItemModel.aggregate as jest.Mock).mockResolvedValue([
      {
        total: [{ count: 2 }],
        sampled: [
          {
            _id: "processed-1",
            sourceId: "source-1",
            createdAt: new Date("2025-01-01T00:00:00.000Z"),
            result: {
              category_confidence: 0.25,
              category_method: "llm-embedding-rerank",
              category_path: "tech/ai",
            },
          },
          {
            _id: "processed-2",
            sourceId: "source-2",
            createdAt: new Date("2025-01-01T00:10:00.000Z"),
            result: {
              category_confidence: 0.75,
              category_method: "rule-fallback",
              category_path: "finance/regulation",
            },
          },
        ],
      },
    ]);
    (TaskLogModel.aggregate as jest.Mock)
      .mockResolvedValueOnce([
        {
          total: [{ count: 1 }],
          sampled: [{ data: { llmLatencyMs: 150, embeddingLatencyMs: 30, rerankLatencyMs: 45 } }],
        },
      ])
      .mockResolvedValueOnce([
        {
          total: [{ count: 1 }],
          sampled: [{ data: { decision: "accepted" } }],
        },
      ]);
    (ClassificationReviewModel.countDocuments as jest.Mock).mockReturnValue({
      exec: jest.fn().mockResolvedValue(0),
    });

    prisma.systemSetting.findUnique.mockResolvedValue(null);
    prisma.newsSource.findMany.mockResolvedValue([]);

    const summary = await service.getSummary({
      orgId: "org-1",
      window: "24h",
    });

    expect(summary.totalItems).toBe(2);
    expect(ProcessedItemModel.aggregate).toHaveBeenCalledTimes(1);
    expect(TaskLogModel.aggregate).toHaveBeenCalledTimes(2);
    expect(ProcessedItemModel.find).not.toHaveBeenCalled();
    expect(ProcessedItemModel.countDocuments).not.toHaveBeenCalled();
    expect(TaskLogModel.find).not.toHaveBeenCalled();
    expect(TaskLogModel.countDocuments).not.toHaveBeenCalled();

    const processedPipeline = (ProcessedItemModel.aggregate as jest.Mock).mock.calls[0]?.[0] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(processedPipeline?.[1]).toEqual(
      expect.objectContaining({
        $facet: expect.objectContaining({
          total: expect.any(Array),
          sampled: expect.any(Array),
        }),
      }),
    );
  });

  it("reports totalItems from matched facet count when sampled docs are fewer", async () => {
    const { service, prisma } = createService();

    (ProcessedItemModel.aggregate as jest.Mock).mockResolvedValue([
      {
        total: [{ count: 10 }],
        sampled: [
          {
            _id: "processed-1",
            sourceId: "source-1",
            createdAt: new Date("2025-01-01T00:00:00.000Z"),
            result: {
              category_confidence: 0.25,
              category_method: "llm-embedding-rerank",
              category_path: "tech/ai",
            },
          },
          {
            _id: "processed-2",
            sourceId: "source-2",
            createdAt: new Date("2025-01-01T00:10:00.000Z"),
            result: {
              category_confidence: 0.75,
              category_method: "rule-fallback",
              category_path: "finance/regulation",
            },
          },
        ],
      },
    ]);
    (TaskLogModel.aggregate as jest.Mock)
      .mockResolvedValueOnce([
        {
          total: [{ count: 1 }],
          sampled: [{ data: { llmLatencyMs: 150, embeddingLatencyMs: 30, rerankLatencyMs: 45 } }],
        },
      ])
      .mockResolvedValueOnce([
        {
          total: [{ count: 1 }],
          sampled: [{ data: { decision: "accepted" } }],
        },
      ]);
    (ClassificationReviewModel.countDocuments as jest.Mock).mockReturnValue({
      exec: jest.fn().mockResolvedValue(0),
    });

    prisma.systemSetting.findUnique.mockResolvedValue(null);
    prisma.newsSource.findMany.mockResolvedValue([]);

    const summary = await service.getSummary({
      orgId: "org-1",
      window: "24h",
    });

    expect(summary.totalItems).toBe(10);
    expect(summary.methodDistribution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "llm_embedding_rerank",
          count: 1,
          share: 0.5,
        }),
        expect.objectContaining({
          group: "rule_fallback",
          count: 1,
          share: 0.5,
        }),
      ]),
    );
    expect(summary.sampling.classifiedItems).toEqual(
      expect.objectContaining({
        matched: 10,
        scanned: 2,
      }),
    );
  });

  it("uses a lowercase anchored prefix regex and the reduced summary sample limit", async () => {
    const { service, prisma } = createService();

    (ProcessedItemModel.aggregate as jest.Mock).mockResolvedValueOnce([
      {
        total: [{ count: 5 }],
        sampled: [
          {
            _id: "processed-1",
            sourceId: "source-1",
            createdAt: new Date("2025-01-01T00:00:00.000Z"),
            result: {
              category_confidence: 0.45,
              category_method: "llm-embedding-rerank",
              category_path: "tech/ai",
            },
          },
        ],
      },
    ]);
    (TaskLogModel.aggregate as jest.Mock)
      .mockResolvedValueOnce([
        {
          total: [{ count: 0 }],
          sampled: [],
        },
      ])
      .mockResolvedValueOnce([
        {
          total: [{ count: 0 }],
          sampled: [],
        },
      ]);
    (ClassificationReviewModel.countDocuments as jest.Mock).mockReturnValue({
      exec: jest.fn().mockResolvedValue(0),
    });
    prisma.systemSetting.findUnique.mockResolvedValue(null);
    prisma.newsSource.findMany.mockResolvedValue([]);

    const summary = await service.getSummary({
      orgId: "org-1",
      window: "24h",
      categoryPrefix: "Tech/AI",
    });

    const pipeline = (ProcessedItemModel.aggregate as jest.Mock).mock.calls[0]?.[0] as
      | Record<string, unknown>[]
      | undefined;
    const matchStage = pipeline?.[0]?.$match as
      | { "result.category_path"?: { $regex?: RegExp } }
      | undefined;
    const sampledStage = (pipeline?.[1]?.$facet as { sampled?: Record<string, unknown>[] } | undefined)
      ?.sampled?.find((stage) => "$limit" in stage) as { $limit?: number } | undefined;

    expect(matchStage?.["result.category_path"]?.$regex).toBeInstanceOf(RegExp);
    expect(matchStage?.["result.category_path"]?.$regex?.source).toBe("^tech\\/ai(?:\\/|$)");
    expect(matchStage?.["result.category_path"]?.$regex?.flags).toBe("");
    expect(sampledStage?.$limit).toBe(3000);
    expect(summary.sampling.classifiedItems.limit).toBe(3000);
  });
});
