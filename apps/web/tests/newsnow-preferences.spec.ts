import { describe, expect, it } from "vitest";

import { normalizeNewsnowPreferenceSettings } from "../app/(app)/newsnow/store/newsnow-store";

describe("newsnow preference normalization", () => {
  it("normalizes source ids, sort mode and affinity payload", () => {
    const normalized = normalizeNewsnowPreferenceSettings({
      focusSources: ["weibo", "weibo", " bad source "],
      columnOrders: {
        hottest: ["weibo", "hackernews", "bad source"],
        " bad column ": ["weibo"],
      },
      hideCrossSourceDuplicates: true,
      sortMode: "smart",
      sourceAffinity: {
        weibo: {
          score: 120,
          openOriginalCount: 1.2,
          openEventCount: 2,
          openItemCount: 3,
          refreshCount: 4,
          focusCount: 5,
          accumulatedDwellMs: 60_000,
          lastInteractedAt: 1_739_900_000_000,
        },
        "bad source": {
          score: 1,
        },
      },
    } as any);

    expect(normalized.focusSources).toEqual(["weibo"]);
    expect(normalized.columnOrders).toEqual({
      hottest: ["weibo", "hackernews"],
    });
    expect(normalized.hideCrossSourceDuplicates).toBe(true);
    expect(normalized.sortMode).toBe("personalized");
    expect(normalized.sourceAffinity.weibo?.score).toBe(100);
    expect(normalized.sourceAffinity).not.toHaveProperty("bad source");
  });
});
