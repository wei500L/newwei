import { describe, expect, it } from "vitest";

import {
  shouldUpdateNewsnowGridMetric,
  shouldVirtualizeNewsnowGridRows,
} from "../app/(app)/newsnow/lib/newsnow-grid-virtualization";

describe("newsnow grid virtualization", () => {
  it("waits for a measured desktop grid before enabling window virtualization", () => {
    expect(
      shouldVirtualizeNewsnowGridRows({
        activeDragId: null,
        gridWidth: 0,
        isMobile: false,
        rowGroupCount: 5,
      }),
    ).toBe(false);

    expect(
      shouldVirtualizeNewsnowGridRows({
        activeDragId: null,
        gridWidth: 1280,
        isMobile: false,
        rowGroupCount: 5,
      }),
    ).toBe(true);
  });

  it("disables virtualization while dragging and for short lists", () => {
    expect(
      shouldVirtualizeNewsnowGridRows({
        activeDragId: "weibo",
        gridWidth: 1280,
        isMobile: false,
        rowGroupCount: 8,
      }),
    ).toBe(false);

    expect(
      shouldVirtualizeNewsnowGridRows({
        activeDragId: null,
        gridWidth: 1280,
        isMobile: false,
        rowGroupCount: 4,
      }),
    ).toBe(false);
  });

  it("treats sub-pixel metric jitter as unchanged", () => {
    expect(shouldUpdateNewsnowGridMetric(640, 640.4)).toBe(false);
    expect(shouldUpdateNewsnowGridMetric(640, 642)).toBe(true);
    expect(shouldUpdateNewsnowGridMetric(640, Number.NaN)).toBe(false);
  });
});
