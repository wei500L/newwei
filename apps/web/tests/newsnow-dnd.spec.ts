import { describe, expect, it } from "vitest";

import { reorderNewsnowItems } from "../app/(app)/newsnow/lib/newsnow-dnd";

describe("newsnow dnd reorder", () => {
  it("does not change order when dropped outside a valid target", () => {
    const items = ["a", "b", "c"];

    const next = reorderNewsnowItems(items, "a", null);

    expect(next).toBe(items);
  });

  it("does not change order when active or target item cannot be found", () => {
    const items = ["a", "b", "c"];

    const missingActive = reorderNewsnowItems(items, "x", "b");
    const missingTarget = reorderNewsnowItems(items, "a", "x");

    expect(missingActive).toBe(items);
    expect(missingTarget).toBe(items);
  });

  it("moves item when drag and drop target are both valid", () => {
    const items = ["a", "b", "c"];

    const next = reorderNewsnowItems(items, "a", "c");

    expect(next).toEqual(["b", "c", "a"]);
  });
});
