import { describe, expect, it } from "vitest";

import { isAisViewportEmptyStateActive } from "@/app/(app)/dashboard/charts/war-map/war-map-ais-mode";

describe("war-map ais viewport state", () => {
  it("flags all-vessels empty state only when the viewport has no rendered vessel positions", () => {
    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "all",
        allVesselsAvailable: true,
        viewportVesselCount: 0,
        renderedVesselCount: 0,
      }),
    ).toBe(true);

    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "all",
        allVesselsAvailable: true,
        viewportVesselCount: 12,
        renderedVesselCount: 8,
      }),
    ).toBe(false);

    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "military",
        allVesselsAvailable: true,
        renderedVesselCount: 0,
      }),
    ).toBe(false);

    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "all",
        allVesselsAvailable: false,
        renderedVesselCount: 0,
      }),
    ).toBe(false);
  });
});
