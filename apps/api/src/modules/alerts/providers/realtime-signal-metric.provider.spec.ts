import { AlertMetricProvider } from "@prisma/client";

import { RealtimeSignalMetricProvider } from "./realtime-signal-metric.provider";

describe("RealtimeSignalMetricProvider.fetch", () => {
  const buildProvider = () => {
    const realtimeSignals = {
      evaluateMetric: jest.fn(),
    };
    const provider = new RealtimeSignalMetricProvider(realtimeSignals as any);
    return { provider, realtimeSignals };
  };

  it("suppresses ADS-B count alerts when the snapshot is stale", async () => {
    const { provider, realtimeSignals } = buildProvider();
    realtimeSignals.evaluateMetric.mockResolvedValue({
      latest: 42,
      previous: 41,
      changePercent: 2.4,
      context: {
        snapshotFreshness: "stale",
        snapshotRetainedPrevious: false,
        latestObservedAt: "2026-03-15T08:00:00.000Z",
        staleThresholdSec: 600,
      },
    });

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.realtime_signal,
      metricSlug: "realtime.adsb.military_flights",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: {},
    });

    expect(result).toEqual({
      latest: null,
      previous: null,
      changePercent: null,
      context: {
        snapshotFreshness: "stale",
        snapshotRetainedPrevious: false,
        latestObservedAt: "2026-03-15T08:00:00.000Z",
        staleThresholdSec: 600,
        stale: true,
        latestTimestamp: "2026-03-15T08:00:00.000Z",
        maxStaleMinutes: 10,
      },
    });
  });

  it("suppresses ADS-B count alerts when the map is using a retained snapshot", async () => {
    const { provider, realtimeSignals } = buildProvider();
    realtimeSignals.evaluateMetric.mockResolvedValue({
      latest: 42,
      previous: 41,
      changePercent: 2.4,
      context: {
        snapshotFreshness: "fresh",
        snapshotRetainedPrevious: true,
        snapshotUpdatedAt: "2026-03-15T08:02:00.000Z",
        staleThresholdSec: 900,
      },
    });

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.realtime_signal,
      metricSlug: "realtime.adsb.military_flights",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: {},
    });

    expect(result).toEqual({
      latest: null,
      previous: null,
      changePercent: null,
      context: {
        snapshotFreshness: "fresh",
        snapshotRetainedPrevious: true,
        snapshotUpdatedAt: "2026-03-15T08:02:00.000Z",
        staleThresholdSec: 900,
        stale: true,
        latestTimestamp: "2026-03-15T08:02:00.000Z",
        maxStaleMinutes: 15,
      },
    });
  });

  it("passes through ADS-B snapshot health evaluations without suppression", async () => {
    const { provider, realtimeSignals } = buildProvider();
    realtimeSignals.evaluateMetric.mockResolvedValue({
      latest: 1,
      previous: 0,
      changePercent: null,
      context: {
        snapshotFreshness: "stale",
      },
    });

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.realtime_signal,
      metricSlug: "realtime.adsb.snapshot_health",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: {},
    });

    expect(result).toEqual({
      latest: 1,
      previous: 0,
      changePercent: null,
      context: {
        snapshotFreshness: "stale",
      },
    });
  });
});
