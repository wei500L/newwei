import { RealtimeSignalsSnapshotStore } from "./realtime-signals.snapshot-store";

describe("RealtimeSignalsSnapshotStore.evaluateMetric", () => {
  const createStore = () => {
    const state = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (key: string) => state.get(key) ?? null),
      del: jest.fn(async (key: string) => {
        state.delete(key);
      }),
      set: jest.fn(async (key: string, value: unknown) => {
        state.set(key, value);
      }),
    } as any;
    const store = new RealtimeSignalsSnapshotStore(cache);
    return { store, cache };
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns null latest when the newest point is stale", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-03-02T12:00:00.000Z"));
    const { store } = createStore();

    await store.appendPoint("org-1", "realtime.unrest.events", {
      ts: "2026-03-02T08:00:00.000Z",
      value: 12,
      context: { source: "acled" },
    });

    const evaluation = await store.evaluateMetric(
      "org-1",
      "realtime.unrest.events",
      60,
    );

    expect(evaluation.latest).toBeNull();
    expect(evaluation.previous).toBeNull();
    expect(evaluation.changePercent).toBeNull();
    expect(evaluation.context).toMatchObject({
      stale: true,
      latestTimestamp: "2026-03-02T08:00:00.000Z",
      maxStaleMinutes: 120,
      source: "acled",
    });
  });

  it("stores and clears the latest ADS-B snapshot independently from metric series", async () => {
    const { store, cache } = createStore();
    const snapshot = {
      source: "adsb" as const,
      sourceEndpoint: "https://api.adsb.lol/v2/mil",
      updatedAt: "2026-03-02T12:00:00.000Z",
      totalAircraft: 2,
      validPositionCount: 1,
      latestObservedAt: "2026-03-02T11:59:30.000Z",
      diagnostics: {
        latestObservedAt: "2026-03-02T11:59:30.000Z",
        oldestObservedAt: "2026-03-02T11:59:30.000Z",
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
          lat: 39.315491,
          lng: -99.342797,
          observedAt: "2026-03-02T11:59:30.000Z",
          source: "adsb" as const,
        },
      ],
    };

    await store.setLatestAdsbSnapshot("org-1", snapshot, 300);

    expect(await store.getLatestAdsbSnapshot("org-1")).toEqual(snapshot);
    expect(cache.set).toHaveBeenCalledWith(
      "realtime-signals:adsb-latest:org-1",
      snapshot,
      300,
    );

    await store.clearLatestAdsbSnapshot("org-1");

    expect(await store.getLatestAdsbSnapshot("org-1")).toBeNull();
    expect(cache.del).toHaveBeenCalledWith("realtime-signals:adsb-latest:org-1");
  });
});
