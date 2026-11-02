import { describe, expect, it } from "vitest";

import { acquireGlobeSlot, createRuntimeLifecycle } from "./runtime-lifecycle";

describe("createRuntimeLifecycle", () => {
  it("按后进先出执行 cleanup", async () => {
    const order: string[] = [];
    const lifecycle = createRuntimeLifecycle();
    lifecycle.defer(() => {
      order.push("first");
    });
    lifecycle.defer(() => {
      order.push("second");
    });
    lifecycle.defer(async () => {
      order.push("third");
    });

    await lifecycle.destroy();

    expect(order).toEqual(["third", "second", "first"]);
  });

  it("destroy 幂等，只执行一次 cleanup，并先 abort", async () => {
    let calls = 0;
    const lifecycle = createRuntimeLifecycle();
    let abortedWhenCleanupRan = false;
    lifecycle.defer(() => {
      calls += 1;
      abortedWhenCleanupRan = lifecycle.signal.aborted;
    });

    expect(lifecycle.signal.aborted).toBe(false);
    await lifecycle.destroy();
    await lifecycle.destroy();
    await lifecycle.destroy();

    expect(calls).toBe(1);
    expect(abortedWhenCleanupRan).toBe(true);
    expect(lifecycle.signal.aborted).toBe(true);
  });

  it("单个 cleanup 抛错不阻止其它 cleanup，最后抛 AggregateError", async () => {
    const order: string[] = [];
    const lifecycle = createRuntimeLifecycle();
    lifecycle.defer(() => {
      order.push("a");
    });
    lifecycle.defer(() => {
      order.push("b-throw");
      throw new Error("boom");
    });
    lifecycle.defer(() => {
      order.push("c");
    });

    await expect(lifecycle.destroy()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(["c", "b-throw", "a"]);
  });
});

describe("acquireGlobeSlot", () => {
  it("让两次启动串行执行（前一个 release 之后后一个才拿到槽位）", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = acquireGlobeSlot().then((release) => {
      events.push("first-acquired");
      releaseFirst = release;
    });
    await first;

    let secondAcquired = false;
    const second = acquireGlobeSlot().then((release) => {
      secondAcquired = true;
      events.push("second-acquired");
      release();
    });

    // 刷新若干微任务：第二个仍应被挡在第一个 release 之前。
    await Promise.resolve();
    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    releaseFirst();
    await second;

    expect(secondAcquired).toBe(true);
    expect(events).toEqual(["first-acquired", "second-acquired"]);
  });

  it("release 幂等", async () => {
    const release = await acquireGlobeSlot();
    release();
    expect(() => release()).not.toThrow();
    // 释放后下一个可以正常取得槽位。
    const releaseAgain = await acquireGlobeSlot();
    releaseAgain();
  });
});
