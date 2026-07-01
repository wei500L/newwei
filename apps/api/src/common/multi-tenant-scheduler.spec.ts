import {
  claimSchedulerTick,
  settleWithConcurrency,
} from "./multi-tenant-scheduler";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

describe("settleWithConcurrency", () => {
  it("enforces the requested concurrency limit", async () => {
    const startedTwo = createDeferred<void>();
    const releases = [
      createDeferred<number>(),
      createDeferred<number>(),
      createDeferred<number>(),
    ];
    let active = 0;
    let maxActive = 0;
    let started = 0;

    const runPromise = settleWithConcurrency(
      ["org-1", "org-2", "org-3"],
      2,
      async (_orgId, index) => {
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (started === 2) {
          startedTwo.resolve();
        }

        return releases[index]!.promise.finally(() => {
          active -= 1;
        });
      },
    );

    await startedTwo.promise;
    expect(maxActive).toBe(2);

    releases[0]!.resolve(10);
    releases[1]!.resolve(20);
    releases[2]!.resolve(30);

    const results = await runPromise;

    expect(results).toEqual([
      { item: "org-1", index: 0, status: "fulfilled", value: 10 },
      { item: "org-2", index: 1, status: "fulfilled", value: 20 },
      { item: "org-3", index: 2, status: "fulfilled", value: 30 },
    ]);
  });

  it("continues processing remaining items when one worker rejects", async () => {
    const results = await settleWithConcurrency(
      ["org-1", "org-2", "org-3"],
      2,
      async (orgId) => {
        if (orgId === "org-2") {
          throw new Error("boom");
        }
        return `${orgId}-done`;
      },
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      item: "org-1",
      index: 0,
      status: "fulfilled",
      value: "org-1-done",
    });
    expect(results[1]).toMatchObject({
      item: "org-2",
      index: 1,
      status: "rejected",
    });
    expect(results[2]).toEqual({
      item: "org-3",
      index: 2,
      status: "fulfilled",
      value: "org-3-done",
    });
  });
});

describe("claimSchedulerTick", () => {
  it("claims a scheduler tick with a rounded-up ttl in seconds", async () => {
    const cache = {
      setIfAbsent: jest.fn().mockResolvedValue(true),
    };
    const now = new Date("2026-06-03T00:00:00.000Z");

    await expect(
      claimSchedulerTick(cache, "cron:test:tick-gate", 55_500, now),
    ).resolves.toBe(true);

    expect(cache.setIfAbsent).toHaveBeenCalledWith(
      "cron:test:tick-gate",
      { claimedAt: "2026-06-03T00:00:00.000Z" },
      56,
    );
  });
});
