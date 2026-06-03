import { describe, expect, it } from "vitest";

import {
  estimateItemsFeedRowSize,
  shouldUpdateItemsFeedMetric,
  shouldVirtualizeItemsFeed,
} from "../app/(app)/items/items-feed-virtualization";

describe("items feed virtualization", () => {
  it("only enables virtualization above the feed threshold", () => {
    expect(shouldVirtualizeItemsFeed(20)).toBe(false);
    expect(shouldVirtualizeItemsFeed(21)).toBe(true);
  });

  it("ignores sub-pixel scroll metric jitter", () => {
    expect(shouldUpdateItemsFeedMetric(320, 320.4)).toBe(false);
    expect(shouldUpdateItemsFeedMetric(320, 322)).toBe(true);
    expect(shouldUpdateItemsFeedMetric(320, Number.NaN)).toBe(false);
  });

  it("uses larger estimates for reader feed rows", () => {
    expect(
      estimateItemsFeedRowSize({ density: "compact", isReaderPreset: false }),
    ).toBeLessThan(
      estimateItemsFeedRowSize({ density: "default", isReaderPreset: true }),
    );
  });
});
