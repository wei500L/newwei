import { RealtimeSignalsService } from "./realtime-signals.service";
import type { RealtimeSignalsRuntimeConfig } from "./realtime-signals.types";

const runtimeConfig: RealtimeSignalsRuntimeConfig = {
  enabled: true,
  requestTimeoutMs: 10_000,
  maxRetries: 0,
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

    const merged = (service as any).mergeUnrestEvents(acled, gdelt) as Array<{
      id: string;
      source: "acled" | "gdelt";
      countryCode?: string;
    }>;

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
