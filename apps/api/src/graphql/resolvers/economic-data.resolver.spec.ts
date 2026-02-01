import { EconomicDataFrequency } from "@prisma/client";

import type { AkshareService } from "../../modules/akshare/akshare.service";
import { TimeGranularity } from "../models/economic-data.model";

import { EconomicDataResolver } from "./economic-data.resolver";

describe("EconomicDataResolver", () => {
  const mockAkshareService = {
    getDataByCategory: jest.fn(),
    getCategoryBaseGranularity: jest.fn(),
    listFetchConfigs: jest.fn(),
    updateFetchConfig: jest.fn(),
    triggerDataFetch: jest.fn()
  } as unknown as AkshareService;

  const resolver = new EconomicDataResolver(mockAkshareService);

  beforeEach(() => {
    jest.clearAllMocks();
    (mockAkshareService.getCategoryBaseGranularity as jest.Mock).mockResolvedValue(null);
  });

  describe("getEconomicData", () => {
    const sampleDataPoints = [
      {
        recordedAt: new Date("2024-01-01T00:00:00Z"),
        value: "123.45",
        unit: "USD",
        sourceField: "price",
        dataType: "numeric",
        item: {
          slug: "gdp-growth",
          displayName: "GDP Growth Rate",
          groupLabel: "Economic Indicators",
          defaultUnit: "%",
          metadata: { source: "government" }
        }
      },
      {
        recordedAt: new Date("2024-01-02T00:00:00Z"),
        value: "456.78",
        unit: "USD",
        sourceField: "price",
        dataType: "numeric",
        item: {
          slug: "gdp-growth",
          displayName: "GDP Growth Rate",
          groupLabel: null,
          defaultUnit: null,
          metadata: null
        }
      }
    ];

    it("returns mapped EconomicDataPointModel array from service response", async () => {
      (mockAkshareService.getDataByCategory as jest.Mock).mockResolvedValue(sampleDataPoints);

      const result = await resolver.getEconomicData(
        "economic-indicators",
        { start: "2024-01-01", end: "2024-01-31" },
        TimeGranularity.day
      );

      expect(mockAkshareService.getDataByCategory).toHaveBeenCalledWith(
        "economic-indicators",
        new Date("2024-01-01"),
        new Date("2024-01-31"),
        TimeGranularity.day
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        value: 123.45,
        unit: "USD",
        sourceField: "price",
        dataType: "numeric",
        item: {
          slug: "gdp-growth",
          displayName: "GDP Growth Rate",
          groupLabel: "Economic Indicators",
          defaultUnit: "%",
          metadata: { source: "government" }
        }
      });
    });

    it("correctly transforms recordedAt to timestamp field", async () => {
      (mockAkshareService.getDataByCategory as jest.Mock).mockResolvedValue(sampleDataPoints);

      const result = await resolver.getEconomicData(
        "economic-indicators",
        { start: "2024-01-01", end: "2024-01-31" }
      );

      expect(result[0].timestamp).toEqual(new Date("2024-01-01T00:00:00Z"));
      expect(result[1].timestamp).toEqual(new Date("2024-01-02T00:00:00Z"));
    });

    it("handles empty result array", async () => {
      (mockAkshareService.getDataByCategory as jest.Mock).mockResolvedValue([]);

      const result = await resolver.getEconomicData(
        "non-existent-category",
        { start: "2024-01-01", end: "2024-01-31" }
      );

      expect(result).toEqual([]);
    });

    it("handles nullable item fields correctly", async () => {
      (mockAkshareService.getDataByCategory as jest.Mock).mockResolvedValue([sampleDataPoints[1]]);

      const result = await resolver.getEconomicData(
        "economic-indicators",
        { start: "2024-01-01", end: "2024-01-31" }
      );

      expect(result[0].item.groupLabel).toBeUndefined();
      expect(result[0].item.defaultUnit).toBeNull();
      expect(result[0].item.metadata).toBeNull();
    });

    it("coarsens granularity when omitted based on category base frequency", async () => {
      (mockAkshareService.getCategoryBaseGranularity as jest.Mock).mockResolvedValue("week");
      (mockAkshareService.getDataByCategory as jest.Mock).mockResolvedValue([
        {
          recordedAt: new Date("2024-01-05T12:00:00Z"),
          value: 100,
          unit: null,
          sourceField: null,
          dataType: "index",
          item: {
            slug: "weekly_series",
            displayName: "Weekly Series",
            groupLabel: null,
            defaultUnit: null,
            defaultFrequency: EconomicDataFrequency.weekly,
            metadata: null
          }
        }
      ]);

      const result = await resolver.getEconomicData(
        "economic-indicators",
        { start: "2024-01-01", end: "2024-01-31" },
      );

      expect(mockAkshareService.getDataByCategory).toHaveBeenCalledWith(
        "economic-indicators",
        new Date("2024-01-01"),
        new Date("2024-01-31"),
        TimeGranularity.week,
        undefined,
        { skipGranularityValidation: true }
      );
      expect(result[0]?.effectiveGranularity).toBe(TimeGranularity.week);
    });

    it("uses backend default granularity when requested granularity is omitted", async () => {
      (mockAkshareService.getDataByCategory as jest.Mock).mockResolvedValue([
        {
          recordedAt: new Date("2024-01-05T12:34:56Z"),
          value: 100,
          unit: null,
          sourceField: null,
          dataType: "index",
          item: {
            slug: "realtime_series",
            displayName: "Realtime Series",
            groupLabel: null,
            defaultUnit: null,
            defaultFrequency: EconomicDataFrequency.realtime,
            metadata: null
          }
        }
      ]);

      const result = await resolver.getEconomicData(
        "economic-indicators",
        { start: "2024-01-01T00:00:00Z", end: "2024-01-01T05:00:00Z" }
      );

      expect(mockAkshareService.getDataByCategory).toHaveBeenCalledWith(
        "economic-indicators",
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-01T05:00:00Z"),
        TimeGranularity.minute
      );
      expect(result[0]?.effectiveGranularity).toBe(TimeGranularity.minute);
    });

    it("allows requesting hourly aggregation for realtime series", async () => {
      (mockAkshareService.getDataByCategory as jest.Mock).mockResolvedValue([
        {
          recordedAt: new Date("2024-01-05T12:34:56Z"),
          value: 100,
          unit: null,
          sourceField: null,
          dataType: "index",
          item: {
            slug: "realtime_series",
            displayName: "Realtime Series",
            groupLabel: null,
            defaultUnit: null,
            defaultFrequency: EconomicDataFrequency.realtime,
            metadata: null
          }
        }
      ]);

      const result = await resolver.getEconomicData(
        "economic-indicators",
        { start: "2024-01-01", end: "2024-01-31" },
        TimeGranularity.hour
      );

      expect(result[0]?.effectiveGranularity).toBe(TimeGranularity.hour);
    });
  });

  describe("getEconomicDataInsights", () => {
    it("groups points by item slug and source field", async () => {
      (mockAkshareService.getDataByCategory as jest.Mock).mockResolvedValue([
        {
          recordedAt: new Date("2024-01-01T00:00:00Z"),
          value: 100,
          unit: "USD",
          sourceField: "close",
          dataType: "index",
          item: {
            slug: "sp500_index",
            displayName: "S&P 500 Index",
            groupLabel: null,
            defaultUnit: null,
            metadata: null
          }
        },
        {
          recordedAt: new Date("2024-01-02T00:00:00Z"),
          value: 110,
          unit: "USD",
          sourceField: "close",
          dataType: "index",
          item: {
            slug: "sp500_index",
            displayName: "S&P 500 Index",
            groupLabel: null,
            defaultUnit: null,
            metadata: null
          }
        },
        {
          recordedAt: new Date("2024-01-02T00:00:00Z"),
          value: 42,
          unit: null,
          sourceField: null,
          dataType: "index",
          item: {
            slug: "demo_metric",
            displayName: "Demo Metric",
            groupLabel: null,
            defaultUnit: "%",
            metadata: null
          }
        }
      ]);

      const result = await resolver.getEconomicDataInsights("economic-indicators", {
        start: "2024-01-01",
        end: "2024-01-31"
      });

      expect(mockAkshareService.getDataByCategory).toHaveBeenCalledWith(
        "economic-indicators",
        new Date("2024-01-01"),
        new Date("2024-01-31"),
        undefined
      );

      const sp500 = result.find((entry) => entry.itemSlug === "sp500_index" && entry.seriesKey === "close");
      expect(sp500).toBeDefined();
      expect(sp500).toMatchObject({
        itemSlug: "sp500_index",
        seriesKey: "close",
        sourceField: "close",
        unit: "USD",
        sampleCount: 2,
        currentValue: 110,
        previousValue: 100,
        percentChange: 10,
        direction: "up",
        classification: "trend"
      });
      expect(typeof sp500?.message).toBe("string");
      expect(sp500?.message.length).toBeGreaterThan(0);

      const demo = result.find((entry) => entry.itemSlug === "demo_metric");
      expect(demo).toBeDefined();
      expect(demo).toMatchObject({
        itemSlug: "demo_metric",
        seriesKey: "demo_metric-default",
        sourceField: null,
        unit: "%"
      });
    });
  });

  describe("getEconomicDataWithInsights", () => {
    it("returns both points and insights from a single fetch", async () => {
      (mockAkshareService.getDataByCategory as jest.Mock).mockResolvedValue([
        {
          recordedAt: new Date("2024-01-01T00:00:00Z"),
          value: 100,
          unit: "USD",
          sourceField: "close",
          dataType: "index",
          item: {
            slug: "sp500_index",
            displayName: "S&P 500 Index",
            groupLabel: null,
            defaultUnit: null,
            metadata: null
          }
        },
        {
          recordedAt: new Date("2024-01-02T00:00:00Z"),
          value: 110,
          unit: "USD",
          sourceField: "close",
          dataType: "index",
          item: {
            slug: "sp500_index",
            displayName: "S&P 500 Index",
            groupLabel: null,
            defaultUnit: null,
            metadata: null
          }
        }
      ]);

      const result = await resolver.getEconomicDataWithInsights("economic-indicators", {
        start: "2024-01-01",
        end: "2024-01-31"
      });

      expect(mockAkshareService.getDataByCategory).toHaveBeenCalledTimes(1);
      expect(result.points).toHaveLength(2);
      expect(result.points[0]).toMatchObject({
        value: 100,
        unit: "USD",
        sourceField: "close",
        item: {
          slug: "sp500_index",
          displayName: "S&P 500 Index"
        }
      });
      expect(result.insights).toHaveLength(1);
      expect(result.insights[0]).toMatchObject({
        itemSlug: "sp500_index",
        seriesKey: "close",
        classification: "trend"
      });
    });
  });

  describe("economicDataFetchConfigs", () => {
    const sampleConfigs = [
      {
        id: "config-1",
        frequency: EconomicDataFrequency.DAILY,
        repeatCron: "0 0 * * *",
        isEnabled: true,
        lastRunAt: new Date("2024-01-15T00:00:00Z"),
        lastStatus: "success",
        lastError: null,
        item: {
          slug: "gdp-growth",
          displayName: "GDP Growth Rate",
          groupLabel: "Economic Indicators",
          defaultUnit: "%",
          metadata: { source: "government" }
        }
      },
      {
        id: "config-2",
        frequency: EconomicDataFrequency.WEEKLY,
        repeatCron: "0 0 * * 0",
        isEnabled: false,
        lastRunAt: null,
        lastStatus: null,
        lastError: "Connection timeout",
        item: {
          slug: "unemployment-rate",
          displayName: "Unemployment Rate",
          groupLabel: null,
          defaultUnit: null,
          metadata: null
        }
      }
    ];

    it("returns mapped EconomicDataFetchConfigModel array", async () => {
      (mockAkshareService.listFetchConfigs as jest.Mock).mockResolvedValue(sampleConfigs);

      const result = await resolver.economicDataFetchConfigs();

      expect(mockAkshareService.listFetchConfigs).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: "config-1",
        frequency: EconomicDataFrequency.DAILY,
        repeatCron: "0 0 * * *",
        isEnabled: true,
        item: {
          slug: "gdp-growth",
          displayName: "GDP Growth Rate"
        }
      });
    });

    it("correctly maps all config fields", async () => {
      (mockAkshareService.listFetchConfigs as jest.Mock).mockResolvedValue([sampleConfigs[0]]);

      const result = await resolver.economicDataFetchConfigs();

      expect(result[0]).toMatchObject({
        id: "config-1",
        frequency: EconomicDataFrequency.DAILY,
        repeatCron: "0 0 * * *",
        isEnabled: true,
        lastRunAt: new Date("2024-01-15T00:00:00Z"),
        lastStatus: "success"
      });
      expect(result[0].lastError).toBeUndefined();
    });

    it("handles nullable fields (lastRunAt, lastStatus, lastError, groupLabel)", async () => {
      (mockAkshareService.listFetchConfigs as jest.Mock).mockResolvedValue([sampleConfigs[1]]);

      const result = await resolver.economicDataFetchConfigs();

      expect(result[0].lastRunAt).toBeUndefined();
      expect(result[0].lastStatus).toBeUndefined();
      expect(result[0].lastError).toBe("Connection timeout");
      expect(result[0].item.groupLabel).toBeUndefined();
      expect(result[0].item.defaultUnit).toBeNull();
      expect(result[0].item.metadata).toBeNull();
    });
  });

  describe("updateEconomicDataFetchConfig", () => {
    const updatedConfig = {
      id: "config-1",
      frequency: EconomicDataFrequency.WEEKLY,
      repeatCron: "0 0 * * 0",
      isEnabled: true,
      lastRunAt: new Date("2024-01-15T00:00:00Z"),
      lastStatus: "success",
      lastError: null,
      item: {
        displayName: "GDP Growth Rate",
        groupLabel: "Economic Indicators",
        defaultUnit: "%",
        metadata: { source: "government" }
      }
    };

    it("calls updateFetchConfig with correct parameters", async () => {
      (mockAkshareService.updateFetchConfig as jest.Mock).mockResolvedValue(updatedConfig);

      await resolver.updateEconomicDataFetchConfig(
        "gdp-growth",
        EconomicDataFrequency.WEEKLY,
        "0 0 * * 0",
        true
      );

      expect(mockAkshareService.updateFetchConfig).toHaveBeenCalledWith("gdp-growth", {
        frequency: EconomicDataFrequency.WEEKLY,
        repeatCron: "0 0 * * 0",
        isEnabled: true
      });
    });

    it("returns updated config with all fields mapped", async () => {
      (mockAkshareService.updateFetchConfig as jest.Mock).mockResolvedValue(updatedConfig);

      const result = await resolver.updateEconomicDataFetchConfig(
        "gdp-growth",
        EconomicDataFrequency.WEEKLY,
        "0 0 * * 0",
        true
      );

      expect(result).toMatchObject({
        id: "config-1",
        frequency: EconomicDataFrequency.WEEKLY,
        repeatCron: "0 0 * * 0",
        isEnabled: true,
        lastRunAt: new Date("2024-01-15T00:00:00Z"),
        lastStatus: "success",
        item: {
          slug: "gdp-growth",
          displayName: "GDP Growth Rate",
          groupLabel: "Economic Indicators",
          defaultUnit: "%",
          metadata: { source: "government" }
        }
      });
      expect(result.lastError).toBeUndefined();
    });

    it("handles partial updates (only frequency)", async () => {
      const partialUpdate = { ...updatedConfig, frequency: EconomicDataFrequency.MONTHLY };
      (mockAkshareService.updateFetchConfig as jest.Mock).mockResolvedValue(partialUpdate);

      await resolver.updateEconomicDataFetchConfig(
        "gdp-growth",
        EconomicDataFrequency.MONTHLY,
        undefined,
        undefined
      );

      expect(mockAkshareService.updateFetchConfig).toHaveBeenCalledWith("gdp-growth", {
        frequency: EconomicDataFrequency.MONTHLY,
        repeatCron: null,
        isEnabled: undefined
      });
    });

    it("handles partial updates (only isEnabled)", async () => {
      const partialUpdate = { ...updatedConfig, isEnabled: false };
      (mockAkshareService.updateFetchConfig as jest.Mock).mockResolvedValue(partialUpdate);

      await resolver.updateEconomicDataFetchConfig(
        "gdp-growth",
        undefined,
        undefined,
        false
      );

      expect(mockAkshareService.updateFetchConfig).toHaveBeenCalledWith("gdp-growth", {
        frequency: undefined,
        repeatCron: null,
        isEnabled: false
      });
    });

    it("handles null repeatCron conversion", async () => {
      (mockAkshareService.updateFetchConfig as jest.Mock).mockResolvedValue(updatedConfig);

      await resolver.updateEconomicDataFetchConfig(
        "gdp-growth",
        EconomicDataFrequency.DAILY,
        undefined,
        true
      );

      expect(mockAkshareService.updateFetchConfig).toHaveBeenCalledWith("gdp-growth", {
        frequency: EconomicDataFrequency.DAILY,
        repeatCron: null,
        isEnabled: true
      });
    });

    it("handles missing item in response by using slug as displayName fallback", async () => {
      const configWithoutItem = {
        ...updatedConfig,
        item: undefined
      };
      (mockAkshareService.updateFetchConfig as jest.Mock).mockResolvedValue(configWithoutItem);

      const result = await resolver.updateEconomicDataFetchConfig(
        "gdp-growth",
        EconomicDataFrequency.WEEKLY
      );

      expect(result.item.slug).toBe("gdp-growth");
      expect(result.item.displayName).toBe("gdp-growth");
    });
  });

  describe("triggerDataFetch", () => {
    it("calls triggerDataFetch with input slugs array", async () => {
      (mockAkshareService.triggerDataFetch as jest.Mock).mockResolvedValue(undefined);

      await resolver.triggerDataFetch({ slugs: ["gdp-growth", "unemployment-rate"] });

      expect(mockAkshareService.triggerDataFetch).toHaveBeenCalledWith([
        "gdp-growth",
        "unemployment-rate"
      ]);
    });

    it("returns true on successful trigger", async () => {
      (mockAkshareService.triggerDataFetch as jest.Mock).mockResolvedValue(undefined);

      const result = await resolver.triggerDataFetch({ slugs: ["gdp-growth"] });

      expect(result).toBe(true);
    });

    it("handles single slug input", async () => {
      (mockAkshareService.triggerDataFetch as jest.Mock).mockResolvedValue(undefined);

      const result = await resolver.triggerDataFetch({ slugs: ["single-slug"] });

      expect(mockAkshareService.triggerDataFetch).toHaveBeenCalledWith(["single-slug"]);
      expect(result).toBe(true);
    });

    it("handles multiple slugs input", async () => {
      (mockAkshareService.triggerDataFetch as jest.Mock).mockResolvedValue(undefined);

      const result = await resolver.triggerDataFetch({
        slugs: ["slug-1", "slug-2", "slug-3", "slug-4"]
      });

      expect(mockAkshareService.triggerDataFetch).toHaveBeenCalledWith([
        "slug-1",
        "slug-2",
        "slug-3",
        "slug-4"
      ]);
      expect(result).toBe(true);
    });
  });
});
