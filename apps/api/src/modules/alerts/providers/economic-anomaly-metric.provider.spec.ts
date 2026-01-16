import { AlertMetricProvider } from "@prisma/client";

import { EconomicAnomalyMetricProvider } from "./economic-anomaly-metric.provider";

describe("EconomicAnomalyMetricProvider.fetch", () => {
  const buildProvider = (overrides?: {
    forecast?: unknown;
    points?: Array<{ recordedAt: Date; value: number }>;
    latestValue?: number;
  }) => {
    const now = new Date("2026-01-16T12:00:00.000Z");
    const latestValue = overrides?.latestValue ?? 14;
    const rawPoints =
      overrides?.points ??
      Array.from({ length: 20 }).map((_, idx) => ({
        recordedAt: new Date(now.getTime() - (20 - idx - 1) * 60 * 60 * 1000),
        value: idx === 19 ? latestValue : 10 + idx * 0.1,
      }));
    const defaultPoints = [...rawPoints].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
    const prisma = {
      economicDataPoint: {
        findFirst: jest.fn().mockResolvedValue({
          itemId: "item-1",
          recordedAt: now,
          value: latestValue,
          sourceField: "default",
          item: {
            id: "item-1",
            displayName: "USD Index",
          },
        }),
        findMany: jest.fn().mockResolvedValue(defaultPoints),
      },
    } as any;

    const cache = {
      wrap: jest.fn(async (_key: string, _ttlSeconds: number, loader: () => Promise<unknown>) => loader()),
    } as any;

    const modelService = {
      forecastHoldoutLastBestEffort: jest.fn().mockResolvedValue(overrides?.forecast ?? null),
    } as any;

    const provider = new EconomicAnomalyMetricProvider(prisma, cache, modelService);
    return { provider, prisma, cache, modelService };
  };

  it("returns anomaly score from model service forecast", async () => {
    const { provider, modelService } = buildProvider({
      forecast: {
        model: { kind: "arima" },
        forecast: {
          timestamp: "2026-01-16T12:00:00.000Z",
          expected: 10,
          lower: 8,
          upper: 12,
          sigma: 2,
        },
        diagnostics: { n_train: 4 },
      },
      latestValue: 14,
    });

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.economic_anomaly,
      metricSlug: "usd_index_history",
      operator: "gte" as any,
      changeWindowMin: null,
      metadata: { modelKind: "arima", lookbackDays: 365, confidenceLevel: 0.95 },
    });

    expect(modelService.forecastHoldoutLastBestEffort).toHaveBeenCalledTimes(1);
    expect(result.latest).toBeCloseTo(2);
    expect(result.context?.observed).toBe(14);
    expect(result.context?.expected).toBe(10);
  });

  it("falls back to local detection when model service is unavailable", async () => {
    const now = new Date("2026-01-16T12:00:00.000Z");
    const { provider } = buildProvider({
      forecast: null,
      points: Array.from({ length: 40 }).map((_, idx) => ({
        recordedAt: new Date(now.getTime() - (40 - idx) * 60 * 60 * 1000),
        value: idx === 39 ? 100 : 10,
      })),
      latestValue: 100,
    });

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.economic_anomaly,
      metricSlug: "usd_index_history",
      operator: "gte" as any,
      changeWindowMin: null,
      metadata: { lookbackDays: 365 },
    });

    expect(typeof result.latest).toBe("number");
    expect((result.latest as number) >= 0).toBe(true);
    expect((result.context as any)?.model?.kind).toBe("fallback");
  });
});
