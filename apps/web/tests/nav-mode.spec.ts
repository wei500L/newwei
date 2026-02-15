import { describe, expect, it } from "vitest";

import {
  DESKTOP_RAIL_MIN_WIDTH,
  RAIL_SCROLL_MIN_FIT_RATIO,
  estimateRailContentHeight,
  resolveNavMode,
} from "../app/(app)/components/nav-mode";

describe("resolveNavMode", () => {
  it("uses drawer below desktop width threshold", () => {
    expect(
      resolveNavMode({
        viewportWidth: DESKTOP_RAIL_MIN_WIDTH - 1,
        availableRailHeight: 800,
        railContentHeight: 500,
      })
    ).toBe("drawer");
  });

  it("uses rail when content fits available space", () => {
    expect(
      resolveNavMode({
        viewportWidth: DESKTOP_RAIL_MIN_WIDTH,
        availableRailHeight: 640,
        railContentHeight: 620,
      })
    ).toBe("rail");
  });

  it("uses rail-scroll when overflow is within fit-ratio threshold", () => {
    const railContentHeight = 600;
    const availableRailHeight = railContentHeight * RAIL_SCROLL_MIN_FIT_RATIO;
    expect(
      resolveNavMode({
        viewportWidth: 1200,
        availableRailHeight,
        railContentHeight,
      })
    ).toBe("rail-scroll");
  });

  it("uses drawer when overflow is severe", () => {
    expect(
      resolveNavMode({
        viewportWidth: 1200,
        availableRailHeight: 400,
        railContentHeight: 600,
      })
    ).toBe("drawer");
  });

  it("falls back to rail when height metrics are not ready", () => {
    expect(
      resolveNavMode({
        viewportWidth: 1200,
        availableRailHeight: 0,
        railContentHeight: 0,
      })
    ).toBe("rail");
  });
});

describe("estimateRailContentHeight", () => {
  it("increases when admin items are present", () => {
    const noAdminHeight = estimateRailContentHeight(10, 0);
    const withAdminHeight = estimateRailContentHeight(10, 2);
    expect(withAdminHeight).toBeGreaterThan(noAdminHeight);
  });
});
