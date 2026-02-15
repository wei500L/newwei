import { Prisma } from "@prisma/client";
import { RssTranslationMetricsService } from "./rss-translation-metrics.service";

const prismaMock = {
  $executeRaw: jest.fn(),
  $queryRaw: jest.fn()
} as any;

describe("RssTranslationMetricsService", () => {
  let service: RssTranslationMetricsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.$executeRaw = jest.fn().mockResolvedValue(1);
    prismaMock.$queryRaw = jest.fn().mockResolvedValue([]);
    service = new RssTranslationMetricsService(prismaMock);
  });

  it("records daily metrics with upsert-style increment", async () => {
    await service.recordDaily({
      orgId: "org-1",
      provider: "llm",
      targetLanguage: "zh-CN",
      requestCount: 1,
      itemCount: 10,
      textCount: 20,
      cacheHitCount: 8,
      cacheMissCount: 12,
      translatedCount: 12,
      failureCount: 1,
      skipTooLongCount: 0,
      totalLatencyMs: 450,
      maxLatencyMs: 450
    });

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("skips writes for zero request count", async () => {
    await service.recordDaily({
      orgId: "org-1",
      provider: "llm",
      targetLanguage: "zh-CN",
      requestCount: 0,
      itemCount: 10,
      textCount: 20,
      cacheHitCount: 8,
      cacheMissCount: 12,
      translatedCount: 12,
      failureCount: 1,
      skipTooLongCount: 0,
      totalLatencyMs: 450,
      maxLatencyMs: 450
    });

    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("returns rows and summary metrics", async () => {
    prismaMock.$queryRaw = jest.fn().mockResolvedValue([
      {
        date: new Date("2026-02-15T00:00:00.000Z"),
        provider: "llm",
        targetLanguage: "zh-cn",
        requestCount: 2,
        itemCount: 10,
        textCount: 20,
        cacheHitCount: 8,
        cacheMissCount: 12,
        translatedCount: 12,
        failureCount: 1,
        skipTooLongCount: 1,
        totalLatencyMs: 600,
        maxLatencyMs: 350
      }
    ]);

    const result = await service.getDailyMetrics("org-1", {
      from: "2026-02-15",
      to: "2026-02-15"
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.avgLatencyMs).toBe(300);
    expect(result.summary.requestCount).toBe(2);
    expect(result.summary.cacheHitRate).toBeCloseTo(0.4);
  });

  it("returns empty metrics when the backing table is missing (raw query P2010/1146)", async () => {
    prismaMock.$queryRaw = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Raw query failed", {
        code: "P2010",
        clientVersion: "test",
        meta: {
          code: "1146",
          message: "Table 'app.RssTranslationMetricsDaily' doesn't exist"
        }
      })
    );

    const result = await service.getDailyMetrics("org-1", {
      from: "2026-02-02",
      to: "2026-02-15"
    });

    expect(result.rows).toHaveLength(0);
    expect(result.summary.requestCount).toBe(0);
  });
});
