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

  it("supports stable item ids such as normalized urls for duplicate lookups", () => {
    const result = buildCrossSourceDedupResult({
      sourceOrder: ["source-a", "source-b"],
      snapshots: {
        "source-a": {
          updatedAt: 1,
          items: [{ id: "https://example.com/a", title: "同一条跨源重复新闻标题" }],
        },
        "source-b": {
          updatedAt: 1,
          items: [{ id: "https://example.org/b", title: "同一条跨源重复新闻标题" }],
        },
      },
    });

    expect(result.bySource["source-a"]?.["https://example.com/a"]?.isPrimary).toBe(true);
    expect(result.bySource["source-b"]?.["https://example.org/b"]?.isPrimary).toBe(false);
    expect(result.duplicateItemsBySource["source-a"]).toBe(1);
    expect(result.duplicateItemsBySource["source-b"]).toBe(1);
  });

  it("reuses unaffected source meta when a non-overlapping source snapshot changes", () => {
    const initial = buildCrossSourceDedupResult({
      sourceOrder: ["source-a", "source-b", "source-c"],
      snapshots: {
        "source-a": {
          updatedAt: 1,
          items: [{ id: "a-1", title: "苹果发布会发布新芯片" }],
        },
        "source-b": {
          updatedAt: 1,
          items: [{ id: "b-1", title: "苹果发布会发布新芯片" }],
        },
        "source-c": {
          updatedAt: 1,
          items: [{ id: "c-1", title: "独家：供应链变化" }],
        },
      },
    });

    const next = buildCrossSourceDedupResult({
      sourceOrder: ["source-a", "source-b", "source-c"],
      snapshots: {
        "source-a": {
          updatedAt: 1,
          items: [{ id: "a-1", title: "苹果发布会发布新芯片" }],
        },
        "source-b": {
          updatedAt: 1,
          items: [{ id: "b-1", title: "苹果发布会发布新芯片" }],
        },
        "source-c": {
          updatedAt: 2,
          items: [{ id: "c-2", title: "另一条独家供应链变化" }],
        },
      },
      previousCache: initial,
    });

    expect(next.bySource["source-a"]).toBe(initial.bySource["source-a"]);
    expect(next.bySource["source-b"]).toBe(initial.bySource["source-b"]);
    expect(next.bySource["source-c"]).toBe(initial.bySource["source-c"]);
    expect(next.duplicateGroups).toBe(1);
  });

  it("recomputes affected duplicate peers when a duplicate group changes", () => {
    const initial = buildCrossSourceDedupResult({
      sourceOrder: ["source-a", "source-b"],
      snapshots: {
        "source-a": {
          updatedAt: 1,
          items: [{ id: "a-1", title: "苹果发布会发布新芯片" }],
        },
        "source-b": {
          updatedAt: 1,
          items: [{ id: "b-1", title: "苹果发布会发布新芯片" }],
        },
      },
    });

    const next = buildCrossSourceDedupResult({
      sourceOrder: ["source-a", "source-b"],
      snapshots: {
        "source-a": {
          updatedAt: 1,
          items: [{ id: "a-1", title: "苹果发布会发布新芯片" }],
        },
        "source-b": {
          updatedAt: 2,
          items: [{ id: "b-2", title: "完全不同的独家消息" }],
        },
      },
      previousCache: initial,
    });

    expect(next.bySource["source-a"]).not.toBe(initial.bySource["source-a"]);
    expect(next.bySource["source-b"]).not.toBe(initial.bySource["source-b"]);
    expect(next.bySource["source-a"]?.["a-1"]).toBeUndefined();
    expect(next.duplicateItemsBySource["source-a"]).toBe(0);
    expect(next.visibleItemsBySource["source-b"]).toBe(1);
    expect(next.duplicateGroups).toBe(0);
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
