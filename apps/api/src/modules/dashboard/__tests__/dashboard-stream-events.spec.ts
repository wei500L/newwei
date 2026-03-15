import { DashboardController } from "../dashboard.controller";

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("dashboard stream war-map events", () => {
  const originalInterval = process.env.DASHBOARD_STREAM_INTERVAL_MS;
  const originalPing = process.env.DASHBOARD_STREAM_PING_MS;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.DASHBOARD_STREAM_INTERVAL_MS = "1000";
    process.env.DASHBOARD_STREAM_PING_MS = "60000";
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env.DASHBOARD_STREAM_INTERVAL_MS = originalInterval;
    process.env.DASHBOARD_STREAM_PING_MS = originalPing;
  });

  it("publishes dedicated war-map news and layer events when those fingerprints change", async () => {
    const chartsService = {
      resolveRange: jest.fn().mockReturnValue({
        start: new Date("2026-03-01T00:00:00.000Z"),
        end: new Date("2026-03-02T00:00:00.000Z"),
      }),
      getWarMapEvents: jest
        .fn()
        .mockResolvedValue({
          updatedAt: "2026-03-01T01:00:00.000Z",
          events: [
            {
              id: "usa",
              name: "United States",
              lat: 38,
              lng: -95,
              severity: "low",
            },
          ],
        }),
      getWarMapNewsMarkers: jest
        .fn()
        .mockResolvedValueOnce({
          updatedAt: "2026-03-01T01:00:00.000Z",
          markers: [
            {
              id: "news-1",
              title: "Initial",
              location: "Washington",
              lat: 38.9,
              lng: -77,
              geoSource: "geocoded",
            },
          ],
        })
        .mockResolvedValueOnce({
          updatedAt: "2026-03-01T01:05:00.000Z",
          markers: [
            {
              id: "news-2",
              title: "Updated",
              location: "Washington",
              lat: 38.9,
              lng: -77,
              geoSource: "geocoded",
            },
          ],
        }),
      getWarMapLayers: jest
        .fn()
        .mockResolvedValueOnce({
          updatedAt: "2026-03-01T01:00:00.000Z",
          layers: {
            conflicts: {
              layerId: "conflicts",
              geometryType: "polygon",
              features: [{ id: "feature-a", polygon: [] }],
            },
          },
        })
        .mockResolvedValueOnce({
          updatedAt: "2026-03-01T01:05:00.000Z",
          layers: {
            conflicts: {
              layerId: "conflicts",
              geometryType: "polygon",
              features: [{ id: "feature-b", polygon: [] }],
            },
          },
        }),
      getFinancialCandlestick: jest.fn().mockResolvedValue({
        symbol: "sp500_index",
        interval: "1d",
        points: [],
      }),
      getSpacetimeGeoHeatmap: jest.fn().mockResolvedValue(null),
    };

    const controller = new DashboardController({} as never, chartsService as never);
    const messages: Array<{ type?: string; data?: unknown }> = [];

    const subscription = controller
      .dashboardStream({ orgId: "org-1" } as never, {} as never)
      .subscribe((message) => {
        messages.push(message as { type?: string; data?: unknown });
      });

    await flushMicrotasks();

    expect(messages.map((message) => message.type)).toEqual(
      expect.arrayContaining([
        "war-map-events",
        "war-map-news-markers",
        "war-map-layers",
      ]),
    );

    messages.length = 0;

    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(messages.map((message) => message.type)).toEqual(
      expect.arrayContaining(["war-map-news-markers", "war-map-layers"]),
    );
    expect(messages.map((message) => message.type)).not.toContain("war-map-events");

    subscription.unsubscribe();
  });
});
