import { describe, expect, it } from "vitest";

import {
  downgradeDensityMode,
  NAV_COMPACT_MIN_WIDTH,
  NAV_FULL_MIN_WIDTH,
  NAV_UPGRADE_SLACK,
  resolveBaseDensityMode,
  upgradeDensityMode,
} from "../app/(app)/components/top-nav-density";

describe("resolveBaseDensityMode", () => {
  it("returns full at or above the full threshold", () => {
    expect(resolveBaseDensityMode(NAV_FULL_MIN_WIDTH)).toBe("full");
    expect(resolveBaseDensityMode(NAV_FULL_MIN_WIDTH + 120)).toBe("full");
  });

  it("returns compact between compact and full thresholds", () => {
    expect(resolveBaseDensityMode(NAV_COMPACT_MIN_WIDTH)).toBe("compact");
    expect(resolveBaseDensityMode(NAV_FULL_MIN_WIDTH - 1)).toBe("compact");
  });

  it("returns minimal below compact threshold", () => {
    expect(resolveBaseDensityMode(NAV_COMPACT_MIN_WIDTH - 1)).toBe("minimal");
    expect(resolveBaseDensityMode(960)).toBe("minimal");
  });
});

describe("downgradeDensityMode", () => {
  it("downgrades from full to compact", () => {
    expect(downgradeDensityMode("full")).toBe("compact");
  });

  it("downgrades compact to minimal", () => {
    expect(downgradeDensityMode("compact")).toBe("minimal");
  });

  it("keeps minimal at minimal", () => {
    expect(downgradeDensityMode("minimal")).toBe("minimal");
  });
});

describe("upgradeDensityMode", () => {
  it("upgrades minimal to compact when target is full", () => {
    expect(upgradeDensityMode("minimal", "full")).toBe("compact");
  });

  it("upgrades minimal directly to compact target", () => {
    expect(upgradeDensityMode("minimal", "compact")).toBe("compact");
  });

  it("upgrades compact to full only when target is full", () => {
    expect(upgradeDensityMode("compact", "full")).toBe("full");
    expect(upgradeDensityMode("compact", "compact")).toBe("compact");
  });

  it("keeps mode when already at target", () => {
    expect(upgradeDensityMode("full", "full")).toBe("full");
  });
});

describe("density constants", () => {
  it("uses a positive upgrade slack", () => {
    expect(NAV_UPGRADE_SLACK).toBeGreaterThan(0);
  });
});
