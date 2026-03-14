import { ECONOMIC_DASHBOARD_REFRESH_PRESET } from "@modular/utils";
import { BadRequestException } from "@nestjs/common";
import {
  EconomicDataFrequency,
  EconomicDataRunStatus,
  EconomicDataValueType,
  Prisma,
} from "@prisma/client";

import { AkshareService } from "./akshare.service";

const writeAuditLogBestEffortMock = jest.fn().mockResolvedValue(undefined);

jest.mock("../audit/audit-log.writer", () => ({
  writeAuditLogBestEffort: (...args: unknown[]) =>
    writeAuditLogBestEffortMock(...args),
}));

describe("AkshareService.getDataByCategory", () => {
  it("buckets per-series (itemId + sourceField) so category queries do not mix indicators", async () => {
    const prisma = {
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "p1",
            itemId: "item1",
            recordedAt: new Date("2024-01-03T00:00:00Z"),
            value: new Prisma.Decimal(0),
            unit: null,
            sourceField: "value",
            dataType: EconomicDataValueType.index,
            item: { defaultFrequency: EconomicDataFrequency.daily },
          },
          {
            id: "p2",
            itemId: "item2",
            recordedAt: new Date("2024-01-04T00:00:00Z"),
            value: new Prisma.Decimal(100),
            unit: null,
            sourceField: "value",
            dataType: EconomicDataValueType.index,
            item: { defaultFrequency: EconomicDataFrequency.daily },
          },
          {
            id: "p3",
            itemId: "item1",
            recordedAt: new Date("2024-01-05T00:00:00Z"),
            value: new Prisma.Decimal(0),
            unit: null,
            sourceField: "value",
            dataType: EconomicDataValueType.index,
            item: { defaultFrequency: EconomicDataFrequency.daily },
          },
        ]),
      },
      economicDataItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { defaultFrequency: EconomicDataFrequency.daily },
            { defaultFrequency: EconomicDataFrequency.daily },
          ]),
      },
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getDataByCategory(
      "category",
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-31T00:00:00Z"),
      "week",
    );

    expect(Array.isArray(result)).toBe(true);
    const points = result as Array<{ itemId: string; value: Prisma.Decimal }>;

    const itemIds = points.map((point) => point.itemId).sort();
    expect(itemIds).toEqual(["item1", "item2"]);

    const item2Point = points.find((point) => point.itemId === "item2");
    expect(item2Point).toBeDefined();
    expect(Number(item2Point?.value)).toBe(100);
  });

  it("does not truncate raw points when granularity bucketing is requested (buckets cover the full range)", async () => {
    const points = Array.from({ length: 200 }, (_, index) => ({
      id: `p-${index}`,
      itemId: "item1",
      recordedAt: new Date(Date.UTC(2024, 0, 1 + index)),
      value: new Prisma.Decimal(1),
      unit: null,
      sourceField: "value",
      dataType: EconomicDataValueType.index,
      item: { defaultFrequency: EconomicDataFrequency.daily },
    }));

    const prisma = {
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue(points),
      },
      economicDataItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { defaultFrequency: EconomicDataFrequency.daily },
          ]),
      },
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getDataByCategory(
      "category",
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-07-31T00:00:00Z"),
      "month",
    );

    expect(prisma.economicDataPoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: undefined }),
    );
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(7);
  });

  it("returns the full raw point window when pagination is omitted", async () => {
    const points = Array.from({ length: 150 }, (_, index) => ({
      id: `p-${index}`,
      itemId: "item1",
      recordedAt: new Date(Date.UTC(2024, 0, 1, 0, index)),
      value: new Prisma.Decimal(index),
      unit: null,
      sourceField: "value",
      dataType: EconomicDataValueType.index,
      item: { defaultFrequency: EconomicDataFrequency.hourly },
    }));

    const prisma = {
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue(points),
      },
      economicDataItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { defaultFrequency: EconomicDataFrequency.hourly },
          ]),
      },
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getDataByCategory(
      "category",
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-31T00:00:00Z"),
    );

    expect(prisma.economicDataPoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: undefined }),
    );
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(150);
  });

  it("aligns the query window to the requested bucket boundaries when bucketing is enabled", async () => {
    const prisma = {
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      economicDataItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { defaultFrequency: EconomicDataFrequency.hourly },
          ]),
      },
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const start = new Date("2024-01-01T10:15:30Z");
    const end = new Date("2024-01-01T12:45:00Z");

    await service.getDataByCategory("category", start, end, "hour");

    const callArg = (prisma.economicDataPoint.findMany as jest.Mock).mock
      .calls[0]?.[0] as any;
    expect(callArg?.where?.recordedAt?.gte?.toISOString()).toBe(
      "2024-01-01T10:00:00.000Z",
    );
    expect(callArg?.where?.recordedAt?.lte?.toISOString()).toBe(
      "2024-01-01T12:59:59.999Z",
    );
  });
});

describe("AkshareService.triggerDataFetchForPreset", () => {
  beforeEach(() => {
    writeAuditLogBestEffortMock.mockClear();
  });

  it("queues enabled active item slugs for the selected preset category", async () => {
    const prisma = {
      economicDataFetchConfig: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { item: { slug: "china_cpi" } },
            { item: { slug: "china_cpi" } },
            { item: { slug: "china_ppi" } },
          ]),
      },
    };
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AkshareService(
      prisma as any,
      queue as any,
      {} as any,
      {} as any,
    );

    await service.triggerDataFetchForPreset(
      ECONOMIC_DASHBOARD_REFRESH_PRESET.economicAlert,
    );

    expect(prisma.economicDataFetchConfig.findMany).toHaveBeenCalledWith({
      where: {
        isEnabled: true,
        item: {
          isActive: true,
          categories: {
            some: {
              category: {
                key: "economic-alert",
              },
            },
          },
        },
      },
      select: {
        item: {
          select: {
            slug: true,
          },
        },
      },
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      "manual-fetch",
      expect.objectContaining({ dataItemId: "china_cpi" }),
      { removeOnComplete: true },
    );
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      "manual-fetch",
      expect.objectContaining({ dataItemId: "china_ppi" }),
      { removeOnComplete: true },
    );
    expect(writeAuditLogBestEffortMock).not.toHaveBeenCalled();
  });

  it("writes an audit log when actor context is provided", async () => {
    const prisma = {
      economicDataFetchConfig: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ item: { slug: "china_cpi" } }]),
      },
    };
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AkshareService(
      prisma as any,
      queue as any,
      {} as any,
      {} as any,
    );

    await service.triggerDataFetchForPreset(
      ECONOMIC_DASHBOARD_REFRESH_PRESET.economicAlert,
      {
        actorId: "user-1",
        orgId: "org-1",
        ipAddress: "10.0.0.1",
      },
    );

    expect(writeAuditLogBestEffortMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org-1",
          actorId: "user-1",
          resource: "economic_data",
          action: "manual_refresh_trigger",
          ipAddress: "10.0.0.1",
          metadata: expect.objectContaining({
            preset: ECONOMIC_DASHBOARD_REFRESH_PRESET.economicAlert,
            categoryKey: "economic-alert",
            slugCount: 1,
            slugs: ["china_cpi"],
          }),
        }),
      }),
      expect.objectContaining({
        orgId: "org-1",
        actorId: "user-1",
        preset: ECONOMIC_DASHBOARD_REFRESH_PRESET.economicAlert,
      }),
    );
  });

  it("rejects presets without enabled configured slugs", async () => {
    const prisma = {
      economicDataFetchConfig: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn() } as any,
      {} as any,
    );

    await expect(
      service.triggerDataFetchForPreset(
        ECONOMIC_DASHBOARD_REFRESH_PRESET.livelihoodPrices,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("returns the latest enabled preset status summary", async () => {
    const service = new AkshareService(
      {
        economicDataFetchConfig: {
          findMany: jest.fn().mockResolvedValue([
            {
              isEnabled: true,
              lastRunAt: new Date("2026-03-12T10:00:00Z"),
              lastStatus: EconomicDataRunStatus.success,
              lastError: null,
              item: { isActive: true },
            },
            {
              isEnabled: true,
              lastRunAt: new Date("2026-03-12T11:00:00Z"),
              lastStatus: EconomicDataRunStatus.failed,
              lastError: "timeout",
              item: { isActive: true },
            },
            {
              isEnabled: false,
              lastRunAt: new Date("2026-03-12T12:00:00Z"),
              lastStatus: EconomicDataRunStatus.success,
              lastError: null,
              item: { isActive: true },
            },
          ]),
        },
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const summary = await service.getRefreshPresetStatus(
      ECONOMIC_DASHBOARD_REFRESH_PRESET.livelihoodPrices,
    );

    expect(summary).toEqual({
      preset: ECONOMIC_DASHBOARD_REFRESH_PRESET.livelihoodPrices,
      categoryKey: "livelihood-prices",
      totalItems: 3,
      enabledItems: 2,
      lastRunAt: new Date("2026-03-12T11:00:00Z"),
      lastStatus: EconomicDataRunStatus.failed,
      lastError: "timeout",
    });
  });
});

describe("AkshareService.ensureCatalog", () => {
  it("force-syncs sp500_index source metadata when the catalog still points to legacy akshare history", async () => {
    const prisma = {
      economicCategory: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "category-key-monitor",
            key: "key-monitor",
          },
        ]),
        createMany: jest.fn().mockResolvedValue(undefined),
      },
      economicDataItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "item-sp500",
            slug: "sp500_index",
            displayName: "标普500指数",
            groupLabel: "key-monitor",
            description: "legacy",
            sourceFunction: "ak.index_global_hist_em",
            sourceEndpoint: "/index_global_hist_em",
            sourceDocUrl: "https://akshare.akfamily.xyz/data/index/index.html",
            valueType: EconomicDataValueType.index,
            defaultUnit: "pts",
            defaultFrequency: EconomicDataFrequency.daily,
            metadata: {
              method: "GET",
              defaultParams: {
                year: "2018",
              },
              parser: {
                type: "timeseries",
                timestampField: "date",
                valueFields: [
                  {
                    field: "open",
                    dataType: EconomicDataValueType.index,
                    unit: "pts",
                  },
                  {
                    field: "high",
                    dataType: EconomicDataValueType.index,
                    unit: "pts",
                  },
                  {
                    field: "low",
                    dataType: EconomicDataValueType.index,
                    unit: "pts",
                  },
                  {
                    field: "close",
                    dataType: EconomicDataValueType.index,
                    unit: "pts",
                  },
                ],
              },
              providerKind: "akshare",
            },
            categories: [
              {
                category: {
                  id: "category-key-monitor",
                  key: "key-monitor",
                },
              },
            ],
            fetchConfig: {
              id: "fetch-sp500",
            },
          },
        ]),
        update: jest.fn().mockResolvedValue(undefined),
        createMany: jest.fn().mockResolvedValue(undefined),
      },
      economicDataItemCategory: {
        createMany: jest.fn().mockResolvedValue(undefined),
      },
      economicDataFetchConfig: {
        createMany: jest.fn().mockResolvedValue(undefined),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (operations: Promise<unknown>[]) =>
          Promise.all(operations),
        ),
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest.spyOn(service, "definitions", "get").mockReturnValue([
      {
        id: "sp500-index",
        slug: "sp500_index",
        displayName: "标普500指数",
        categories: ["key-monitor"],
        sourceFunction: "yfinance.history",
        endpoint: "/v8/finance/chart",
        docUrl: "https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.history.html",
        valueType: EconomicDataValueType.index,
        defaultUnit: "pts",
        defaultFrequency: EconomicDataFrequency.daily,
        provider: "yfinance",
        providerConfig: {
          kind: "yfinance",
          symbol: "^GSPC",
          endpoint: "/v8/finance/chart",
          docUrl:
            "https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.history.html",
          interval: "1d",
          period1: 0,
          period2: "now",
          includePrePost: false,
          events: "div,splits",
          sourceFields: {
            open: "open",
            high: "high",
            low: "low",
            close: "close",
          },
        },
        defaultEnabled: true,
        mainlineRole: "canonical",
        tags: [],
      },
    ]);

    await service.ensureCatalog();

    expect(prisma.economicDataItem.update).toHaveBeenCalledWith({
      where: { id: "item-sp500" },
      data: expect.objectContaining({
        sourceFunction: "yfinance.history",
        sourceEndpoint: "/v8/finance/chart",
        sourceDocUrl:
          "https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.history.html",
        metadata: expect.objectContaining({
          providerKind: "yfinance",
          providerConfig: expect.objectContaining({
            kind: "yfinance",
            symbol: "^GSPC",
          }),
          defaultParams: null,
          parser: null,
          filter: null,
        }),
      }),
    });
  });
});
