import { Prisma } from "@prisma/client";

import { AkshareService } from "./akshare.service";

describe("AkshareService bulk upsert", () => {
  const createService = () => {
    const prismaMock = {
      $executeRaw: jest.fn()
    };

    const service = new AkshareService(prismaMock as any, {} as any, {} as any, {} as any, {} as any);

    return { prismaMock, service };
  };

  it("parameterizes sourceMeta instead of embedding raw JSON", () => {
    const { service } = createService();
    const dangerous = `{"note":"x'); DROP TABLE EconomicDataPoint; --"}`;

    const row = {
      recordedAt: new Date("2024-01-01T00:00:00.000Z"),
      dataType: "price",
      value: new Prisma.Decimal(1),
      unit: null,
      sourceField: "field",
      metaJson: dangerous,
      estimatedBytes: 0
    };

    const query = (service as any).buildUpsertDataPointsQuery("item", [row]) as Prisma.Sql;
    expect(query.sql).toContain("INSERT INTO");
    expect(query.sql).not.toContain("DROP TABLE");
    expect(query.values).toContain(dangerous);
  });

  it("chunks by estimated bytes, not only row count", async () => {
    const { prismaMock, service } = createService();
    (service as any).dataPointBatchMaxBytes = 200;
    prismaMock.$executeRaw.mockResolvedValue(1);

    const points = Array.from({ length: 3 }).map((_, index) => ({
      recordedAt: new Date(1_700_000_000_000 + index),
      value: 1,
      unit: null,
      dataType: "price",
      sourceField: `field-${index}`,
      meta: { text: "x".repeat(500) }
    }));

    const stored = await (service as any).bulkUpsertDataPoints("item", points);
    expect(stored).toBe(3);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it("splits and retries when max_allowed_packet is exceeded", async () => {
    const { prismaMock, service } = createService();
    (service as any).dataPointBatchMaxBytes = 99_999_999;
    let callCount = 0;

    prismaMock.$executeRaw.mockImplementation(async (query: any) => {
      callCount += 1;
      if (Array.isArray(query?.values) && query.values.length > 7) {
        const error: any = new Error("Raw query failed");
        error.code = "P2010";
        error.meta = { code: "1153", message: "Got a packet bigger than 'max_allowed_packet' bytes" };
        throw error;
      }
      return 1;
    });

    const points = [
      {
        recordedAt: new Date("2024-01-01T00:00:00.000Z"),
        value: 1,
        unit: null,
        dataType: "price",
        sourceField: "a",
        meta: { a: 1 }
      },
      {
        recordedAt: new Date("2024-01-02T00:00:00.000Z"),
        value: 1,
        unit: null,
        dataType: "price",
        sourceField: "b",
        meta: { b: 1 }
      }
    ];

    const stored = await (service as any).bulkUpsertDataPoints("item", points);
    expect(stored).toBe(2);
    expect(callCount).toBe(3);
  });
});

