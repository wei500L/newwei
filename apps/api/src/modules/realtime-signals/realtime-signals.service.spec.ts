import { ProcessedItemModel } from "@modular/mongo";
import { REALTIME_SIGNALS_INGEST_LOCK_TTL_MS } from "./realtime-signals.constants";
import { RealtimeSignalsService } from "./realtime-signals.service";
import type { RealtimeSignalsRuntimeConfig } from "./realtime-signals.types";

const runtimeConfig: RealtimeSignalsRuntimeConfig = {
  enabled: true,
  requestTimeoutMs: 10_000,
  maxRetries: 0,
  capabilities: {
    acledApiEnabled: false,
    acledApiDisabledReason: "Open myACLED does not include API access.",
  },
  sources: {
    opensky: { enabled: true, intervalSec: 60 },
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
  opensky: {
    baseUrl: "https://opensky-network.org/api",
    tokenUrl:
      "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
    clientId: "opensky-client",
    clientSecret: "opensky-secret",
  },
  credentials: {
    acledAccessToken: "token",
  },
  polymarket: {},
};

describe("RealtimeSignalsService unrest merge", () => {
  const buildService = () => {
    const store = {
      getLatestAdsbSnapshot: jest.fn().mockResolvedValue(null),
      setLatestAdsbSnapshot: jest.fn(),
      clearLatestAdsbSnapshot: jest.fn(),
    };
    const service = new RealtimeSignalsService(
      {} as any,
      {} as any,
      {} as any,
      store as any,
      {} as any,
    );
    return { service, store };
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it("fetches OpenSky military feed through the conservative adapter", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-03-02T12:00:00.000Z"));
    const { service, store } = buildService();
    jest
      .spyOn(service as any, "fetchConservativeMilitaryOpenSkyStates")
      .mockResolvedValue([
        {
          icao24: "ae017a",
          callsign: "RCH416",
          countryName: "United States",
          lastContactAt: "2026-03-02T11:59:50.000Z",
          lastContactMs: Date.parse("2026-03-02T11:59:50.000Z"),
          latitude: 39.315491,
          longitude: -99.342797,
          heading: 261.89,
          altitudeFt: 35975,
          groundSpeedKt: 376,
          raw: [
            "ae017a",
            "RCH416 ",
            "United States",
            1_772_452_780,
            1_772_452_790,
            -99.342797,
            39.315491,
            10_966.38,
            false,
            193.3,
            261.89,
            0,
            null,
            10_966.38,
          ],
        },
        {
          icao24: "ae6400",
          callsign: "RRR9001",
          countryName: "United Kingdom",
          lastContactAt: "2026-03-02T11:59:55.000Z",
          lastContactMs: Date.parse("2026-03-02T11:59:55.000Z"),
          latitude: 35.002242,
          longitude: -97.471051,
          raw: [
            "ae6400",
            "RRR9001",
            "United Kingdom",
            1_772_452_785,
            1_772_452_795,
            -97.471051,
            35.002242,
            null,
            false,
            null,
            null,
            0,
            null,
            null,
          ],
        },
      ]);

    const result = await (service as any).fetchAdsbSignal(
      "org-1",
      runtimeConfig,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      metricSlug: "realtime.opensky.military_flights",
      value: 2,
      context: {
        source: "opensky",
        scope: "military",
        totalAircraft: 2,
        militaryCount: 2,
        validPositionCount: 2,
        snapshotValidPositionCount: 2,
        snapshotRetainedPrevious: false,
        snapshotFreshness: "fresh",
        staleThresholdSec: 600,
        droppedStalePositionCount: 0,
        deduplicatedCount: 0,
        countryCodes: ["GB", "US"],
      },
    });
    expect(result[1]).toMatchObject({
      metricSlug: "realtime.opensky.snapshot_health",
      value: 0,
      context: {
        source: "opensky",
        healthState: "fresh",
        stale: false,
        snapshotRetainedPrevious: false,
        currentValidPositionCount: 2,
        snapshotValidPositionCount: 2,
        rawAircraftCount: 2,
        maxStaleMinutes: 10,
        countryCodes: ["GB", "US"],
      },
    });
    expect(store.setLatestAdsbSnapshot).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        source: "opensky",
        sourceEndpoint:
          "https://opensky-network.org/api/states/all?regions=america,eu,mena,asia,oceania,arctic",
        totalAircraft: 2,
        validPositionCount: 2,
        latestObservedAt: "2026-03-02T11:59:55.000Z",
        diagnostics: expect.objectContaining({
          staleThresholdSec: 600,
          droppedInvalidPositionCount: 0,
          droppedMissingIdentityCount: 0,
          droppedStalePositionCount: 0,
          deduplicatedCount: 0,
          retainedPreviousSnapshot: false,
        }),
        aircraft: expect.arrayContaining([
          expect.objectContaining({
            id: "ae017a",
            icao24: "ae017a",
            callsign: "RCH416",
            lat: 39.315491,
            lng: -99.342797,
            heading: 261.89,
            altitudeFt: 35979,
            groundSpeedKt: 376,
            countryCode: "US",
            countryName: "United States",
            source: "opensky",
            observedAt: "2026-03-02T11:59:50.000Z",
          }),
          expect.objectContaining({
            id: "ae6400",
            icao24: "ae6400",
            callsign: "RRR9001",
            observedAt: "2026-03-02T11:59:55.000Z",
          }),
        ]),
      }),
      1200,
    );
  });

  it("retains the previous OpenSky snapshot until the freshness window expires", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-03-02T12:00:00.000Z"));
    const { service, store } = buildService();
    store.getLatestAdsbSnapshot.mockResolvedValue({
      source: "opensky",
      sourceEndpoint: "https://opensky-network.org/api/states/all",
      updatedAt: "2026-03-02T11:58:30.000Z",
      totalAircraft: 2,
      validPositionCount: 1,
      latestObservedAt: "2026-03-02T11:58:20.000Z",
      diagnostics: {
        latestObservedAt: "2026-03-02T11:58:20.000Z",
        oldestObservedAt: "2026-03-02T11:58:20.000Z",
        staleThresholdSec: 600,
        droppedInvalidPositionCount: 0,
        droppedMissingIdentityCount: 0,
        droppedStalePositionCount: 0,
        deduplicatedCount: 0,
        retainedPreviousSnapshot: false,
      },
      aircraft: [
        {
          id: "ae017a",
          icao24: "ae017a",
          callsign: "RCH416",
          lat: 39.315491,
          lng: -99.342797,
          observedAt: "2026-03-02T11:58:20.000Z",
          source: "opensky" as const,
        },
      ],
    });
    jest
      .spyOn(service as any, "fetchConservativeMilitaryOpenSkyStates")
      .mockResolvedValue([
        {
          icao24: "ae6306",
          callsign: "RCH295",
          countryName: "United States",
          lastContactAt: "2026-03-02T11:44:59.000Z",
          lastContactMs: Date.parse("2026-03-02T11:44:59.000Z"),
          latitude: 28.002242,
          longitude: -98.471051,
          raw: [
            "ae6306",
            "RCH295",
            "United States",
            1_772_451_899,
            1_772_451_899,
            -98.471051,
            28.002242,
            null,
            false,
            null,
            null,
            0,
            null,
            null,
          ],
        },
      ]);

    const result = await (service as any).fetchAdsbSignal("org-1", runtimeConfig);

    expect(result[0]).toMatchObject({
      context: {
        validPositionCount: 0,
        snapshotValidPositionCount: 1,
        snapshotRetainedPrevious: true,
        snapshotFreshness: "fresh",
        droppedStalePositionCount: 1,
      },
    });
    expect(result[1]).toMatchObject({
      metricSlug: "realtime.opensky.snapshot_health",
      value: 1,
      context: {
        healthState: "fresh",
        stale: false,
        snapshotRetainedPrevious: true,
        currentValidPositionCount: 0,
        snapshotValidPositionCount: 1,
      },
    });
    expect(store.setLatestAdsbSnapshot).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        updatedAt: "2026-03-02T11:58:30.000Z",
        totalAircraft: 1,
        validPositionCount: 1,
        latestObservedAt: "2026-03-02T11:58:20.000Z",
        diagnostics: expect.objectContaining({
          retainedPreviousSnapshot: true,
          droppedStalePositionCount: 1,
        }),
        aircraft: [
          expect.objectContaining({
            id: "ae017a",
            icao24: "ae017a",
          }),
        ],
      }),
      1200,
    );
  });

  it("does not infer OpenSky country codes from callsigns alone", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-03-02T12:00:00.000Z"));
    const { service, store } = buildService();
    jest
      .spyOn(service as any, "fetchConservativeMilitaryOpenSkyStates")
      .mockResolvedValue([
        {
          icao24: "ae6400",
          callsign: "USAF01",
          lastContactAt: "2026-03-02T11:59:55.000Z",
          lastContactMs: Date.parse("2026-03-02T11:59:55.000Z"),
          latitude: 35.002242,
          longitude: -97.471051,
          raw: [
            "ae6400",
            "USAF01",
            null,
            1_772_452_790,
            1_772_452_795,
            -97.471051,
            35.002242,
            null,
            false,
            null,
            null,
            0,
            null,
            null,
          ],
        },
      ]);

    const result = await (service as any).fetchAdsbSignal("org-1", runtimeConfig);

    expect(result[0]?.context?.countryCodes).toEqual([]);
    expect((result[0]?.context as Record<string, unknown>).latestObservedAt).toBe(
      "2026-03-02T11:59:55.000Z",
    );
    const storedSnapshot = store.setLatestAdsbSnapshot.mock.calls[0]?.[1] as
      | { aircraft?: Array<Record<string, unknown>> }
      | undefined;
    expect(storedSnapshot?.aircraft?.[0]?.countryCode).toBeUndefined();
  });

  it("fetches AIS snapshots from the bare relay endpoint with compatible auth headers", async () => {
    const { service } = buildService();
    const runtime = {
      ...runtimeConfig,
      relay: {
        baseUrl: "https://relay.example.com/",
        sharedSecret: "relay-secret",
      },
      credentials: {
        ...runtimeConfig.credentials,
        aisApiKey: "ais-key",
      },
    } satisfies RealtimeSignalsRuntimeConfig;
    const fetchJsonSpy = jest
      .spyOn(service as any, "fetchJsonWithRetry")
      .mockResolvedValue({
        disruptions: [{ countryCode: "US" }],
        density: [{ id: "density-1" }],
      });

    const result = await (service as any).fetchAisSignal(runtime);

    expect(fetchJsonSpy).toHaveBeenCalledWith(
      "https://relay.example.com/ais/snapshot?candidates=false",
      runtime,
      {
        headers: {
          Authorization: "Bearer relay-secret",
          "x-relay-key": "relay-secret",
          "X-Relay-Secret": "relay-secret",
          "X-AIS-API-Key": "ais-key",
        },
      },
    );
    expect(result[0]).toMatchObject({
      metricSlug: "realtime.ais.disruptions",
      value: 1,
      context: {
        source: "relay",
        disruptions: 1,
        densityRegions: 1,
      },
    });
  });

  it("fails AIS refreshes when the relay payload is malformed", async () => {
    const { service } = buildService();
    const runtime = {
      ...runtimeConfig,
      relay: {
        baseUrl: "https://relay.example.com",
      },
    } satisfies RealtimeSignalsRuntimeConfig;
    jest.spyOn(service as any, "fetchJsonWithRetry").mockResolvedValue({
      density: [],
    });

    await expect((service as any).fetchAisSignal(runtime)).rejects.toThrow(
      "AIS relay returned an invalid snapshot payload. Expected disruptions[] and density[].",
    );
  });

  it("deduplicates unrest events by rounded geo/date key and prefers ACLED", () => {
    const { service } = buildService();
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

  it("uses GDELT-only unrest mode when ACLED API is disabled", async () => {
    const { service } = buildService();
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
    const fetchAcledSpy = jest.spyOn(service as any, "fetchAcledUnrestEvents");
    jest
      .spyOn(service as any, "fetchGdeltUnrestEvents")
      .mockResolvedValue({ events: gdelt, configured: true });

    const result = await (service as any).fetchUnrestSignal(runtimeConfig);

    expect(fetchAcledSpy).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      value: 1,
      context: {
        source: "gdelt",
        unrestCount: 1,
        acledCount: 0,
        gdeltCount: 1,
        acledConfigured: false,
        acledApiEnabled: false,
        unrestMode: "gdelt_only",
      },
    });
  });

  it("reports acled+gdelt source when both feeds contributed", async () => {
    const { service } = buildService();
    const runtime = {
      ...runtimeConfig,
      capabilities: {
        acledApiEnabled: true,
      },
    } satisfies RealtimeSignalsRuntimeConfig;
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
      .mockResolvedValue({ events: acled, configured: true });
    jest
      .spyOn(service as any, "fetchGdeltUnrestEvents")
      .mockResolvedValue({ events: gdelt, configured: true });

    const result = await (service as any).fetchUnrestSignal(runtime);
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

  it("refreshes ACLED token and retries once on 401", async () => {
    const settings = {
      forceRefreshAcledAccessToken: jest.fn().mockResolvedValue("fresh-token"),
    };
    const service = new RealtimeSignalsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      settings as any,
    );
    const fetchJsonSpy = jest
      .spyOn(service as any, "fetchJsonWithRetry")
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 401 Unauthorized"), { status: 401 }),
      )
      .mockResolvedValueOnce({ data: [] });
    const runtime = {
      ...runtimeConfig,
      capabilities: {
        acledApiEnabled: true,
      },
      credentials: {
        ...runtimeConfig.credentials,
      },
    } satisfies RealtimeSignalsRuntimeConfig;

    const result = await (service as any).fetchAcledUnrestEvents(runtime);

    expect(settings.forceRefreshAcledAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchJsonSpy.mock.calls[0]?.[2]).toMatchObject({
      headers: { Authorization: "Bearer token" },
    });
    expect(fetchJsonSpy.mock.calls[1]?.[2]).toMatchObject({
      headers: { Authorization: "Bearer fresh-token" },
    });
    expect(runtime.credentials.acledAccessToken).toBe("fresh-token");
    expect(result).toEqual({
      configured: true,
      events: [],
    });
  });

  it("adds required compact date parameters for gdelt tension fetches", async () => {
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-03-12T12:00:00.000Z"));
    const { service } = buildService();
    const fetchJsonSpy = jest
      .spyOn(service as any, "fetchJsonWithRetry")
      .mockResolvedValue({
        usa_russia: [{ t: 1773187200000, v: 0.42 }],
      });

    await (service as any).fetchGdeltTensionSignal(runtimeConfig);

    expect(fetchJsonSpy).toHaveBeenCalledWith(
      "https://www.pizzint.watch/api/gdelt/batch?pairs=usa_russia%2Crussia_ukraine%2Cusa_china%2Cchina_taiwan%2Cusa_iran%2Cusa_venezuela&method=gpr&dateStart=20260305&dateEnd=20260312",
      runtimeConfig,
    );

    nowSpy.mockRestore();
  });

  it("parses gdelt unrest geojson fallback feed", async () => {
    const { service } = buildService();
    jest.spyOn(service as any, "fetchJsonWithRetry").mockResolvedValue({
      features: [
        {
          geometry: { type: "Point", coordinates: [36.8, -1.2] },
          properties: {
            name: "Nairobi, Kenya",
            urlpubtimedate: "2026-03-12T10:00:00Z",
            urltone: -4.2,
            mentionedthemes: ";PROTEST;PROTEST;",
          },
        },
        {
          geometry: { type: "Point", coordinates: [36.8, -1.2] },
          properties: {
            name: "Nairobi, Kenya",
            urlpubtimedate: "2026-03-12T11:00:00Z",
            urltone: -3.5,
            mentionedthemes: ";PROTEST;",
          },
        },
        {
          geometry: { type: "Point", coordinates: [12.4, 41.9] },
          properties: {
            name: "Rome, Italy",
            urlpubtimedate: "2026-03-12T11:00:00Z",
            urltone: 2.1,
            mentionedthemes: ";PROTEST;",
          },
        },
      ],
    });

    const result = await (service as any).fetchGdeltUnrestEvents(runtimeConfig);

    expect(result.configured).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      countryCode: "KEN",
      reports: 2,
      source: "gdelt",
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
      getSourceState: jest.fn(),
      clearLatestAdsbSnapshot: jest.fn(),
      setLatestAdsbSnapshot: jest.fn(),
      appendPoint: jest.fn(),
      setLastRun: jest.fn(),
      setSourceState: jest.fn(),
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

  it("reads runtime config for insight snapshots without ACLED refresh", async () => {
    const { service, settings, store } = buildService();
    store.getInsightSnapshot.mockResolvedValue({
      keywordSpikes: [],
      predictionLeads: [],
      tensions: [],
    });
    store.getLastRun.mockResolvedValue(null);

    await service.getSituationMonitorInsightSnapshot("org-1");

    expect(settings.getRuntimeConfig).toHaveBeenCalledWith({
      refreshAcledToken: false,
    });
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
          countries: ["US"],
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
      withLock: jest.fn(
        async (_key: string, _ttlMs: number, runner: () => Promise<void>) => {
          await runner();
        },
      ),
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

describe("RealtimeSignalsService runtime diagnostics", () => {
  const buildService = () => {
    const prisma = {
      $queryRaw: jest.fn(),
      processedArticle: {
        count: jest.fn(),
        findFirst: jest.fn(),
      },
    };
    const store = {
      getInsightSnapshot: jest.fn().mockResolvedValue(null),
      getLastRun: jest.fn().mockResolvedValue(null),
      getSourceState: jest.fn().mockResolvedValue(null),
      getLatestAdsbSnapshot: jest.fn().mockResolvedValue(null),
      evaluateMetric: jest.fn().mockResolvedValue({
        latest: null,
        previous: null,
        changePercent: null,
      }),
    };
    const settings = {
      getRuntimeConfig: jest.fn().mockResolvedValue(runtimeConfig),
      getSettingsSource: jest.fn().mockResolvedValue("db"),
    };
    const service = new RealtimeSignalsService(
      prisma as any,
      {} as any,
      {} as any,
      store as any,
      settings as any,
    );
    return { service, prisma, store, settings };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns unknown settings source when diagnostics source lookup fails", async () => {
    const { service, prisma, settings } = buildService();
    settings.getSettingsSource.mockRejectedValue(new Error("db down"));
    prisma.processedArticle.count.mockRejectedValue(new Error("db down"));
    prisma.processedArticle.findFirst.mockRejectedValue(new Error("db down"));
    prisma.$queryRaw.mockRejectedValue(new Error("db down"));
    jest.spyOn(service as any, "getMongoMarkerReadiness").mockResolvedValue({
      recentProcessedItems: 3,
      recentProcessedItemsWithLocation: 2,
      latestProcessedItemAt: "2026-03-12T00:00:00.000Z",
    });

    const result = await service.getRuntimeDiagnostics("org-1");

    expect(result.settingsSource).toBe("unknown");
    expect(result.runtimeEnabled).toBe(true);
    expect(result.sources).toHaveLength(8);
    expect(result.markerReadiness).toEqual({
      windowHours: 24 * 7,
      recentProcessedArticles: 0,
      recentProcessedArticlesWithLocation: 0,
      recentMongoProcessedItems: 3,
      recentMongoProcessedItemsWithLocation: 2,
      latestProcessedArticleAt: undefined,
      latestProcessedItemAt: "2026-03-12T00:00:00.000Z",
      newsMarkersReady: true,
    });
    expect(result.sources.every((source) => source.status === "idle")).toBe(
      true,
    );
    const openskySource = result.sources.find(
      (source) => source.source === "opensky",
    );
    expect(openskySource?.openskySnapshot).toEqual({
      freshness: "missing",
      rawAircraftCount: 0,
      currentValidPositionCount: 0,
      snapshotValidPositionCount: 0,
      staleThresholdSec: 600,
      retainedPreviousSnapshot: false,
      droppedInvalidPositionCount: 0,
      droppedMissingIdentityCount: 0,
      droppedStalePositionCount: 0,
      deduplicatedCount: 0,
    });
  });

  it("excludes blank prisma locations from marker readiness counts", async () => {
    const { service, prisma } = buildService();
    const processedAt = new Date("2026-03-12T10:00:00.000Z");
    prisma.processedArticle.count.mockResolvedValue(4);
    prisma.processedArticle.findFirst.mockResolvedValue({ processedAt });
    prisma.$queryRaw.mockResolvedValue([{ count: BigInt(0) }]);
    jest.spyOn(service as any, "getMongoMarkerReadiness").mockResolvedValue({
      recentProcessedItems: 0,
      recentProcessedItemsWithLocation: 0,
    });

    const result = await (service as any).getMarkerReadiness("org-1");

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      windowHours: 24 * 7,
      recentProcessedArticles: 4,
      recentProcessedArticlesWithLocation: 0,
      recentMongoProcessedItems: 0,
      recentMongoProcessedItemsWithLocation: 0,
      latestProcessedArticleAt: processedAt.toISOString(),
      latestProcessedItemAt: undefined,
      newsMarkersReady: false,
    });
  });

  it("filters whitespace-only mongo locations from marker readiness counts", async () => {
    const { service } = buildService();
    const countDocumentsSpy = jest
      .spyOn(ProcessedItemModel, "countDocuments")
      .mockReturnValueOnce(6 as any)
      .mockReturnValueOnce(0 as any);
    const exec = jest.fn().mockResolvedValue({
      sortAt: new Date("2026-03-12T09:00:00.000Z"),
    });
    const lean = jest.fn().mockReturnValue({ exec });
    const sort = jest.fn().mockReturnValue({ lean });
    jest.spyOn(ProcessedItemModel, "findOne").mockReturnValue({ sort } as any);

    const result = await (service as any).getMongoMarkerReadiness(
      "org-1",
      new Date("2026-03-05T00:00:00.000Z"),
    );

    expect(countDocumentsSpy).toHaveBeenCalledTimes(2);
    expect(countDocumentsSpy.mock.calls[1]?.[0]?.["result.location"]).toEqual({
      $type: "string",
      $regex: /\S/,
    });
    expect(result).toEqual({
      recentProcessedItems: 6,
      recentProcessedItemsWithLocation: 0,
      latestProcessedItemAt: "2026-03-12T09:00:00.000Z",
    });
  });
});
