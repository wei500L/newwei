jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    aggregate: jest.fn(),
  },
}));

import { TaskLogModel } from "@modular/mongo";
import { AlertMetricProvider } from "@prisma/client";

import { CrawlMetricProvider } from "./crawl-metric.provider";

const mockedTaskLogAggregate = TaskLogModel.aggregate as jest.Mock;

describe("CrawlMetricProvider", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("keeps crawl task count metric behavior for crawl_task slug", async () => {
    const prisma = {
      crawlTask: {
        count: jest
          .fn()
          .mockResolvedValueOnce(5)
          .mockResolvedValueOnce(2),
      },
    } as any;
    const provider = new CrawlMetricProvider(prisma);

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.crawl_task,
      metricSlug: "crawl_task",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: { statuses: ["failed"] },
    });

    expect(prisma.crawlTask.count).toHaveBeenCalledTimes(2);
    expect(result.latest).toBe(5);
    expect(result.previous).toBe(2);
    expect(result.changePercent).toBe(150);
  });

  it("computes preflight failure rate from preflight task logs", async () => {
    mockedTaskLogAggregate.mockImplementation((pipeline?: Array<Record<string, unknown>>) => {
      const match = pipeline?.[0]?.$match as { stage?: string; createdAt?: { $lt?: Date } } | undefined;
      if (match?.stage !== "preflight") {
        return [];
      }
      if (match?.createdAt?.$lt) {
        return [{ runs: 2, failures: 0, http304Hits: 1 }];
      }
      return [{ runs: 3, failures: 1, http304Hits: 1 }];
    });
    const provider = new CrawlMetricProvider({} as any);

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.crawl_task,
      metricSlug: "crawl_quality.preflight_failure_rate",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: null,
    });

    expect(result.latest).toBeCloseTo(1 / 3, 5);
    expect(result.previous).toBe(0);
    expect(result.changePercent).toBeNull();
    expect(result.context).toMatchObject({
      latestCounts: { runs: 3, failures: 1, http304Hits: 1 },
      previousCounts: { runs: 2, failures: 0, http304Hits: 1 },
    });
    expect(mockedTaskLogAggregate).toHaveBeenCalledTimes(2);
  });

  it("computes http 304 hit rate and change percent", async () => {
    mockedTaskLogAggregate.mockImplementation((pipeline?: Array<Record<string, unknown>>) => {
      const match = pipeline?.[0]?.$match as { stage?: string; createdAt?: { $lt?: Date } } | undefined;
      if (match?.stage !== "preflight") {
        return [];
      }
      if (match?.createdAt?.$lt) {
        return [{ runs: 2, failures: 0, http304Hits: 1 }];
      }
      return [{ runs: 3, failures: 1, http304Hits: 1 }];
    });
    const provider = new CrawlMetricProvider({} as any);

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.crawl_task,
      metricSlug: "crawl_quality.http_304_hit_rate",
      operator: "lte" as any,
      changeWindowMin: 60,
      metadata: null,
    });

    expect(result.latest).toBeCloseTo(1 / 3, 5);
    expect(result.previous).toBe(0.5);
    expect(result.changePercent).toBeCloseTo(-33.3333, 3);
  });

  it("computes org hash dedupe hit rate from dedupe logs", async () => {
    mockedTaskLogAggregate.mockImplementation((pipeline?: Array<Record<string, unknown>>) => {
      const match = pipeline?.[0]?.$match as { stage?: string; createdAt?: { $lt?: Date } } | undefined;
      if (match?.stage !== "dedupe") {
        return [];
      }
      if (match?.createdAt?.$lt) {
        return [{ evaluatedCount: 8, orgReuseCount: 4 }];
      }
      return [{ evaluatedCount: 20, orgReuseCount: 5 }];
    });
    const provider = new CrawlMetricProvider({} as any);

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.crawl_task,
      metricSlug: "crawl_quality.org_hash_dedupe_hit_rate",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: null,
    });

    expect(result.latest).toBe(0.25);
    expect(result.previous).toBe(0.5);
    expect(result.changePercent).toBe(-50);
  });

  it("returns null when rate denominator is zero", async () => {
    mockedTaskLogAggregate.mockReturnValue([]);
    const provider = new CrawlMetricProvider({} as any);

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.crawl_task,
      metricSlug: "crawl_quality.http_304_hit_rate",
      operator: "lte" as any,
      changeWindowMin: 60,
      metadata: null,
    });

    expect(result.latest).toBeNull();
    expect(result.previous).toBeNull();
    expect(result.changePercent).toBeNull();
  });

  it("returns metric_slug_missing for blank metric slug", async () => {
    const prisma = {
      crawlTask: {
        count: jest.fn(),
      },
    } as any;
    const provider = new CrawlMetricProvider(prisma);

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.crawl_task,
      metricSlug: "   ",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: null,
    });

    expect(prisma.crawlTask.count).not.toHaveBeenCalled();
    expect(result).toEqual({
      latest: null,
      previous: null,
      changePercent: null,
      context: { error: "metric_slug_missing" },
    });
  });
});
