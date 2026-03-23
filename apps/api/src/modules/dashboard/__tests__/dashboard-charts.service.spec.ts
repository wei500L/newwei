import { InternalServerErrorException } from "@nestjs/common";
import { ProcessedArticleStatus } from "@prisma/client";

import { DashboardChartsService } from "../dashboard-charts.service";

const processedItemFindExecMock = jest.fn().mockResolvedValue([]);

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        limit: jest.fn(() => ({
          lean: jest.fn(() => ({
            exec: processedItemFindExecMock,
          })),
        })),
      })),
    })),
    findOne: jest.fn(() => ({
      sort: jest.fn(() => ({
        lean: jest.fn(() => ({
          exec: jest.fn().mockResolvedValue(null),
        })),
      })),
    })),
    countDocuments: jest.fn().mockResolvedValue(0),
  },
  RawItemModel: {},
}));

const createCache = () => ({
  get: jest.fn(),
  set: jest.fn(),
  wrap: jest.fn(
    async (_key: string, _ttlSeconds: number, loader: () => Promise<unknown>) =>
      loader(),
  ),
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

const createRealtimeSignalsStore = (
  overrides: Record<string, unknown> = {},
) => ({
  getLatestAdsbSnapshot: jest.fn().mockResolvedValue(null),
  getLatestAisSnapshot: jest.fn().mockResolvedValue(null),
  getSourceState: jest.fn().mockResolvedValue(null),
  ...overrides,
});

describe("DashboardChartsService", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves aligned UTC day range by default", () => {
    const service = new DashboardChartsService(
      {} as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
    );

    const range = service.resolveRange({
      start: "2026-03-02T10:15:00.000Z",
      end: "2026-03-03T08:45:30.123Z",
    });

    expect(range.start.toISOString()).toBe("2026-03-02T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-03T23:59:59.999Z");
  });

  it("preserves sub-day precision when day alignment is disabled", () => {
    const service = new DashboardChartsService(
      {} as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
    );

    const range = service.resolveRange(
      {
        start: "2026-03-02T10:15:00.000Z",
        end: "2026-03-03T08:45:30.123Z",
      },
      { alignToUtcDay: false },
    );

    expect(range.start.toISOString()).toBe("2026-03-02T10:15:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-03T08:45:30.123Z");
  });

  it("filters war map news markers by orgId/eventAt on the processed article read model", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    await service.getWarMapNewsMarkers(range, "org-1");

    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.processedArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: "org-1",
          status: ProcessedArticleStatus.completed,
          hasLocation: true,
          eventAt: {
            gte: range.start,
            lte: range.end,
          },
        }),
      }),
    );
  });

  it("does not fabricate publishedAt from eventAt fallback in war map news markers", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "marker-1",
            title: "Fallback headline",
            location: "Tokyo",
            publishedAt: null,
            eventAt: new Date("2026-01-01T12:00:00.000Z"),
            processedAt: new Date("2026-01-01T12:05:00.000Z"),
            entities: [],
            article: {
              url: "https://example.com/news/1",
              crawlAt: new Date("2026-01-01T12:01:00.000Z"),
              titleGuess: null,
            },
          },
        ]),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn().mockResolvedValue({
        lat: 35.6762,
        lng: 139.6503,
        displayName: "Tokyo, Japan",
      }),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const result = await service.getWarMapNewsMarkers(
      {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-02T00:00:00.000Z"),
      },
      "org-1",
    );

    expect(result.markers[0]).toMatchObject({
      id: "marker-1",
      publishedAt: undefined,
      ingestedAt: "2026-01-01T12:01:00.000Z",
    });
    expect(result.updatedAt).toBe("2026-01-01T12:00:00.000Z");
  });

  it("filters war map events by orgId/eventAt on the processed article read model", async () => {
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    await service.getWarMapEvents(range, "org-1");

    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.processedArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: "org-1",
          status: ProcessedArticleStatus.completed,
          hasLocation: true,
          eventAt: {
            gte: range.start,
            lte: range.end,
          },
        }),
      }),
    );
  });

  it("uses situation monitor translation service for war map marker titles when zh-CN translation is requested", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "marker-1",
            title: "Example headline",
            location: "San Francisco",
            publishedAt: new Date("2026-01-01T12:00:00.000Z"),
            processedAt: new Date("2026-01-01T12:05:00.000Z"),
            entities: [],
            article: {
              url: "https://example.com/news/1",
              crawlAt: new Date("2026-01-01T12:01:00.000Z"),
              titleGuess: null,
            },
          },
        ]),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn().mockResolvedValue({
        lat: 37.7749,
        lng: -122.4194,
        displayName: "San Francisco, United States",
      }),
    };
    const translation = {
      translateTextsToZhBestEffort: jest.fn().mockResolvedValue(
        new Map([
          ["Example headline", "示例标题"],
          ["San Francisco", "旧金山"],
          ["San Francisco, United States", "旧金山，美国"],
        ]),
      ),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
      translation as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    const result = await service.getWarMapNewsMarkers(range, "org-1", {
      translateTarget: "zh-CN",
    });

    expect(translation.translateTextsToZhBestEffort).toHaveBeenCalledTimes(1);
    expect(result.markers[0]).toEqual(
      expect.objectContaining({
        id: "marker-1",
        title: "Example headline",
        titleZh: "示例标题",
        locationZh: "旧金山",
        displayNameZh: "旧金山，美国",
      }),
    );
  });

  it("uses situation monitor translation service for war map event names when zh-CN translation is requested", async () => {
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            triggeredAt: new Date("2026-01-01T12:00:00.000Z"),
            severity: "high",
            context: {
              countryCode: "USA",
            },
          },
        ]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const translation = {
      translateTextsToZhBestEffort: jest
        .fn()
        .mockImplementation(async (texts: Iterable<string>) => {
          const entries = Array.from(
            texts,
            (text) => [text, `中文-${text}`] as const,
          );
          return new Map(entries);
        }),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
      translation as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    const result = await service.getWarMapEvents(range, "org-1", {
      translateTarget: "zh-CN",
    });

    expect(translation.translateTextsToZhBestEffort).toHaveBeenCalledTimes(1);
    expect(result.events[0]).toEqual(
      expect.objectContaining({
        nameZh: `中文-${result.events[0].name}`,
      }),
    );
  });

  it("uses situation monitor translation service for war map static layers when zh-CN translation is requested", async () => {
    const prisma = {};
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const translation = {
      translateTextsToZhBestEffort: jest
        .fn()
        .mockImplementation(async (texts: Iterable<string>) => {
          const entries = Array.from(
            texts,
            (text) => [text, `中文-${text}`] as const,
          );
          return new Map(entries);
        }),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
      translation as any,
    );

    const translated = await service.getWarMapLayers({
      translateTarget: "zh-CN",
    });
    const plain = await service.getWarMapLayers();

    expect(translation.translateTextsToZhBestEffort).toHaveBeenCalledTimes(1);
    expect(translated.hotspots[0]).toEqual(
      expect.objectContaining({
        nameZh: `中文-${translated.hotspots[0].name}`,
        descriptionZh: `中文-${translated.hotspots[0].description}`,
      }),
    );
    expect(plain.hotspots.some((item) => typeof item.nameZh === "string")).toBe(
      false,
    );
    expect(
      plain.hotspots.some((item) => typeof item.descriptionZh === "string"),
    ).toBe(false);
    const translatedHotspotFeature = translated.layers.hotspots.features[0];
    const translatedProps =
      translatedHotspotFeature?.properties &&
      typeof translatedHotspotFeature.properties === "object"
        ? (translatedHotspotFeature.properties as Record<string, unknown>)
        : {};
    expect(typeof translatedProps.nameZh).toBe("string");
    expect(typeof translatedProps.descriptionZh).toBe("string");
  });

  it("enriches war map layers from realtime backend signals when org/range are provided", async () => {
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            triggeredAt: new Date("2026-01-01T11:00:00.000Z"),
            severity: "high",
            context: {
              countryCode: "USA",
            },
          },
        ]),
      },
      processedArticle: {
        findMany: jest.fn().mockImplementation(async (args: any) => {
          const forNewsMarkers = Boolean(args?.select?.id);
          if (forNewsMarkers) {
            return [
              {
                id: "news-1",
                title: "Major cyber attack disrupts cloud region operations",
                location: "San Francisco, United States",
                publishedAt: new Date("2026-01-01T10:00:00.000Z"),
                processedAt: new Date("2026-01-01T10:05:00.000Z"),
                entities: [],
                article: {
                  url: "https://example.com/news/1",
                  crawlAt: new Date("2026-01-01T10:01:00.000Z"),
                  titleGuess: null,
                },
              },
            ];
          }
          return [
            {
              location: "United States",
              processedAt: new Date("2026-01-01T09:05:00.000Z"),
              publishedAt: new Date("2026-01-01T09:00:00.000Z"),
              article: {
                crawlAt: new Date("2026-01-01T09:01:00.000Z"),
              },
            },
          ];
        }),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn().mockResolvedValue({
        lat: 37.7749,
        lng: -122.4194,
        displayName: "San Francisco, United States",
      }),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    const response = await service.getWarMapLayers({
      orgId: "org-1",
      range,
    });

    expect(response.layers.cyberThreats.features.length).toBeGreaterThan(0);
    expect(response.layers.economic.features.length).toBeGreaterThan(0);
    expect(response.layers.cloudRegions.features.length).toBeGreaterThan(0);
    expect(
      response.layers.cyberThreats.features.some((feature) =>
        feature.id.includes("news-"),
      ),
    ).toBe(true);
  });

  it("builds the AIS military mode layer from candidate reports and disruptions", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:05:00.000Z"));
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const realtimeSignalsStore = createRealtimeSignalsStore({
      getLatestAisSnapshot: jest.fn().mockResolvedValue({
        source: "relay",
        sourceEndpoint: "https://relay.example.com/ais/snapshot",
        updatedAt: "2026-01-01T12:00:00.000Z",
        status: {
          connected: true,
          vessels: 42,
          messages: 1200,
          clients: 2,
          droppedMessages: 4,
        },
        disruptions: [
          {
            id: "gap-1",
            name: "AIS Gap Spike Detected",
            type: "gap_spike",
            lat: 0,
            lng: 0,
            severity: "elevated",
            darkShips: 2,
          },
        ],
        density: [
          {
            id: "density-1",
            lat: 12,
            lng: 24,
            intensity: 0.75,
            deltaPct: 10,
            shipsPerDay: 144,
          },
        ],
        candidateReports: [
          {
            mmsi: "123456789",
            name: "USS Example",
            lat: 30,
            lng: 40,
            shipType: 55,
            heading: 90,
            speed: 12,
            course: 95,
            observedAt: "2026-01-01T11:59:30.000Z",
          },
        ],
        vessels: [],
        hasVesselSnapshot: false,
      }),
      getSourceState: jest.fn().mockResolvedValue({
        source: "ais",
        status: "success",
        lastAttemptAt: "2026-01-01T12:00:00.000Z",
        lastSuccessAt: "2026-01-01T12:00:00.000Z",
        context: {
          configured: true,
          staleThresholdSec: 600,
        },
      }),
    });
    const service = new DashboardChartsService(
      prisma as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
      undefined,
      undefined,
      realtimeSignalsStore as any,
    );

    const response = await service.getWarMapLayers({
      orgId: "org-1",
      range: {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-02T00:00:00.000Z"),
      },
      aisMode: "military",
    });

    expect(realtimeSignalsStore.getLatestAisSnapshot).toHaveBeenCalledWith(
      "org-1",
    );
    expect(response.layers.ais.updatedAt).toBe("2026-01-01T12:00:00.000Z");
    expect(response.layers.ais.renderHints).toMatchObject({
      pickable: true,
      clusterable: false,
    });
    expect(response.layers.ais.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gap-1",
          properties: expect.objectContaining({
            sourceType: "ais",
            featureKind: "disruption",
            name: "AIS Gap Spike Detected",
            disruptionType: "gap_spike",
            severity: "medium",
            darkShips: 2,
          }),
        }),
        expect.objectContaining({
          id: "ais-vessel-123456789",
          lat: 30,
          lng: 40,
          timestamp: "2026-01-01T11:59:30.000Z",
          properties: expect.objectContaining({
            sourceType: "ais",
            featureKind: "vessel",
            mmsi: "123456789",
            name: "USS Example",
            shipType: 55,
            heading: 90,
            speed: 12,
            course: 95,
            observedAt: "2026-01-01T11:59:30.000Z",
          }),
        }),
      ]),
    );
    expect(
      response.layers.ais.features.some(
        (feature) =>
          (feature.properties as Record<string, unknown> | undefined)
            ?.featureKind === "density",
      ),
    ).toBe(false);
    expect(response.layers.ais.summary).toEqual(
      expect.objectContaining({
        source: "relay",
        mode: "military",
        connected: true,
        freshness: "fresh",
        relayVesselCount: 42,
        disruptionsCount: 1,
        densityCount: 0,
        candidateCount: 1,
        renderedVesselCount: 1,
        allVesselsAvailable: false,
        snapshotAgeSec: 300,
      }),
    );
  });

  it("builds the AIS density mode layer from density zones and disruptions", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:05:00.000Z"));
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const realtimeSignalsStore = createRealtimeSignalsStore({
      getLatestAisSnapshot: jest.fn().mockResolvedValue({
        source: "relay",
        sourceEndpoint: "https://relay.example.com/ais/snapshot",
        updatedAt: "2026-01-01T12:00:00.000Z",
        status: {
          connected: true,
          vessels: 15,
          messages: 800,
          clients: 1,
          droppedMessages: 0,
        },
        disruptions: [
          {
            id: "chokepoint-1",
            name: "Suez Canal",
            type: "chokepoint_congestion",
            lat: 30.1,
            lng: 32.3,
            severity: "high",
            vesselCount: 9,
            changePct: 40,
          },
        ],
        density: [
          {
            id: "density-1",
            name: "Zone 1",
            lat: 12,
            lng: 24,
            intensity: 0.75,
            deltaPct: 10,
            shipsPerDay: 144,
            note: "High traffic area",
          },
        ],
        candidateReports: [
          {
            mmsi: "123456789",
            lat: 30,
            lng: 40,
            observedAt: "2026-01-01T11:59:30.000Z",
          },
        ],
        vessels: [],
        hasVesselSnapshot: false,
      }),
      getSourceState: jest.fn().mockResolvedValue({
        source: "ais",
        status: "success",
        lastAttemptAt: "2026-01-01T12:00:00.000Z",
        lastSuccessAt: "2026-01-01T12:00:00.000Z",
        context: {
          configured: true,
          staleThresholdSec: 600,
        },
      }),
    });
    const service = new DashboardChartsService(
      prisma as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
      undefined,
      undefined,
      realtimeSignalsStore as any,
    );

    const response = await service.getWarMapLayers({
      orgId: "org-1",
      range: {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-02T00:00:00.000Z"),
      },
      aisMode: "density",
    });

    expect(response.layers.ais.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "density-1",
          properties: expect.objectContaining({
            sourceType: "ais",
            featureKind: "density",
            intensity: 0.75,
            deltaPct: 10,
            shipsPerDay: 144,
          }),
        }),
        expect.objectContaining({
          id: "chokepoint-1",
          properties: expect.objectContaining({
            sourceType: "ais",
            featureKind: "disruption",
            severity: "high",
            vesselCount: 9,
            changePct: 40,
          }),
        }),
      ]),
    );
    expect(
      response.layers.ais.features.some(
        (feature) =>
          (feature.properties as Record<string, unknown> | undefined)
            ?.featureKind === "vessel",
      ),
    ).toBe(false);
    expect(response.layers.ais.summary).toEqual(
      expect.objectContaining({
        mode: "density",
        connected: true,
        renderedVesselCount: 0,
        densityCount: 1,
        disruptionsCount: 1,
      }),
    );
  });

  it("reports AIS density and disruption counts for the current viewport", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:05:00.000Z"));
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const realtimeSignalsStore = createRealtimeSignalsStore({
      getLatestAisSnapshot: jest.fn().mockResolvedValue({
        source: "relay",
        sourceEndpoint: "https://relay.example.com/ais/snapshot",
        updatedAt: "2026-01-01T12:00:00.000Z",
        status: {
          connected: true,
          vessels: 15,
          messages: 800,
          clients: 1,
          droppedMessages: 0,
        },
        disruptions: [
          {
            id: "chokepoint-1",
            name: "Suez Canal",
            type: "chokepoint_congestion",
            lat: 30.1,
            lng: 32.3,
            severity: "high",
          },
          {
            id: "chokepoint-2",
            name: "Strait of Hormuz",
            type: "chokepoint_congestion",
            lat: 26.5,
            lng: 56.4,
            severity: "medium",
          },
        ],
        density: [
          {
            id: "density-1",
            name: "Zone 1",
            lat: 30.2,
            lng: 32.4,
            intensity: 0.75,
          },
          {
            id: "density-2",
            name: "Zone 2",
            lat: 2.5,
            lng: 101.3,
            intensity: 0.9,
          },
        ],
        candidateReports: [],
        vessels: [],
        hasVesselSnapshot: false,
      }),
      getSourceState: jest.fn().mockResolvedValue({
        source: "ais",
        status: "success",
        lastAttemptAt: "2026-01-01T12:00:00.000Z",
        lastSuccessAt: "2026-01-01T12:00:00.000Z",
        context: {
          configured: true,
          staleThresholdSec: 600,
        },
      }),
    });
    const service = new DashboardChartsService(
      prisma as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
      undefined,
      undefined,
      realtimeSignalsStore as any,
    );

    const response = await service.getWarMapLayers({
      orgId: "org-1",
      range: {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-02T00:00:00.000Z"),
      },
      aisMode: "density",
      bbox: [31, 29.5, 33, 31],
    });

    expect(response.layers.ais.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "density-1" }),
        expect.objectContaining({ id: "chokepoint-1" }),
      ]),
    );
    expect(
      response.layers.ais.features.map((feature) => feature.id).sort(),
    ).toEqual(["chokepoint-1", "density-1"]);
    expect(response.layers.ais.summary).toEqual(
      expect.objectContaining({
        mode: "density",
        densityCount: 1,
        disruptionsCount: 1,
        renderedVesselCount: 0,
      }),
    );
  });

  it("marks AIS all mode as blocked until the relay exposes vessels snapshot data", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:05:00.000Z"));
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const realtimeSignalsStore = createRealtimeSignalsStore({
      getLatestAisSnapshot: jest.fn().mockResolvedValue({
        source: "relay",
        sourceEndpoint: "https://relay.example.com/ais/snapshot",
        updatedAt: "2026-01-01T12:00:00.000Z",
        status: {
          connected: false,
          vessels: 21,
          messages: 500,
          clients: 1,
          droppedMessages: 2,
        },
        disruptions: [
          {
            id: "gap-1",
            name: "AIS Gap Spike Detected",
            type: "gap_spike",
            lat: 0,
            lng: 0,
            severity: "low",
          },
        ],
        density: [
          {
            id: "density-1",
            lat: 15,
            lng: 35,
            intensity: 0.6,
          },
        ],
        candidateReports: [
          {
            mmsi: "123456789",
            lat: 30,
            lng: 40,
            observedAt: "2026-01-01T11:59:30.000Z",
          },
        ],
        vessels: [],
        hasVesselSnapshot: false,
      }),
      getSourceState: jest.fn().mockResolvedValue({
        source: "ais",
        status: "success",
        lastAttemptAt: "2026-01-01T12:00:00.000Z",
        lastSuccessAt: "2026-01-01T12:00:00.000Z",
        context: {
          configured: true,
          staleThresholdSec: 600,
        },
      }),
    });
    const service = new DashboardChartsService(
      prisma as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
      undefined,
      undefined,
      realtimeSignalsStore as any,
    );

    const response = await service.getWarMapLayers({
      orgId: "org-1",
      range: {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-02T00:00:00.000Z"),
      },
      aisMode: "all",
    });

    expect(
      response.layers.ais.features.some(
        (feature) =>
          (feature.properties as Record<string, unknown> | undefined)
            ?.featureKind === "vessel",
      ),
    ).toBe(false);
    expect(
      response.layers.ais.features.some(
        (feature) =>
          (feature.properties as Record<string, unknown> | undefined)
            ?.featureKind === "density",
      ),
    ).toBe(true);
    expect(response.layers.ais.summary).toEqual(
      expect.objectContaining({
        mode: "all",
        connected: false,
        allVesselsAvailable: false,
        relayVesselCount: 21,
        renderedVesselCount: 0,
        blockedReasonCode: "missing_vessels_snapshot",
        blockedReason: "AIS relay snapshot does not include vessels[] yet.",
        maxReturned: 180,
        truncated: false,
      }),
    );
  });

  it("builds AIS all mode from relay vessels snapshot data when available", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:05:00.000Z"));
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const realtimeSignalsStore = createRealtimeSignalsStore({
      getLatestAisSnapshot: jest.fn().mockResolvedValue({
        source: "relay",
        sourceEndpoint: "https://relay.example.com/ais/snapshot",
        updatedAt: "2026-01-01T12:00:00.000Z",
        status: {
          connected: true,
          vessels: 84,
          messages: 2048,
          clients: 3,
          droppedMessages: 6,
        },
        disruptions: [
          {
            id: "suez-1",
            name: "Suez Canal",
            type: "chokepoint_congestion",
            lat: 30.1,
            lng: 32.3,
            severity: "high",
            vesselCount: 17,
          },
        ],
        density: [
          {
            id: "density-1",
            name: "Malacca Strait",
            lat: 2.5,
            lng: 101.3,
            intensity: 0.9,
            shipsPerDay: 244,
          },
        ],
        candidateReports: [
          {
            mmsi: "123456789",
            lat: 30,
            lng: 40,
            observedAt: "2026-01-01T11:59:30.000Z",
          },
        ],
        vessels: [
          {
            mmsi: "123456789",
            name: "USS Example",
            lat: 30,
            lng: 40,
            shipType: 55,
            heading: 90,
            speed: 14,
            course: 94,
            observedAt: "2026-01-01T11:59:30.000Z",
          },
          {
            mmsi: "987654321",
            name: "Ever Forward",
            lat: 1.2,
            lng: 103.8,
            shipType: 72,
            heading: 178,
            speed: 16,
            course: 181,
            observedAt: "2026-01-01T11:58:50.000Z",
          },
        ],
        hasVesselSnapshot: true,
      }),
      getSourceState: jest.fn().mockResolvedValue({
        source: "ais",
        status: "success",
        lastAttemptAt: "2026-01-01T12:00:00.000Z",
        lastSuccessAt: "2026-01-01T12:00:00.000Z",
        context: {
          configured: true,
          staleThresholdSec: 600,
        },
      }),
    });
    const service = new DashboardChartsService(
      prisma as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
      undefined,
      undefined,
      realtimeSignalsStore as any,
    );

    const response = await service.getWarMapLayers({
      orgId: "org-1",
      range: {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-02T00:00:00.000Z"),
      },
      aisMode: "all",
    });

    expect(
      response.layers.ais.features.filter(
        (feature) =>
          (feature.properties as Record<string, unknown> | undefined)
            ?.featureKind === "vessel",
      ),
    ).toHaveLength(2);
    expect(response.layers.ais.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "density-1",
          properties: expect.objectContaining({
            featureKind: "density",
            intensity: 0.9,
          }),
        }),
        expect.objectContaining({
          id: "suez-1",
          properties: expect.objectContaining({
            featureKind: "disruption",
            severity: "high",
          }),
        }),
        expect.objectContaining({
          id: "ais-vessel-123456789",
          properties: expect.objectContaining({
            featureKind: "vessel",
            name: "USS Example",
            shipType: 55,
          }),
        }),
        expect.objectContaining({
          id: "ais-vessel-987654321",
          properties: expect.objectContaining({
            featureKind: "vessel",
            name: "Ever Forward",
            shipType: 72,
          }),
        }),
      ]),
    );
    expect(response.layers.ais.summary).toEqual(
      expect.objectContaining({
        mode: "all",
        source: "relay",
        sourceEndpoint: "https://relay.example.com/ais/snapshot",
        connected: true,
        relayVesselCount: 84,
        renderedVesselCount: 2,
        allVesselsAvailable: true,
        messageCount: 2048,
        clientCount: 3,
        droppedMessages: 6,
        maxReturned: 180,
        truncated: false,
      }),
    );
    expect(
      (response.layers.ais.summary as Record<string, unknown>).blockedReason,
    ).toBeUndefined();
    expect(
      (response.layers.ais.summary as Record<string, unknown>)
        .blockedReasonCode,
    ).toBeUndefined();
  });

  it("limits AIS all mode with AIS-specific viewport caps instead of flight helpers", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:05:00.000Z"));
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const vessels = Array.from({ length: 250 }, (_, index) => {
      const row = Math.floor(index / 20);
      const col = index % 20;
      return {
        mmsi: `${100000000 + index}`,
        name: `Vessel ${index}`,
        lat: -80 + row * 13,
        lng: -175 + col * 13,
        shipType: 72,
        heading: 90,
        speed: 14,
        course: 92,
        observedAt: "2026-01-01T11:59:30.000Z",
      };
    });
    const realtimeSignalsStore = createRealtimeSignalsStore({
      getLatestAisSnapshot: jest.fn().mockResolvedValue({
        source: "relay",
        sourceEndpoint: "https://relay.example.com/ais/snapshot",
        updatedAt: "2026-01-01T12:00:00.000Z",
        status: {
          connected: true,
          vessels: vessels.length,
          messages: 3200,
          clients: 2,
          droppedMessages: 0,
        },
        disruptions: [],
        density: [],
        candidateReports: [],
        vessels,
        hasVesselSnapshot: true,
      }),
      getSourceState: jest.fn().mockResolvedValue({
        source: "ais",
        status: "success",
        lastAttemptAt: "2026-01-01T12:00:00.000Z",
        lastSuccessAt: "2026-01-01T12:00:00.000Z",
        context: {
          configured: true,
          staleThresholdSec: 600,
        },
      }),
    });
    const service = new DashboardChartsService(
      prisma as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
      undefined,
      undefined,
      realtimeSignalsStore as any,
    );

    const response = await service.getWarMapLayers({
      orgId: "org-1",
      range: {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-02T00:00:00.000Z"),
      },
      aisMode: "all",
      zoom: 2,
    });

    expect(
      response.layers.ais.features.filter(
        (feature) =>
          (feature.properties as Record<string, unknown> | undefined)
            ?.featureKind === "vessel",
      ),
    ).toHaveLength(180);
    expect(response.layers.ais.summary).toEqual(
      expect.objectContaining({
        mode: "all",
        relayVesselCount: 250,
        renderedVesselCount: 180,
        maxReturned: 180,
        truncated: true,
        allVesselsAvailable: true,
      }),
    );
  });

  it("builds the military flights layer from the latest OpenSky snapshot and applies bbox filtering", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:01:00.000Z"));
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const realtimeSignalsStore = createRealtimeSignalsStore({
      getLatestAdsbSnapshot: jest.fn().mockResolvedValue({
        source: "opensky",
        sourceEndpoint: "https://opensky-network.org/api/states/all",
        updatedAt: "2026-01-01T12:00:00.000Z",
        totalAircraft: 2,
        validPositionCount: 2,
        latestObservedAt: "2026-01-01T11:59:30.000Z",
        diagnostics: {
          latestObservedAt: "2026-01-01T11:59:30.000Z",
          oldestObservedAt: "2026-01-01T11:58:30.000Z",
          staleThresholdSec: 600,
          droppedInvalidPositionCount: 0,
          droppedMissingIdentityCount: 0,
          droppedStalePositionCount: 0,
          deduplicatedCount: 0,
          retainedPreviousSnapshot: false,
        },
        aircraft: [
          {
            id: "ae017a",
            icao24: "ae017a",
            callsign: "SPAR416",
            aircraftType: "LJ35",
            lat: 39.315491,
            lng: -99.342797,
            heading: 261.89,
            altitudeFt: 35975,
            groundSpeedKt: 375.8,
            countryCode: "US",
            countryName: "United States",
            observedAt: "2026-01-01T11:59:30.000Z",
            source: "opensky",
          },
          {
            id: "ae6306",
            icao24: "ae6306",
            callsign: "BLZR295",
            aircraftType: "HAWK",
            lat: 28.002242,
            lng: -98.471051,
            observedAt: "2026-01-01T11:58:30.000Z",
            source: "opensky",
          },
        ],
      }),
    });
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
      undefined,
      undefined,
      realtimeSignalsStore as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    const response = await service.getWarMapLayers({
      orgId: "org-1",
      range,
      bbox: [-110, 35, -90, 45],
    });

    expect(realtimeSignalsStore.getLatestAdsbSnapshot).toHaveBeenCalledWith(
      "org-1",
    );
    expect(response.layers.flights.updatedAt).toBe("2026-01-01T12:00:00.000Z");
    expect(response.layers.flights.renderHints).toMatchObject({
      pickable: true,
      clusterable: true,
    });
    expect(response.layers.flights.features).toEqual([
      expect.objectContaining({
        id: "ae017a",
        lat: 39.315491,
        lng: -99.342797,
        timestamp: "2026-01-01T11:59:30.000Z",
        properties: expect.objectContaining({
          sourceType: "opensky",
          callsign: "SPAR416",
          icao24: "ae017a",
          aircraftType: "LJ35",
          countryCode: "US",
          countryName: "United States",
          heading: 261.89,
          altitudeFt: 35975,
          groundSpeedKt: 375.8,
          observedAt: "2026-01-01T11:59:30.000Z",
          sourceUpdatedAt: "2026-01-01T12:00:00.000Z",
        }),
      }),
    ]);
    expect(response.layers.flights.summary).toEqual(
      expect.objectContaining({
        source: "opensky",
        scope: "military",
        sourceEndpoint: "https://opensky-network.org/api/states/all",
        freshness: "fresh",
        rawAircraftCount: 2,
        snapshotValidPositionCount: 2,
        returnedCount: 1,
        truncated: false,
        retainedPreviousSnapshot: false,
      }),
    );
  });

  it("returns an empty flights layer when the stored OpenSky snapshot is stale", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:15:00.000Z"));
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const realtimeSignalsStore = createRealtimeSignalsStore({
      getLatestAdsbSnapshot: jest.fn().mockResolvedValue({
        source: "opensky",
        sourceEndpoint: "https://opensky-network.org/api/states/all",
        updatedAt: "2026-01-01T12:00:00.000Z",
        totalAircraft: 1,
        validPositionCount: 1,
        latestObservedAt: "2026-01-01T11:59:00.000Z",
        diagnostics: {
          latestObservedAt: "2026-01-01T11:59:00.000Z",
          oldestObservedAt: "2026-01-01T11:59:00.000Z",
          staleThresholdSec: 600,
          droppedInvalidPositionCount: 0,
          droppedMissingIdentityCount: 0,
          droppedStalePositionCount: 0,
          deduplicatedCount: 0,
          retainedPreviousSnapshot: false,
        },
        aircraft: [
          {
            id: "ae017a",
            icao24: "ae017a",
            lat: 39.315491,
            lng: -99.342797,
            observedAt: "2026-01-01T11:59:00.000Z",
            source: "opensky",
          },
        ],
      }),
    });
    const service = new DashboardChartsService(
      prisma as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
      undefined,
      undefined,
      realtimeSignalsStore as any,
    );

    const response = await service.getWarMapLayers({
      orgId: "org-1",
      range: {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-02T00:00:00.000Z"),
      },
      zoom: 2,
    });

    expect(response.layers.flights.updatedAt).toBe("2026-01-01T12:00:00.000Z");
    expect(response.layers.flights.features).toEqual([]);
    expect(response.layers.flights.summary).toEqual(
      expect.objectContaining({
        source: "opensky",
        scope: "military",
        sourceEndpoint: "https://opensky-network.org/api/states/all",
        freshness: "stale",
        rawAircraftCount: 1,
        snapshotValidPositionCount: 1,
        returnedCount: 0,
        retainedPreviousSnapshot: false,
      }),
    );
  });

  it("marks OpenSky all mode as budget-limited when daily credits are constrained", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:15:00.000Z"));
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const realtimeSignals = {
      fetchOpenskyViewportSnapshot: jest.fn().mockResolvedValue({
        configured: true,
        requiresZoom: false,
        budgetLimited: true,
        sourceEndpoint:
          "https://opensky-network.org/api/states/all?lamin=30&lomin=100&lamax=40&lomax=110",
        statusReason:
          "OpenSky all-flight mode is temporarily limited to preserve the daily credit budget.",
        budgetSummary: {
          dateHkt: "2026-01-01",
          dailyBudget: 4000,
          remainingCredits: 250,
          degradationLevel: "critical",
        },
        snapshot: null,
      }),
    };
    const service = new DashboardChartsService(
      prisma as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
      undefined,
      realtimeSignals as any,
      undefined,
    );

    const response = await service.getWarMapLayers({
      orgId: "org-1",
      range: {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-02T00:00:00.000Z"),
      },
      zoom: 5,
      bbox: [100, 30, 110, 40],
      flightMode: "all",
    });

    expect(realtimeSignals.fetchOpenskyViewportSnapshot).toHaveBeenCalledWith({
      bbox: [100, 30, 110, 40],
    });
    expect(response.layers.flights.features).toEqual([]);
    expect(response.layers.flights.summary).toEqual(
      expect.objectContaining({
        source: "opensky",
        scope: "all",
        freshness: "budget_limited",
        sourceEndpoint:
          "https://opensky-network.org/api/states/all?lamin=30&lomin=100&lamax=40&lomax=110",
        returnedCount: 0,
        remainingCredits: 250,
        dailyBudget: 4000,
        dateHkt: "2026-01-01",
        degradationLevel: "critical",
      }),
    );
  });

  it("shapes global flights density by zoom level", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:01:00.000Z"));
    const aircraft = Array.from({ length: 260 }, (_, index) => {
      const row = Math.floor(index / 13);
      const col = index % 13;
      return {
        id: `ac-${index}`,
        icao24: `ac${index.toString(16).padStart(4, "0")}`,
        lat: -60 + row * 6,
        lng: -170 + col * 12,
        observedAt: "2026-01-01T11:59:30.000Z",
        source: "opensky" as const,
      };
    });
    const realtimeSignalsStore = createRealtimeSignalsStore({
      getLatestAdsbSnapshot: jest.fn().mockResolvedValue({
        source: "opensky",
        sourceEndpoint: "https://opensky-network.org/api/states/all",
        updatedAt: "2026-01-01T12:00:00.000Z",
        totalAircraft: aircraft.length,
        validPositionCount: aircraft.length,
        latestObservedAt: "2026-01-01T11:59:30.000Z",
        diagnostics: {
          latestObservedAt: "2026-01-01T11:59:30.000Z",
          oldestObservedAt: "2026-01-01T11:59:30.000Z",
          staleThresholdSec: 600,
          droppedInvalidPositionCount: 0,
          droppedMissingIdentityCount: 0,
          droppedStalePositionCount: 0,
          deduplicatedCount: 0,
          retainedPreviousSnapshot: false,
        },
        aircraft,
      }),
    });
    const service = new DashboardChartsService(
      {
        alertEvent: { findMany: jest.fn().mockResolvedValue([]) },
        processedArticle: { findMany: jest.fn().mockResolvedValue([]) },
      } as any,
      { resolveCandidates: jest.fn() } as any,
      createCache() as any,
      undefined,
      undefined,
      realtimeSignalsStore as any,
    );
    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    const lowZoom = await service.getWarMapLayers({
      orgId: "org-1",
      range,
      zoom: 2,
    });
    const highZoom = await service.getWarMapLayers({
      orgId: "org-1",
      range,
      zoom: 7,
    });

    expect(lowZoom.layers.flights.features.length).toBeLessThan(260);
    expect(lowZoom.layers.flights.features.length).toBeLessThan(
      highZoom.layers.flights.features.length,
    );
    expect(highZoom.layers.flights.features).toHaveLength(260);
    expect(lowZoom.layers.flights.summary).toEqual(
      expect.objectContaining({
        source: "opensky",
        scope: "military",
        sourceEndpoint: "https://opensky-network.org/api/states/all",
        freshness: "fresh",
        rawAircraftCount: 260,
        snapshotValidPositionCount: 260,
        returnedCount: lowZoom.layers.flights.features.length,
        truncated: true,
      }),
    );
    expect(highZoom.layers.flights.summary).toEqual(
      expect.objectContaining({
        source: "opensky",
        scope: "military",
        sourceEndpoint: "https://opensky-network.org/api/states/all",
        freshness: "fresh",
        rawAircraftCount: 260,
        snapshotValidPositionCount: 260,
        returnedCount: 260,
        truncated: false,
      }),
    );
  });

  it("returns clustered war map events when clustering is requested", async () => {
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            triggeredAt: new Date("2026-01-01T12:00:00.000Z"),
            severity: "high",
            context: { countryCode: "FRA" },
          },
          {
            triggeredAt: new Date("2026-01-01T12:00:00.000Z"),
            severity: "medium",
            context: { countryCode: "DEU" },
          },
          {
            triggeredAt: new Date("2026-01-01T12:00:00.000Z"),
            severity: "low",
            context: { countryCode: "NLD" },
          },
        ]),
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    const result = await service.getWarMapEvents(range, "org-1", {
      cluster: true,
      zoom: 0,
      bbox: [-10, 45, 20, 60],
    });

    expect(result.clustered).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.some((event) => event.isCluster)).toBe(true);
    expect(
      result.events.every(
        (event) =>
          event.lng >= -10 &&
          event.lng <= 20 &&
          event.lat >= 45 &&
          event.lat <= 60,
      ),
    ).toBe(true);
  });

  it("returns clustered war map news markers when clustering is requested", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "marker-1",
            title: "headline-1",
            location: "Paris, France",
            publishedAt: new Date("2026-01-01T08:00:00.000Z"),
            processedAt: new Date("2026-01-01T08:01:00.000Z"),
            entities: [],
            article: {
              url: "https://example.com/1",
              crawlAt: new Date("2026-01-01T08:00:30.000Z"),
              titleGuess: null,
            },
          },
          {
            id: "marker-2",
            title: "headline-2",
            location: "Paris, France",
            publishedAt: new Date("2026-01-01T08:10:00.000Z"),
            processedAt: new Date("2026-01-01T08:11:00.000Z"),
            entities: [],
            article: {
              url: "https://example.com/2",
              crawlAt: new Date("2026-01-01T08:10:30.000Z"),
              titleGuess: null,
            },
          },
          {
            id: "marker-3",
            title: "headline-3",
            location: "Paris, France",
            publishedAt: new Date("2026-01-01T08:20:00.000Z"),
            processedAt: new Date("2026-01-01T08:21:00.000Z"),
            entities: [],
            article: {
              url: "https://example.com/3",
              crawlAt: new Date("2026-01-01T08:20:30.000Z"),
              titleGuess: null,
            },
          },
        ]),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn().mockResolvedValue({
        lat: 48.8566,
        lng: 2.3522,
        displayName: "Paris, France",
      }),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    const result = await service.getWarMapNewsMarkers(range, "org-1", {
      cluster: true,
      zoom: 1,
      bbox: [-5, 40, 10, 55],
    });

    expect(result.clustered).toBe(true);
    expect(result.markers.length).toBe(1);
    expect(result.markers[0]).toEqual(
      expect.objectContaining({
        isCluster: true,
        clusterCount: 3,
      }),
    );
  });

  it("filters war map news markers by bbox when clustering is disabled", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "marker-paris",
            title: "Paris",
            location: "Paris, France",
            publishedAt: new Date("2026-01-01T09:00:00.000Z"),
            processedAt: new Date("2026-01-01T09:01:00.000Z"),
            entities: [],
            article: {
              url: "https://example.com/paris",
              crawlAt: new Date("2026-01-01T09:00:30.000Z"),
              titleGuess: null,
            },
          },
          {
            id: "marker-tokyo",
            title: "Tokyo",
            location: "Tokyo, Japan",
            publishedAt: new Date("2026-01-01T10:00:00.000Z"),
            processedAt: new Date("2026-01-01T10:01:00.000Z"),
            entities: [],
            article: {
              url: "https://example.com/tokyo",
              crawlAt: new Date("2026-01-01T10:00:30.000Z"),
              titleGuess: null,
            },
          },
        ]),
      },
    };
    const geocoding = {
      resolveCandidates: jest
        .fn()
        .mockImplementation(async (candidates: string[]) => {
          const target = candidates.join(" ").toLowerCase();
          if (target.includes("tokyo")) {
            return {
              lat: 35.6762,
              lng: 139.6503,
              displayName: "Tokyo, Japan",
            };
          }
          return {
            lat: 48.8566,
            lng: 2.3522,
            displayName: "Paris, France",
          };
        }),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    const result = await service.getWarMapNewsMarkers(range, "org-1", {
      cluster: false,
      bbox: [-10, 40, 20, 60],
    });

    expect(result.clustered).toBe(false);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0]?.id).toBe("marker-paris");
  });

  it("selects sector heatmap sourceField from item metadata preference (supports label->field mapping)", async () => {
    const prisma = {
      economicDataItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "item-1",
            slug: "btc_spot",
            displayName: "BTC Spot",
            defaultUnit: "USD",
            metadata: {
              parser: {
                type: "latest",
                valueFields: [
                  {
                    field: "最近报价",
                    label: "latest_price",
                    unit: "USD",
                  },
                ],
              },
              dataViz: {
                heatmap: {
                  preferredSourceFields: ["latest_price"],
                },
              },
            },
          },
        ]),
      },
      economicDataPoint: {
        groupBy: jest.fn().mockResolvedValue([
          {
            itemId: "item-1",
            sourceField: "最近报价",
            _count: { _all: 2 },
          },
        ]),
        findFirst: jest.fn().mockImplementation(({ orderBy }) => {
          if (orderBy?.recordedAt === "asc") {
            return {
              recordedAt: new Date("2026-01-01T00:00:00.000Z"),
              value: 100,
              unit: "USD",
            };
          }
          return {
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 110,
            unit: "USD",
          };
        }),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z"),
    };

    const response = await service.getSectorHeatmap(range);

    expect(response.cells).toEqual([
      expect.objectContaining({
        name: "BTC Spot",
        sourceField: "最近报价",
        value: 110,
        change: 10,
        unit: "USD",
      }),
    ]);
  });

  it("selects sector heatmap sourceField from default preferences (supports common current value keys)", async () => {
    const prisma = {
      economicDataItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "item-1",
            slug: "macro_metric",
            displayName: "Macro Metric",
            defaultUnit: "pts",
            metadata: {},
          },
        ]),
      },
      economicDataPoint: {
        groupBy: jest.fn().mockResolvedValue([
          {
            itemId: "item-1",
            sourceField: "今值",
            _count: { _all: 2 },
          },
        ]),
        findFirst: jest.fn().mockImplementation(({ orderBy }) => {
          if (orderBy?.recordedAt === "asc") {
            return {
              recordedAt: new Date("2026-01-01T00:00:00.000Z"),
              value: 4200,
              unit: "pts",
            };
          }
          return {
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 4300,
            unit: "pts",
          };
        }),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z"),
    };

    const response = await service.getSectorHeatmap(range);

    expect(response.cells).toEqual([
      expect.objectContaining({
        name: "Macro Metric",
        sourceField: "今值",
        value: 4300,
        change: Number((((4300 - 4200) / 4200) * 100).toFixed(2)),
        unit: "pts",
      }),
    ]);
  });

  it("throws sector heatmap error code when mapping does not match available source fields", async () => {
    const prisma = {
      economicDataItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "item-2",
            slug: "mystery",
            displayName: "Mystery Metric",
            defaultUnit: "u",
            metadata: {
              dataViz: {
                heatmap: {
                  preferredSourceFields: ["does_not_exist"],
                },
              },
            },
          },
        ]),
      },
      economicDataPoint: {
        groupBy: jest.fn().mockResolvedValue([
          {
            itemId: "item-2",
            sourceField: "weird_field",
            _count: { _all: 1 },
          },
        ]),
        findFirst: jest.fn(),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z"),
    };

    try {
      await service.getSectorHeatmap(range);
      throw new Error("Expected getSectorHeatmap to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect((error as any).getResponse?.()).toEqual(
        expect.objectContaining({
          code: "DASHBOARD_SECTOR_HEATMAP_FIELD_MAPPING_MISMATCH",
        }),
      );
    }
  });

  it("maps candlestick OHLC fields via item metadata config", async () => {
    const prisma = {
      economicDataItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: "item-ohlc",
          displayName: "Custom Candlestick",
          defaultFrequency: "daily",
          defaultUnit: "pts",
          metadata: {
            dataViz: {
              candlestick: {
                ohlc: {
                  open: ["o"],
                  high: ["h"],
                  low: ["l"],
                  close: ["c"],
                },
              },
            },
          },
        }),
      },
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue([
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 10,
            unit: "pts",
            sourceField: "o",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 15,
            unit: "pts",
            sourceField: "h",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 8,
            unit: "pts",
            sourceField: "l",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 12,
            unit: "pts",
            sourceField: "c",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 12,
            unit: "pts",
            sourceField: "o",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 20,
            unit: "pts",
            sourceField: "h",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 11,
            unit: "pts",
            sourceField: "l",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 18,
            unit: "pts",
            sourceField: "c",
          },
        ]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z"),
    };

    const response = await service.getFinancialCandlestick(range);

    expect(response).toEqual(
      expect.objectContaining({
        symbol: "Custom Candlestick",
        interval: "daily",
        unit: "pts",
        sourceFields: {
          open: "o",
          high: "h",
          low: "l",
          close: "c",
        },
      }),
    );
    expect(response.points).toEqual([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        open: 10,
        close: 12,
        high: 15,
        low: 8,
      },
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        open: 12,
        close: 18,
        high: 20,
        low: 11,
      },
    ]);
  });

  it("maps candlestick OHLC fields via default 东方财富 aliases", async () => {
    const prisma = {
      economicDataItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: "item-ohlc-em",
          displayName: "SP500 EM",
          defaultFrequency: "daily",
          defaultUnit: "pts",
          metadata: null,
        }),
      },
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue([
          {
            itemId: "item-ohlc-em",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 10,
            unit: "pts",
            sourceField: "今开",
          },
          {
            itemId: "item-ohlc-em",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 15,
            unit: "pts",
            sourceField: "最高",
          },
          {
            itemId: "item-ohlc-em",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 8,
            unit: "pts",
            sourceField: "最低",
          },
          {
            itemId: "item-ohlc-em",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 12,
            unit: "pts",
            sourceField: "最新价",
          },
          {
            itemId: "item-ohlc-em",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 12,
            unit: "pts",
            sourceField: "今开",
          },
          {
            itemId: "item-ohlc-em",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 20,
            unit: "pts",
            sourceField: "最高",
          },
          {
            itemId: "item-ohlc-em",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 11,
            unit: "pts",
            sourceField: "最低",
          },
          {
            itemId: "item-ohlc-em",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 18,
            unit: "pts",
            sourceField: "最新价",
          },
        ]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z"),
    };

    const response = await service.getFinancialCandlestick(range);

    expect(response).toEqual(
      expect.objectContaining({
        symbol: "SP500 EM",
        interval: "daily",
        unit: "pts",
        sourceFields: {
          open: "今开",
          high: "最高",
          low: "最低",
          close: "最新价",
        },
      }),
    );
    expect(response.points).toEqual([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        open: 10,
        close: 12,
        high: 15,
        low: 8,
      },
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        open: 12,
        close: 18,
        high: 20,
        low: 11,
      },
    ]);
  });

  it("skips incomplete candlestick entries and returns remaining complete candles", async () => {
    const prisma = {
      economicDataItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: "item-ohlc",
          displayName: "Custom Candlestick",
          defaultFrequency: "daily",
          defaultUnit: "pts",
          metadata: {
            dataViz: {
              candlestick: {
                ohlc: {
                  open: ["o"],
                  high: ["h"],
                  low: ["l"],
                  close: ["c"],
                },
              },
            },
          },
        }),
      },
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue([
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 10,
            unit: "pts",
            sourceField: "o",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 15,
            unit: "pts",
            sourceField: "h",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 8,
            unit: "pts",
            sourceField: "l",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 12,
            unit: "pts",
            sourceField: "c",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 12.5,
            unit: "pts",
            sourceField: "o",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 19,
            unit: "pts",
            sourceField: "h",
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 11,
            unit: "pts",
            sourceField: "l",
          },
        ]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const geocoding = {
      resolveCandidates: jest.fn(),
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z"),
    };

    const response = await service.getFinancialCandlestick(range);

    expect(response.points).toEqual([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        open: 10,
        close: 12,
        high: 15,
        low: 8,
      },
    ]);
    expect(response.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(response.latestObservedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(response.skippedIncompleteCount).toBe(1);
  });
});
