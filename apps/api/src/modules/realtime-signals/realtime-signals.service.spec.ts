import { REALTIME_SIGNALS_INGEST_LOCK_TTL_MS } from "./realtime-signals.constants";
import { RealtimeSignalsService } from "./realtime-signals.service";
import type { RealtimeSignalsRuntimeConfig } from "./realtime-signals.types";

const runtimeConfig: RealtimeSignalsRuntimeConfig = {
  enabled: true,
  requestTimeoutMs: 10_000,
  maxRetries: 0,
  sources: {
    adsb: { enabled: true, intervalSec: 60 },
    ais: { enabled: true, intervalSec: 60 },
    unrest: { enabled: true, intervalSec: 60 },
    outages: { enabled: true, intervalSec: 60 },
    keyword_spike: { enabled: true, intervalSec: 60 },
    pizzint: { enabled: true, intervalSec: 60 },
    gdelt_tension: { enabled: true, intervalSec: 60 },
    polymarket_leads: { enabled: true, intervalSec: 60 },
  },
  thresholds: {
    keywordSpikeMinCount: 3,
    keywordSpikeMultiplier: 2,
    predictionShiftThreshold: 10,
    predictionNewsActivityThreshold: 5,
  },
  relay: {},
  adsb: {},
  credentials: {
    acledAccessToken: "token",
  },
  polymarket: {},
};

describe("RealtimeSignalsService unrest merge", () => {
  const buildService = () =>
    new RealtimeSignalsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  it("fetches ADS-B military feed from configured endpoint", async () => {
    const service = buildService();
    const runtime = {
      ...runtimeConfig,
      adsb: { baseUrl: "https://api.adsb.lol/" },
    } satisfies RealtimeSignalsRuntimeConfig;
    const fetchJsonSpy = jest.spyOn(service as any, "fetchJsonWithRetry").mockResolvedValue({
      total: 3,
      ac: [{ r: "USAF1" }],
    });

    const result = await (service as any).fetchAdsbSignal(runtime);

    expect(fetchJsonSpy).toHaveBeenCalledWith(
      "https://api.adsb.lol/v2/mil",
      runtime,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      metricSlug: "realtime.adsb.military_flights",
      value: 3,
      context: {
        source: "adsb",
        totalAircraft: 1,
        militaryCount: 3,
      },
    });
  });

  it("deduplicates unrest events by rounded geo/date key and prefers ACLED", () => {
    const service = buildService();
    const acled = [
      {
        id: "acled-1",
        lat: 10.04,
        lon: 20.04,
        occurredAt: "2026-03-01T10:00:00.000Z",
        source: "acled" as const,
        countryCode: "US",
        reports: 1,
      },
    ];
    const gdelt = [
      {
        id: "gdelt-1",
        lat: 10.03,
        lon: 20.02,
        occurredAt: "2026-03-01T12:00:00.000Z",
        source: "gdelt" as const,
        countryCode: "US",
        reports: 8,
      },
      {
        id: "gdelt-2",
        lat: 35.2,
        lon: 45.1,
        occurredAt: "2026-03-01T08:00:00.000Z",
        source: "gdelt" as const,
        countryCode: "IQ",
        reports: 6,
      },
    ];

    const merged = (service as any).mergeUnrestEvents(acled, gdelt) as {
      id: string;
      source: "acled" | "gdelt";
      countryCode?: string;
    }[];

    expect(merged).toHaveLength(2);
    expect(merged.some((entry) => entry.id === "gdelt-2")).toBe(true);
    const overlapEntry = merged.find((entry) => entry.id !== "gdelt-2");
    expect(overlapEntry?.source).toBe("acled");
    expect(overlapEntry?.countryCode).toBe("US");
  });

  it("reports acled+gdelt source when both feeds contributed", async () => {
    const service = buildService();
    const acled = [
      {
        id: "acled-1",
        lat: 10.04,
        lon: 20.04,
        occurredAt: "2026-03-01T10:00:00.000Z",
        source: "acled" as const,
        countryCode: "US",
        reports: 1,
      },
    ];
    const gdelt = [
      {
        id: "gdelt-1",
        lat: 10.03,
        lon: 20.02,
        occurredAt: "2026-03-01T12:00:00.000Z",
        source: "gdelt" as const,
        countryCode: "US",
        reports: 8,
      },
    ];
    jest
      .spyOn(service as any, "fetchAcledUnrestEvents")
      .mockResolvedValue(acled);
    jest
      .spyOn(service as any, "fetchGdeltUnrestEvents")
      .mockResolvedValue(gdelt);

    const result = await (service as any).fetchUnrestSignal(runtimeConfig);
    const metric = result[0];

    expect(metric.value).toBe(1);
    expect(metric.context).toMatchObject({
      source: "acled+gdelt",
      unrestCount: 1,
      acledCount: 1,
      gdeltCount: 1,
      dedupeReducedBy: 1,
    });
  });
});

describe("RealtimeSignalsService insight snapshot freshness", () => {
  const buildService = () => {
    const prisma = {
      org: {
        findMany: jest.fn(),
      },
    };
    const cache = {
      withLock: jest.fn(),
    };
    const store = {
      getInsightSnapshot: jest.fn(),
      getLastRun: jest.fn(),
      appendPoint: jest.fn(),
      setLastRun: jest.fn(),
      setInsightSnapshot: jest.fn(),
      evaluateMetric: jest.fn(),
    };
    const settings = {
      getRuntimeConfig: jest.fn().mockResolvedValue(runtimeConfig),
    };
    const service = new RealtimeSignalsService(
      prisma as any,
      cache as any,
      {} as any,
      store as any,
      settings as any,
    );
    return { service, prisma, cache, store, settings };
  };

  it("preserves recent insight snapshots when source interval is not due yet", async () => {
    const now = Date.parse("2026-03-03T00:00:00.000Z");
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
    const { service, store } = buildService();
    const currentSnapshot = {
      keywordSpikes: [
        {
          id: "keyword:1",
          term: "escalation",
          count: 9,
          baseline: 3,
          multiplier: 3,
          sourceCount: 4,
          confidence: 0.82,
        },
      ],
      predictionLeads: [
        {
          id: "lead:1",
          title: "Example lead",
          shift: 12,
          newsActivity: 1,
          confidence: 0.7,
        },
      ],
      tensions: [
        {
          id: "tension:1",
          label: "US / CN",
          score: 72,
          changePercent: 8,
          trend: "rising" as const,
          countries: ["US", "CN"],
          updatedAt: "2026-03-03T00:00:00.000Z",
        },
      ],
      pizzint: {
        defcon: 3,
        adjustedScore: 2.4,
        openLocations: 12,
        activeSpikes: 5,
        avgPop: 42,
        updatedAt: "2026-03-03T00:00:00.000Z",
      },
    };

    store.getInsightSnapshot.mockResolvedValue(currentSnapshot);
    store.getLastRun.mockResolvedValue(now - 30_000);
    const fetchSourceSpy = jest.spyOn(service as any, "fetchSource");

    await service.refreshOrg("org-1", runtimeConfig);

    expect(fetchSourceSpy).not.toHaveBeenCalled();
    expect(store.setInsightSnapshot).toHaveBeenCalledWith(
      "org-1",
      currentSnapshot,
    );

    nowSpy.mockRestore();
  });

  it("clears stale insight snapshots when due refresh attempts fail", async () => {
    const now = Date.parse("2026-03-03T00:00:00.000Z");
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
    const { service, store } = buildService();

    store.getInsightSnapshot.mockResolvedValue({
      keywordSpikes: [
        {
          id: "keyword:1",
          term: "old",
          count: 5,
          baseline: 2,
          multiplier: 2.5,
          sourceCount: 3,
          confidence: 0.6,
        },
      ],
      predictionLeads: [
        {
          id: "lead:1",
          title: "old lead",
          shift: 8,
          newsActivity: 1,
          confidence: 0.6,
        },
      ],
      tensions: [
        {
          id: "tension:1",
          label: "Old tension",
          score: 55,
          changePercent: 3,
          trend: "stable" as const,
          countries: ["US", "RU"],
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      pizzint: {
        defcon: 2,
        adjustedScore: 1.3,
        openLocations: 7,
        activeSpikes: 2,
        avgPop: 18,
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    });
    store.getLastRun.mockResolvedValue(now - 10 * 60_000);
    jest
      .spyOn(service as any, "fetchSource")
      .mockRejectedValue(new Error("fetch failed"));

    await service.refreshOrg("org-1", runtimeConfig);

    expect(store.setInsightSnapshot).toHaveBeenCalledWith("org-1", {
      keywordSpikes: [],
      predictionLeads: [],
      tensions: [],
    });
    expect(store.setLastRun).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  it("drops stale insight entries when serving situation monitor snapshot", async () => {
    const now = Date.parse("2026-03-03T00:00:00.000Z");
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
    const { service, store } = buildService();

    store.getInsightSnapshot.mockResolvedValue({
      keywordSpikes: [{ id: "keyword:1", term: "old", count: 5, baseline: 2, multiplier: 2.5, sourceCount: 3, confidence: 0.6 }],
      predictionLeads: [{ id: "lead:1", title: "old lead", shift: 8, newsActivity: 1, confidence: 0.6 }],
      tensions: [{ id: "tension:1", label: "Old tension", score: 55, changePercent: 3, trend: "stable" as const, countries: ["US"], updatedAt: "2026-03-01T00:00:00.000Z" }],
      pizzint: { defcon: 2, adjustedScore: 1.3, openLocations: 7, activeSpikes: 2, avgPop: 18, updatedAt: "2026-03-01T00:00:00.000Z" },
    });
    store.getLastRun.mockResolvedValue(now - 20 * 60_000);

    const snapshot = await service.getSituationMonitorInsightSnapshot("org-1");

    expect(snapshot).toEqual({
      keywordSpikes: [],
      predictionLeads: [],
      tensions: [],
    });

    nowSpy.mockRestore();
  });
});

describe("RealtimeSignalsService scheduler lock", () => {
  it("uses the configured ingest lock TTL for cron refresh", async () => {
    const prisma = {
      org: {
        findMany: jest.fn().mockResolvedValue([{ id: "org-1" }]),
      },
    };
    const cache = {
      withLock: jest.fn(async (_key: string, _ttlMs: number, runner: () => Promise<void>) => {
        await runner();
      }),
    };
    const settings = {
      getRuntimeConfig: jest.fn().mockResolvedValue(runtimeConfig),
    };
    const service = new RealtimeSignalsService(
      prisma as any,
      cache as any,
      {} as any,
      {} as any,
      settings as any,
    );
    jest.spyOn(service, "refreshOrg").mockResolvedValue();

    await service.refreshScheduled();

    expect(cache.withLock).toHaveBeenCalledWith(
      "cron:realtime-signals",
      REALTIME_SIGNALS_INGEST_LOCK_TTL_MS,
      expect.any(Function),
    );
  });
});
