import { afterEach, describe, expect, it, vi } from "vitest";

import { createCoalescedRefetchScheduler } from "../lib/coalesced-refetch";

const flushPromises = () => Promise.resolve();

describe("coalesced refetch scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces burst schedules into one trailing refetch", async () => {
    vi.useFakeTimers();
    const refetch = vi.fn(() => Promise.resolve());
    const scheduler = createCoalescedRefetchScheduler(refetch, { delayMs: 100 });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();

    expect(refetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(refetch).toHaveBeenCalledTimes(1);
    scheduler.cancel();
  });

  it("runs a trailing refetch after an in-flight refetch receives another schedule", async () => {
    vi.useFakeTimers();
    let resolveFirst = () => {};
    const refetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const scheduler = createCoalescedRefetchScheduler(refetch, { delayMs: 100 });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(refetch).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    resolveFirst();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(refetch).toHaveBeenCalledTimes(2);
    scheduler.cancel();
  });
});
