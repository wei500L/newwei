jest.mock("@modular/mongo", () => ({
  TaskLogModel: {
    find: jest.fn(),
  },
}));

import { TaskLogModel } from "@modular/mongo";
import { AlertMetricProvider } from "@prisma/client";

import { CrawlMetricProvider } from "./crawl-metric.provider";

const mockedTaskLogFind = TaskLogModel.find as jest.Mock;

const mockFindChain = (docs: unknown[]) => ({
  select: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue(docs),
  }),
});

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
    mockedTaskLogFind.mockImplementation((query?: { stage?: string; createdAt?: { $lt?: Date } }) => {
      if (query?.stage !== "preflight") {
        return mockFindChain([]);
      }
      if (query?.createdAt?.$lt) {
        return mockFindChain([
          { status: "completed", data: { status: 304 } },
          { status: "completed", data: { status: 200 } },
        ]);
      }
      return mockFindChain([
        { status: "completed", data: { status: 304 } },
        { status: "failed", data: {} },
        { status: "completed", data: { status: 200 } },
      ]);
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
  });

  it("computes http 304 hit rate and change percent", async () => {
    mockedTaskLogFind.mockImplementation((query?: { stage?: string; createdAt?: { $lt?: Date } }) => {
      if (query?.stage !== "preflight") {
        return mockFindChain([]);
      }
      if (query?.createdAt?.$lt) {
        return mockFindChain([
          { status: "completed", data: { status: 304 } },
          { status: "completed", data: { status: 200 } },
        ]);
      }
      return mockFindChain([
        { status: "completed", data: { status: 304 } },
        { status: "failed", data: {} },
        { status: "completed", data: { status: 200 } },
      ]);
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
    mockedTaskLogFind.mockImplementation((query?: { stage?: string; createdAt?: { $lt?: Date } }) => {
      if (query?.stage !== "dedupe") {
        return mockFindChain([]);
      }
      if (query?.createdAt?.$lt) {
        return mockFindChain([
          { data: { evaluatedCount: 8, orgReuseCount: 4 } },
        ]);
      }
      return mockFindChain([
        { data: { evaluatedCount: 10, orgReuseCount: 4 } },
        { data: { evaluatedCount: 10, orgReuseCount: 1 } },
      ]);
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
    mockedTaskLogFind.mockReturnValue(mockFindChain([]));
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
});
