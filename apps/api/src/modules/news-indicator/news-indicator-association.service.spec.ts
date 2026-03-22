import { NewsIndicatorFeatureMetric } from "@prisma/client";

import { NewsIndicatorAssociationService } from "./news-indicator-association.service";
import * as math from "./news-indicator-math";
import type { NewsIndicatorAssociationSettings } from "./news-indicator-settings.service";

jest.mock("./news-indicator-math", () => {
  const actual = jest.requireActual("./news-indicator-math");
  return {
    ...actual,
    buildDailyEconomicValues: jest.fn(),
    buildDailyReturns: jest.fn(),
    computeBestLagCorrelation: jest.fn(),
    runBacktest: jest.fn()
  };
});

const mockBuildDailyEconomicValues = math.buildDailyEconomicValues as jest.MockedFunction<
  typeof math.buildDailyEconomicValues
>;
const mockBuildDailyReturns = math.buildDailyReturns as jest.MockedFunction<typeof math.buildDailyReturns>;
const mockComputeBestLagCorrelation = math.computeBestLagCorrelation as jest.MockedFunction<
  typeof math.computeBestLagCorrelation
>;
const mockRunBacktest = math.runBacktest as jest.MockedFunction<typeof math.runBacktest>;

const defaultSettings: NewsIndicatorAssociationSettings = {
  enabled: true,
  ingestionEnabled: true,
  windowDays: 30,
  maxLagDays: 7,
  minSampleSize: 10,
  minAbsCorrelation: 0.2,
  maxPValue: 0.2,
  topEntities: 50,
  topTopics: 50,
  maxAssociationsPerIndicator: 20,
  indicatorSlugs: ["cpi", "ppi"],
  backtestTriggerZScore: 2,
  backtestBaselineDays: 10,
  backtestHoldoutDays: 5,
  cacheTtlSeconds: 120
};

function createDailySeries() {
  return new Map<number, number>([
    [Date.UTC(2026, 1, 1), 100],
    [Date.UTC(2026, 1, 2), 101]
  ]);
}

function createEntitySeries(entityNames: string[], metrics?: NewsIndicatorFeatureMetric[]) {
  const selectedMetrics =
    metrics ??
    [
      NewsIndicatorFeatureMetric.volume,
      NewsIndicatorFeatureMetric.avg_score,
      NewsIndicatorFeatureMetric.negative_ratio
    ];

  const series = new Map<string, Map<NewsIndicatorFeatureMetric, ReturnType<typeof createDailySeries>>>();
  for (const entityName of entityNames) {
    const seriesByMetric = new Map<NewsIndicatorFeatureMetric, ReturnType<typeof createDailySeries>>();
    for (const metric of selectedMetrics) {
      seriesByMetric.set(metric, createDailySeries());
    }
    series.set(`${entityName}::company`, seriesByMetric);
  }

  return series;
}

function createService(options?: {
  settings?: Partial<NewsIndicatorAssociationSettings>;
  entitySeries?: ReturnType<typeof createEntitySeries>;
  topicSeries?: Map<string, Map<NewsIndicatorFeatureMetric, ReturnType<typeof createDailySeries>>>;
}) {
  const prisma = {
    economicDataItem: {
      findMany: jest.fn()
    },
    economicDataPoint: {
      findMany: jest.fn()
    },
    newsIndicatorAssociation: {
      upsert: jest.fn()
    },
    newsIndicatorAssociationBacktestRun: {
      createMany: jest.fn().mockResolvedValue({ count: 0 })
    },
    $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations))
  };

  const settingsService = {
    getSettings: jest.fn().mockResolvedValue({
      ...defaultSettings,
      ...options?.settings
    })
  };

  const service = new NewsIndicatorAssociationService(prisma as any, settingsService as any);
  const entitySeries = options?.entitySeries ?? new Map();
  const topicSeries = options?.topicSeries ?? new Map();

  jest.spyOn(service as any, "loadTopEntityKeys").mockResolvedValue(
    Array.from(entitySeries.keys()).map((key) => {
      const [entityName, entityType = ""] = key.split("::");
      return { entityName, entityType };
    })
  );
  jest.spyOn(service as any, "loadTopTopicKeys").mockResolvedValue(
    Array.from(topicSeries.keys()).map((topic) => ({ topic }))
  );
  jest.spyOn(service as any, "loadEntityFeatureSeries").mockResolvedValue(entitySeries);
  jest.spyOn(service as any, "loadTopicFeatureSeries").mockResolvedValue(topicSeries);

  return { service, prisma, settingsService };
}

describe("NewsIndicatorAssociationService.refreshOrg", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-03-20T12:00:00.000Z"));
    jest.clearAllMocks();

    mockBuildDailyEconomicValues.mockImplementation(() => createDailySeries());
    mockBuildDailyReturns.mockImplementation(() => createDailySeries());
    mockComputeBestLagCorrelation.mockImplementation(() => ({
      best: {
        lagDays: 1,
        correlation: 0.81,
        pValue: 0.01,
        sampleSize: 24
      },
      all: [
        {
          lagDays: 1,
          correlation: 0.81,
          pValue: 0.01,
          sampleSize: 24
        }
      ]
    }));
    mockRunBacktest.mockImplementation(() => ({
      samples: 10,
      triggers: 3,
      evaluatedSignals: 2,
      hits: 1,
      hitRate: 0.5,
      avgSignedReturn: 0.02,
      totalSignedReturn: 0.04,
      baselineDays: 10
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("batch loads indicator points once and groups them by item for downstream evaluation", async () => {
    const { service, prisma } = createService({
      entitySeries: createEntitySeries(["Fed"], [NewsIndicatorFeatureMetric.volume])
    });

    prisma.economicDataItem.findMany.mockResolvedValue([
      { id: "indicator-1", slug: "cpi" },
      { id: "indicator-2", slug: "ppi" }
    ]);
    prisma.economicDataPoint.findMany.mockResolvedValue([
      {
        id: "point-1",
        itemId: "indicator-1",
        recordedAt: new Date("2026-03-01T00:00:00.000Z"),
        value: "100.1"
      },
      {
        id: "point-2",
        itemId: "indicator-1",
        recordedAt: new Date("2026-03-02T00:00:00.000Z"),
        value: "100.3"
      },
      {
        id: "point-3",
        itemId: "indicator-2",
        recordedAt: new Date("2026-03-03T00:00:00.000Z"),
        value: "99.8"
      }
    ]);

    prisma.newsIndicatorAssociation.upsert.mockImplementation(async () => ({
      id: `assoc-${prisma.newsIndicatorAssociation.upsert.mock.calls.length}`
    }));

    const result = await service.refreshOrg("org-1");

    expect(prisma.economicDataPoint.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.economicDataPoint.findMany).toHaveBeenCalledWith({
      where: {
        itemId: { in: ["indicator-1", "indicator-2"] },
        recordedAt: {
          gte: new Date("2026-02-18T00:00:00.000Z"),
          lte: new Date("2026-03-20T00:00:00.000Z")
        }
      },
      select: { id: true, itemId: true, recordedAt: true, value: true },
      orderBy: [{ itemId: "asc" }, { recordedAt: "asc" }, { id: "asc" }]
    });

    expect(mockBuildDailyEconomicValues).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([
        expect.objectContaining({ id: "point-1" }),
        expect.objectContaining({ id: "point-2" })
      ])
    );
    expect(mockBuildDailyEconomicValues).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([expect.objectContaining({ id: "point-3" })])
    );

    expect(prisma.newsIndicatorAssociation.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.newsIndicatorAssociationBacktestRun.createMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ indicators: 2, associationsUpserted: 2, backtestsCreated: 2 });
  });

  it("chunks association upserts and backtest inserts in batches of one hundred", async () => {
    const { service, prisma } = createService({
      settings: {
        indicatorSlugs: ["cpi"],
        maxAssociationsPerIndicator: 101
      },
      entitySeries: createEntitySeries(Array.from({ length: 34 }, (_, index) => `Entity ${index + 1}`))
    });

    prisma.economicDataItem.findMany.mockResolvedValue([{ id: "indicator-1", slug: "cpi" }]);
    prisma.economicDataPoint.findMany.mockResolvedValue([
      {
        id: "point-1",
        itemId: "indicator-1",
        recordedAt: new Date("2026-03-01T00:00:00.000Z"),
        value: "100"
      }
    ]);

    let sequence = 0;
    prisma.newsIndicatorAssociation.upsert.mockImplementation(async () => {
      sequence += 1;
      return { id: `assoc-${sequence}` };
    });

    const result = await service.refreshOrg("org-1");

    expect(prisma.newsIndicatorAssociation.upsert).toHaveBeenCalledTimes(101);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.newsIndicatorAssociationBacktestRun.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.newsIndicatorAssociationBacktestRun.createMany).toHaveBeenNthCalledWith(1, {
      data: expect.arrayContaining([
        expect.objectContaining({ associationId: "assoc-1" }),
        expect.objectContaining({ associationId: "assoc-100" })
      ])
    });
    expect(prisma.newsIndicatorAssociationBacktestRun.createMany).toHaveBeenNthCalledWith(2, {
      data: [expect.objectContaining({ associationId: "assoc-101" })]
    });
    expect(result).toEqual({ indicators: 1, associationsUpserted: 101, backtestsCreated: 101 });
  });

  it("skips all writes when no candidate passes correlation filtering", async () => {
    const { service, prisma } = createService({
      entitySeries: createEntitySeries(["Fed"], [NewsIndicatorFeatureMetric.volume])
    });

    prisma.economicDataItem.findMany.mockResolvedValue([{ id: "indicator-1", slug: "cpi" }]);
    prisma.economicDataPoint.findMany.mockResolvedValue([
      {
        id: "point-1",
        itemId: "indicator-1",
        recordedAt: new Date("2026-03-01T00:00:00.000Z"),
        value: "100"
      }
    ]);
    mockComputeBestLagCorrelation.mockImplementation(() => ({
      best: null,
      all: []
    }));

    const result = await service.refreshOrg("org-1");

    expect(prisma.newsIndicatorAssociation.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.newsIndicatorAssociationBacktestRun.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ indicators: 1, associationsUpserted: 0, backtestsCreated: 0 });
  });
});
