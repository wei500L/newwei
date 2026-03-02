import { RealtimeSignalsSnapshotStore } from "./realtime-signals.snapshot-store";

describe("RealtimeSignalsSnapshotStore.evaluateMetric", () => {
  const createStore = () => {
    const state = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (key: string) => state.get(key) ?? null),
      set: jest.fn(async (key: string, value: unknown) => {
        state.set(key, value);
      }),
    } as any;
    const store = new RealtimeSignalsSnapshotStore(cache);
    return { store };
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
});
