const mongoFindMock = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: mongoFindMock,
  },
}));

import { DashboardChartsService } from "../dashboard-charts.service";

describe("DashboardChartsService.getSpacetimeGeoHeatmap", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createSerializingCache = () => {
    const store = new Map<string, string>();
    return {
      get: jest.fn(),
      set: jest.fn(),
      wrap: jest.fn(
        async (
          key: string,
          _ttlSeconds: number,
          loader: () => Promise<unknown>,
        ) => {
          const cached = store.get(key);
          if (cached) {
            return JSON.parse(cached);
          }
          const value = await loader();
          const serialized = JSON.stringify(value);
          store.set(key, serialized);
          return JSON.parse(serialized);
        },
      ),
    };
  };

  it("aggregates geo heat points with sentiment distribution", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            location: "Paris, France",
            cleanedMarkdownRef: "p1",
            publishedAt: new Date("2026-01-10T00:00:00.000Z"),
            processedAt: new Date("2026-01-10T00:00:00.000Z"),
            article: { crawlAt: new Date("2026-01-10T00:00:00.000Z") },
          },
          {
            location: "Paris",
            cleanedMarkdownRef: "p2",
            publishedAt: new Date("2026-01-10T00:00:00.000Z"),
            processedAt: new Date("2026-01-10T00:00:00.000Z"),
            article: { crawlAt: new Date("2026-01-10T00:00:00.000Z") },
          },
        ]),
      },
    } as any;

    mongoFindMock.mockReturnValue({
      lean: () => ({
        exec: async () => [
          {
            _id: { toHexString: () => "p1" },
            result: { sentiment_label: "positive" },
          },
          {
            _id: { toHexString: () => "p2" },
            result: { sentiment_label: "negative" },
          },
        ],
      }),
    });

    const geocoding = {
      resolveCandidates: jest.fn().mockResolvedValue({
        lat: 48.8566,
        lng: 2.3522,
        displayName: "Paris",
      }),
    } as any;

    const service = new DashboardChartsService(prisma, geocoding, {
      get: jest.fn(),
      set: jest.fn(),
      wrap: jest.fn(
        async (
          _key: string,
          _ttlSeconds: number,
          loader: () => Promise<unknown>,
        ) => loader(),
      ),
    } as any);

    const result = await service.getSpacetimeGeoHeatmap(
      {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-10T00:00:00.000Z"),
      } as any,
      "org-1",
    );

    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(1);
    expect(mongoFindMock).toHaveBeenCalledWith(
      { _id: { $in: ["p1", "p2"] }, orgId: "org-1", status: "completed" },
      { _id: 1, result: 1 },
    );
    expect(geocoding.resolveCandidates).toHaveBeenCalled();

    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({
      name: "Paris",
      total: 2,
      sentiment: {
        positive: 1,
        neutral: 0,
        negative: 1,
        unknown: 0,
      },
    });
    expect(typeof result.snapshotId).toBe("string");
    expect(result.snapshotId).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(result.updatedAt).toBe("2026-01-10T00:00:00.000Z");
  });

  it("rehydrates shared query cache rows after JSON serialization", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            location: "Paris, France",
            cleanedMarkdownRef: "p1",
            eventAt: new Date("2026-01-10T00:00:00.000Z"),
            processedAt: new Date("2026-01-10T00:00:00.000Z"),
          },
        ]),
      },
    } as any;

    mongoFindMock.mockReturnValue({
      lean: () => ({
        exec: async () => [
          {
            _id: { toHexString: () => "p1" },
            result: { sentiment_label: "positive" },
          },
        ],
      }),
    });

    const geocoding = {
      resolveCandidates: jest.fn().mockResolvedValue({
        lat: 48.8566,
        lng: 2.3522,
        displayName: "Paris",
      }),
    } as any;

    const service = new DashboardChartsService(
      prisma,
      geocoding,
      createSerializingCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-10T00:00:00.000Z"),
    } as any;

    const first = await service.getSpacetimeGeoHeatmap(range, "org-1");
    const second = await service.getSpacetimeGeoHeatmap(range, "org-1");

    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(1);
    expect(first.updatedAt).toBe("2026-01-10T00:00:00.000Z");
    expect(second.updatedAt).toBe("2026-01-10T00:00:00.000Z");
    expect(second.points[0]).toMatchObject({
      name: "Paris",
      total: 1,
    });
  });
});
