import { InternalServerErrorException } from "@nestjs/common";
import { ProcessedArticleStatus } from "@prisma/client";

import { DashboardChartsService } from "../dashboard-charts.service";

const createCache = () => ({
  get: jest.fn(),
  set: jest.fn(),
});

describe("DashboardChartsService", () => {
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

  it("filters war map news markers by publishedAt priority (falls back to crawlAt when publishedAt is null)", async () => {
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
          status: ProcessedArticleStatus.completed,
          OR: expect.arrayContaining([
            expect.objectContaining({
              publishedAt: expect.objectContaining({
                gte: range.start,
                lte: range.end,
              }),
              article: { orgId: "org-1" },
            }),
            expect.objectContaining({
              publishedAt: null,
              article: expect.objectContaining({
                orgId: "org-1",
                crawlAt: expect.objectContaining({
                  gte: range.start,
                  lte: range.end,
                }),
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("filters war map events by publishedAt priority (falls back to crawlAt when publishedAt is null)", async () => {
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
          status: ProcessedArticleStatus.completed,
          OR: expect.arrayContaining([
            expect.objectContaining({
              publishedAt: expect.objectContaining({
                gte: range.start,
                lte: range.end,
              }),
              article: { orgId: "org-1" },
            }),
            expect.objectContaining({
              publishedAt: null,
              article: expect.objectContaining({
                orgId: "org-1",
                crawlAt: expect.objectContaining({
                  gte: range.start,
                  lte: range.end,
                }),
              }),
            }),
          ]),
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

  it("throws candlestick error code when OHLC values are incomplete", async () => {
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

    try {
      await service.getFinancialCandlestick(range);
      throw new Error("Expected getFinancialCandlestick to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect((error as any).getResponse?.()).toEqual(
        expect.objectContaining({
          code: "DASHBOARD_CANDLESTICK_OHLC_INCOMPLETE",
        }),
      );
    }
  });
});
