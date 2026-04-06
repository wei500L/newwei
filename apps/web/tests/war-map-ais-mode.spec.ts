import { describe, expect, it } from "vitest";

import {
  AIS_AUTO_ALL_ENTER_ZOOM,
  AIS_AUTO_ALL_EXIT_ZOOM,
  isAisViewportEmptyStateActive,
  isAisAutoModeActive,
  resolveEffectiveAisMode,
} from "@/app/(app)/dashboard/charts/war-map/war-map-ais-mode";

describe("war-map ais auto mode", () => {
  it("switches to all vessels once zoom reaches the enter threshold", () => {
    expect(
      resolveEffectiveAisMode({
        preferredMode: "military",
        autoModeEnabled: true,
        aisLayerVisible: true,
        allVesselsAvailable: true,
        zoom: AIS_AUTO_ALL_ENTER_ZOOM,
        previousEffectiveMode: "military",
      }),
    ).toBe("all");
  });

  it("keeps all vessels active inside the hysteresis window", () => {
    expect(
      resolveEffectiveAisMode({
        preferredMode: "density",
        autoModeEnabled: true,
        aisLayerVisible: true,
        allVesselsAvailable: true,
        zoom: (AIS_AUTO_ALL_ENTER_ZOOM + AIS_AUTO_ALL_EXIT_ZOOM) / 2,
        previousEffectiveMode: "all",
      }),
    ).toBe("all");
  });

  it("falls back to the preferred mode below the exit threshold", () => {
    expect(
      resolveEffectiveAisMode({
        preferredMode: "density",
        autoModeEnabled: true,
        aisLayerVisible: true,
        allVesselsAvailable: true,
        zoom: AIS_AUTO_ALL_EXIT_ZOOM - 0.1,
        previousEffectiveMode: "all",
      }),
    ).toBe("density");
  });

  it("keeps the previous effective mode while all-vessels availability is still loading", () => {
    expect(
      resolveEffectiveAisMode({
        preferredMode: "military",
        autoModeEnabled: true,
        aisLayerVisible: true,
        zoom: 8,
        previousEffectiveMode: "all",
      }),
    ).toBe("all");

    expect(
      resolveEffectiveAisMode({
        preferredMode: "military",
        autoModeEnabled: true,
        aisLayerVisible: true,
        zoom: 8,
      }),
    ).toBe("military");
  });

  it("stays on the preferred mode when auto mode is disabled or vessel snapshots are unavailable", () => {
    expect(
      resolveEffectiveAisMode({
        preferredMode: "military",
        autoModeEnabled: false,
        aisLayerVisible: true,
        allVesselsAvailable: true,
        zoom: 8,
        previousEffectiveMode: "military",
      }),
    ).toBe("military");
    expect(
      resolveEffectiveAisMode({
        preferredMode: "density",
        autoModeEnabled: true,
        aisLayerVisible: true,
        allVesselsAvailable: false,
        zoom: 8,
        previousEffectiveMode: "density",
      }),
    ).toBe("density");
  });

  it("flags auto mode as active only when the effective mode differs from the preferred mode", () => {
    expect(isAisAutoModeActive("military", "all", true)).toBe(true);
    expect(isAisAutoModeActive("density", "density", true)).toBe(false);
    expect(isAisAutoModeActive("military", "all", false)).toBe(false);
  });

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
