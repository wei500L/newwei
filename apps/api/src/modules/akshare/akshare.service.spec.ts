import { EconomicDataFrequency, EconomicDataValueType, Prisma } from "@prisma/client";

import { AkshareService } from "./akshare.service";

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
            item: { defaultFrequency: EconomicDataFrequency.daily }
          },
          {
            id: "p2",
            itemId: "item2",
            recordedAt: new Date("2024-01-04T00:00:00Z"),
            value: new Prisma.Decimal(100),
            unit: null,
            sourceField: "value",
            dataType: EconomicDataValueType.index,
            item: { defaultFrequency: EconomicDataFrequency.daily }
          },
          {
            id: "p3",
            itemId: "item1",
            recordedAt: new Date("2024-01-05T00:00:00Z"),
            value: new Prisma.Decimal(0),
            unit: null,
            sourceField: "value",
            dataType: EconomicDataValueType.index,
            item: { defaultFrequency: EconomicDataFrequency.daily }
          }
        ])
      },
      economicDataItem: {
        findMany: jest.fn().mockResolvedValue([
          { defaultFrequency: EconomicDataFrequency.daily },
          { defaultFrequency: EconomicDataFrequency.daily }
        ])
      }
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    const result = await service.getDataByCategory(
      "category",
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-31T00:00:00Z"),
      "week"
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
      item: { defaultFrequency: EconomicDataFrequency.daily }
    }));

    const prisma = {
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue(points)
      },
      economicDataItem: {
        findMany: jest.fn().mockResolvedValue([{ defaultFrequency: EconomicDataFrequency.daily }])
      }
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    const result = await service.getDataByCategory(
      "category",
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-07-31T00:00:00Z"),
      "month"
    );

    expect(prisma.economicDataPoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: undefined })
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
      item: { defaultFrequency: EconomicDataFrequency.hourly }
    }));

    const prisma = {
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue(points)
      },
      economicDataItem: {
        findMany: jest.fn().mockResolvedValue([{ defaultFrequency: EconomicDataFrequency.hourly }])
      }
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    const result = await service.getDataByCategory(
      "category",
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-31T00:00:00Z")
    );

    expect(prisma.economicDataPoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: undefined })
    );
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(150);
  });

  it("aligns the query window to the requested bucket boundaries when bucketing is enabled", async () => {
    const prisma = {
      economicDataPoint: {
        findMany: jest.fn().mockResolvedValue([])
      },
      economicDataItem: {
        findMany: jest.fn().mockResolvedValue([{ defaultFrequency: EconomicDataFrequency.hourly }])
      }
    };

    const service = new AkshareService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    const start = new Date("2024-01-01T10:15:30Z");
    const end = new Date("2024-01-01T12:45:00Z");

    await service.getDataByCategory("category", start, end, "hour");

    const callArg = (prisma.economicDataPoint.findMany as jest.Mock).mock.calls[0]?.[0] as any;
    expect(callArg?.where?.recordedAt?.gte?.toISOString()).toBe("2024-01-01T10:00:00.000Z");
    expect(callArg?.where?.recordedAt?.lte?.toISOString()).toBe("2024-01-01T12:59:59.999Z");
  });
});
