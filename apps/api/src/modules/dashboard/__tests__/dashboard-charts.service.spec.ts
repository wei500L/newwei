import { InternalServerErrorException } from "@nestjs/common";
import { ProcessedArticleStatus } from "@prisma/client";

import { DashboardChartsService } from "../dashboard-charts.service";

const createCache = () => ({
  get: jest.fn(),
  set: jest.fn()
});

describe("DashboardChartsService", () => {
  it("filters war map news markers by publishedAt priority (falls back to crawlAt when publishedAt is null)", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([])
      }
    };
    const geocoding = {
      resolveCandidates: jest.fn()
    };
    const service = new DashboardChartsService(prisma as any, geocoding as any, createCache() as any);

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z")
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
                lte: range.end
              }),
              article: { orgId: "org-1" }
            }),
            expect.objectContaining({
              publishedAt: null,
              article: expect.objectContaining({
                orgId: "org-1",
                crawlAt: expect.objectContaining({
                  gte: range.start,
                  lte: range.end
                })
              })
            })
          ])
        })
      })
    );
  });

  it("filters war map events by publishedAt priority (falls back to crawlAt when publishedAt is null)", async () => {
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([])
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([])
      }
    };
    const geocoding = {
      resolveCandidates: jest.fn()
    };
    const service = new DashboardChartsService(prisma as any, geocoding as any, createCache() as any);

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z")
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
                lte: range.end
              }),
              article: { orgId: "org-1" }
            }),
            expect.objectContaining({
              publishedAt: null,
              article: expect.objectContaining({
                orgId: "org-1",
                crawlAt: expect.objectContaining({
                  gte: range.start,
                  lte: range.end
                })
              })
            })
          ])
        })
      })
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
              titleGuess: null
            }
          }
        ])
      }
    };
    const geocoding = {
      resolveCandidates: jest.fn().mockResolvedValue({
        lat: 37.7749,
        lng: -122.4194,
        displayName: "San Francisco, United States"
      })
    };
    const translation = {
      translateTextsToZhBestEffort: jest
        .fn()
        .mockResolvedValue(new Map([["Example headline", "示例标题"]]))
    };
    const service = new DashboardChartsService(
      prisma as any,
      geocoding as any,
      createCache() as any,
      translation as any
    );

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z")
    };

    const result = await service.getWarMapNewsMarkers(range, "org-1", {
      translateTarget: "zh-CN"
    });

    expect(translation.translateTextsToZhBestEffort).toHaveBeenCalledTimes(1);
    expect(result.markers[0]).toEqual(
      expect.objectContaining({
        id: "marker-1",
        title: "Example headline",
        titleZh: "示例标题"
      })
    );
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
                    unit: "USD"
                  }
                ]
              },
              dataViz: {
                heatmap: {
                  preferredSourceFields: ["latest_price"]
                }
              }
            }
          }
        ])
      },
      economicDataPoint: {
        groupBy: jest.fn().mockResolvedValue([
          {
            itemId: "item-1",
            sourceField: "最近报价",
            _count: { _all: 2 }
          }
        ]),
        findFirst: jest.fn().mockImplementation(({ orderBy }) => {
          if (orderBy?.recordedAt === "asc") {
            return {
              recordedAt: new Date("2026-01-01T00:00:00.000Z"),
              value: 100,
              unit: "USD"
            };
          }
          return {
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 110,
            unit: "USD"
          };
        })
      }
    };
    const geocoding = {
      resolveCandidates: jest.fn()
    };
    const service = new DashboardChartsService(prisma as any, geocoding as any, createCache() as any);

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z")
    };

    const response = await service.getSectorHeatmap(range);

    expect(response.cells).toEqual([
      expect.objectContaining({
        name: "BTC Spot",
        sourceField: "最近报价",
        value: 110,
        change: 10,
        unit: "USD"
      })
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
            metadata: {}
          }
        ])
      },
      economicDataPoint: {
        groupBy: jest.fn().mockResolvedValue([
          {
            itemId: "item-1",
            sourceField: "今值",
            _count: { _all: 2 }
          }
        ]),
        findFirst: jest.fn().mockImplementation(({ orderBy }) => {
          if (orderBy?.recordedAt === "asc") {
            return {
              recordedAt: new Date("2026-01-01T00:00:00.000Z"),
              value: 4200,
              unit: "pts"
            };
          }
          return {
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 4300,
            unit: "pts"
          };
        })
      }
    };
    const geocoding = {
      resolveCandidates: jest.fn()
    };
    const service = new DashboardChartsService(prisma as any, geocoding as any, createCache() as any);

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z")
    };

    const response = await service.getSectorHeatmap(range);

    expect(response.cells).toEqual([
      expect.objectContaining({
        name: "Macro Metric",
        sourceField: "今值",
        value: 4300,
        change: Number(((4300 - 4200) / 4200 * 100).toFixed(2)),
        unit: "pts"
      })
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
                  preferredSourceFields: ["does_not_exist"]
                }
              }
            }
          }
        ])
      },
      economicDataPoint: {
        groupBy: jest.fn().mockResolvedValue([
          {
            itemId: "item-2",
            sourceField: "weird_field",
            _count: { _all: 1 }
          }
        ]),
        findFirst: jest.fn()
      }
    };
    const geocoding = {
      resolveCandidates: jest.fn()
    };
    const service = new DashboardChartsService(prisma as any, geocoding as any, createCache() as any);

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z")
    };

    try {
      await service.getSectorHeatmap(range);
      throw new Error("Expected getSectorHeatmap to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect((error as any).getResponse?.()).toEqual(
        expect.objectContaining({
          code: "DASHBOARD_SECTOR_HEATMAP_FIELD_MAPPING_MISMATCH"
        })
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
                  close: ["c"]
                }
              }
            }
          }
        })
      },
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue([
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 10,
            unit: "pts",
            sourceField: "o"
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 15,
            unit: "pts",
            sourceField: "h"
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 8,
            unit: "pts",
            sourceField: "l"
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 12,
            unit: "pts",
            sourceField: "c"
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 12,
            unit: "pts",
            sourceField: "o"
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 20,
            unit: "pts",
            sourceField: "h"
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 11,
            unit: "pts",
            sourceField: "l"
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-02T00:00:00.000Z"),
            value: 18,
            unit: "pts",
            sourceField: "c"
          }
        ]),
        count: jest.fn().mockResolvedValue(0)
      }
    };
    const geocoding = {
      resolveCandidates: jest.fn()
    };
    const service = new DashboardChartsService(prisma as any, geocoding as any, createCache() as any);

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z")
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
          close: "c"
        }
      })
    );
    expect(response.points).toEqual([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        open: 10,
        close: 12,
        high: 15,
        low: 8
      },
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        open: 12,
        close: 18,
        high: 20,
        low: 11
      }
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
                  close: ["c"]
                }
              }
            }
          }
        })
      },
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue([
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 10,
            unit: "pts",
            sourceField: "o"
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 8,
            unit: "pts",
            sourceField: "l"
          },
          {
            itemId: "item-ohlc",
            recordedAt: new Date("2026-01-01T00:00:00.000Z"),
            value: 12,
            unit: "pts",
            sourceField: "c"
          }
        ]),
        count: jest.fn().mockResolvedValue(0)
      }
    };
    const geocoding = {
      resolveCandidates: jest.fn()
    };
    const service = new DashboardChartsService(prisma as any, geocoding as any, createCache() as any);

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T23:59:59.999Z")
    };

    try {
      await service.getFinancialCandlestick(range);
      throw new Error("Expected getFinancialCandlestick to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect((error as any).getResponse?.()).toEqual(
        expect.objectContaining({
          code: "DASHBOARD_CANDLESTICK_OHLC_INCOMPLETE"
        })
      );
    }
  });
});
