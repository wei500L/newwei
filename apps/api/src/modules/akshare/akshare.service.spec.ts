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
      if (Array.isArray(query?.values) && query.values.length > 8) {
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

describe("AkshareService parsers", () => {
  const createService = () => {
    const prismaMock = {
      $executeRaw: jest.fn()
    };

    const service = new AkshareService(prismaMock as any, {} as any, {} as any, {} as any, {} as any);

    return { prismaMock, service };
  };

  it("parses intraday clock strings as Asia/Shanghai timestamps", () => {
    const { service } = createService();
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
      expect((service as any).parseDate("9:30:00").toISOString()).toBe("2026-01-10T01:30:00.000Z");
      expect((service as any).parseDate("093000").toISOString()).toBe("2026-01-10T01:30:00.000Z");
      expect((service as any).parseDate("0930").toISOString()).toBe("2026-01-10T01:30:00.000Z");
    } finally {
      jest.useRealTimers();
    }
  });

  it("resolves dynamic date templates in params", () => {
    const { service } = createService();
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
      const resolved = (service as any).resolveParams({
        start_date: "${TODAY_YYYYMMDD-2}",
        end_date: "${TODAY_YYYYMMDD+1}",
        untouched: "x"
      });
      expect(resolved).toEqual({
        start_date: "20260108",
        end_date: "20260111",
        untouched: "x"
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("parses year+month payload into UTC timestamps", () => {
    const { service } = createService();
    const parser = {
      type: "yearMonth",
      yearField: "year",
      monthField: "month",
      valueFields: [
        {
          field: "China_Policy_Index",
          label: "China EPU",
          unit: "index",
          dataType: "index"
        }
      ]
    };

    const payload = [
      { year: 1995, month: 1, China_Policy_Index: 192.91191 },
      { year: "1995", month: "2", China_Policy_Index: "200.5" }
    ];

    const points = (service as any).parsePayload(parser, payload, { slug: "china_epu_index" });
    expect(points).toHaveLength(2);
    expect(points[0]?.recordedAt.toISOString()).toBe("1995-01-01T00:00:00.000Z");
    expect(points[0]?.value).toBeCloseTo(192.91191);
    expect(points[1]?.recordedAt.toISOString()).toBe("1995-02-01T00:00:00.000Z");
    expect(points[1]?.value).toBeCloseTo(200.5);
  });

  it("does not throw when deduping timeseries payload rows", () => {
    const { service } = createService();
    const parser = {
      type: "timeseries",
      timestampField: "date",
      valueFields: [{ field: "x", dataType: "index" }]
    };
    const payload = [
      { date: "2024-01-01", x: 1 },
      { date: "2024-01-01", x: 2 }
    ];

    const points = (service as any).parsePayload(parser, payload);
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(1);
  });
});
