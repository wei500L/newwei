const mongoFindMock = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: mongoFindMock
  }
}));

import { DashboardChartsService } from "../dashboard-charts.service";

describe("DashboardChartsService.getSpacetimeGeoHeatmapArticles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const range = {
    start: new Date("2026-01-01T00:00:00.000Z"),
    end: new Date("2026-01-10T23:59:59.999Z")
  } as any;

  it("returns drilldown articles from snapshot mapping without repeating geocode", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "a1",
            title: "Paris story 1",
            location: "Paris, France",
            cleanedMarkdownRef: "p1",
            publishedAt: new Date("2026-01-10T12:00:00.000Z"),
            processedAt: new Date("2026-01-10T12:30:00.000Z"),
            article: {
              url: "https://example.com/a1",
              sourceLabel: "Example",
              crawlAt: new Date("2026-01-10T12:10:00.000Z")
            }
          },
          {
            id: "a2",
            title: "Paris story 2",
            location: "Paris",
            cleanedMarkdownRef: "p2",
            publishedAt: new Date("2026-01-09T12:00:00.000Z"),
            processedAt: new Date("2026-01-09T12:10:00.000Z"),
            article: {
              url: "https://example.com/a2",
              sourceLabel: "Example",
              crawlAt: new Date("2026-01-09T12:05:00.000Z")
            }
          }
        ])
      }
    } as any;

    const snapshotId = "snap-1";
    const cache = {
      get: jest.fn().mockResolvedValue({
        v: 1,
        orgId: "org-1",
        eventId: null,
        rangeStart: "2026-01-01T00:00:00.000Z",
        rangeEnd: "2026-01-10T23:59:59.999Z",
        pointToLocationKeys: {
          "49.000:2.500": ["Paris"]
        }
      }),
      set: jest.fn()
    };

    mongoFindMock.mockReturnValue({
      lean: () => ({
        exec: async () => [
          { _id: { toHexString: () => "p1" }, result: { sentiment_label: "positive" } },
          { _id: { toHexString: () => "p2" }, result: { sentiment_label: "negative" } }
        ]
      })
    });

    const geocoding = {
      resolveCandidates: jest.fn()
    } as any;

    const service = new DashboardChartsService(prisma, geocoding, cache as any);

    const result = await service.getSpacetimeGeoHeatmapArticles(range, "org-1", {
      snapshotId,
      pointId: "49:2.5"
    });

    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenCalledWith("dashboard:spacetime:geo-heatmap:snapshot:org-1:snap-1");
    expect(geocoding.resolveCandidates).not.toHaveBeenCalled();

    expect(result.pointId).toBe("49.000:2.500");
    expect(result.articles).toHaveLength(2);
    expect(result.articles[0]).toMatchObject({
      id: "a1",
      title: "Paris story 1",
      url: "https://example.com/a1",
      sourceLabel: "Example",
      sentiment: "positive"
    });
    expect(result.articles[1]).toMatchObject({
      id: "a2",
      title: "Paris story 2",
      url: "https://example.com/a2",
      sourceLabel: "Example",
      sentiment: "negative"
    });
    expect(result.hasMore).toBe(false);
  });

  it("falls back to geocoding when snapshotId is not provided", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "a1",
            title: "Paris story 1",
            location: "Paris, France",
            cleanedMarkdownRef: "p1",
            publishedAt: new Date("2026-01-10T12:00:00.000Z"),
            processedAt: new Date("2026-01-10T12:30:00.000Z"),
            article: {
              url: "https://example.com/a1",
              sourceLabel: "Example",
              crawlAt: new Date("2026-01-10T12:10:00.000Z")
            }
          }
        ])
      }
    } as any;

    const cache = { get: jest.fn(), set: jest.fn() };

    mongoFindMock.mockReturnValue({
      lean: () => ({
        exec: async () => [{ _id: { toHexString: () => "p1" }, result: { sentiment_label: "positive" } }]
      })
    });

    const geocoding = {
      resolveCandidates: jest.fn().mockResolvedValue({
        lat: 48.8566,
        lng: 2.3522,
        displayName: "Paris"
      })
    } as any;

    const service = new DashboardChartsService(prisma, geocoding, cache as any);

    const result = await service.getSpacetimeGeoHeatmapArticles(range, "org-1", {
      pointId: "49:2.5"
    });

    expect(geocoding.resolveCandidates).toHaveBeenCalled();
    expect(result.articles).toHaveLength(1);
  });
});

