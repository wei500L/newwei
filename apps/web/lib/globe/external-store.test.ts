import { describe, expect, it, vi } from "vitest";

import { createExternalStore } from "./external-store";

describe("createExternalStore", () => {
  it("getSnapshot 返回当前值，set 更新并通知订阅者", () => {
    const store = createExternalStore("OFF");
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(store.getSnapshot()).toBe("OFF");
    store.set("DENSE");

    expect(store.getSnapshot()).toBe("DENSE");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.set("SPARSE");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("相同值不通知；支持函数式更新", () => {
    const store = createExternalStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(0);
    expect(listener).not.toHaveBeenCalled();

    store.set((previous) => previous + 1);
    expect(store.getSnapshot()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
