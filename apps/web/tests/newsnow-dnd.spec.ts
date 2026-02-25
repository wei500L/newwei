import { describe, expect, it } from "vitest";

import {
  buildCrossSourceDedupResult,
  normalizeNewsTitle,
  reorderNewsnowItems,
  sortNewsnowSourcesByAffinity,
} from "../app/(app)/newsnow/lib/newsnow-dnd";

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

  it("normalizes noisy titles for cross-source grouping", () => {
    const normalized = normalizeNewsTitle("【突发】AAPL 股价大涨！  ");

    expect(normalized).toBe("aapl 股价大涨");
  });

  it("builds cross-source dedupe map and keeps primary source visible", () => {
    const result = buildCrossSourceDedupResult({
      sourceOrder: ["source-a", "source-b"],
      snapshots: {
        "source-a": {
          updatedAt: 1,
          items: [
            { id: "1", title: "苹果发布会发布新芯片" },
            { id: "2", title: "独家：供应链变化" },
          ],
        },
        "source-b": {
          updatedAt: 1,
          items: [{ id: "x", title: "苹果发布会发布新芯片" }],
        },
      },
    });

    expect(result.duplicateGroups).toBe(1);
    expect(result.duplicateItemsBySource["source-a"]).toBe(1);
    expect(result.duplicateItemsBySource["source-b"]).toBe(1);
    expect(result.bySource["source-a"]?.["1"]?.isPrimary).toBe(true);
    expect(result.bySource["source-b"]?.["x"]?.isPrimary).toBe(false);
    expect(result.visibleItemsBySource["source-a"]).toBe(2);
    expect(result.visibleItemsBySource["source-b"]).toBe(0);
  });

  it("sorts sources by affinity score while preserving stable order tie-break", () => {
    const sorted = sortNewsnowSourcesByAffinity({
      sourceIds: ["a", "b", "c"],
      affinities: {
        a: { score: 2, lastInteractedAt: Date.now() },
        b: { score: 6, lastInteractedAt: Date.now() },
        c: { score: 1, lastInteractedAt: Date.now() },
      },
      focusSources: ["a"],
    });

    expect(sorted[0]).toBe("b");
    expect(sorted.includes("a")).toBe(true);
    expect(sorted).toHaveLength(3);
  });
});
