import { describe, expect, it } from "vitest";

import { isAisViewportEmptyStateActive } from "./war-map-ais-mode";

describe("isAisViewportEmptyStateActive（AIS 视口空态判定）", () => {
  it("all 模式：快照可用且视口无船时空态激活", () => {
    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "all",
        allVesselsAvailable: true,
        viewportVesselCount: 0,
        renderedVesselCount: 0,
      }),
    ).toBe(true);
  });

  it("all 模式：视口有船时不激活", () => {
    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "all",
        allVesselsAvailable: true,
        viewportVesselCount: 3,
        renderedVesselCount: 3,
      }),
    ).toBe(false);
  });

  it("all 模式：快照不可用（allVesselsAvailable 非 true）时不激活（走 all 模式独立降级提示）", () => {
    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "all",
        allVesselsAvailable: false,
        viewportVesselCount: 0,
        renderedVesselCount: 0,
      }),
    ).toBe(false);
    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "all",
        viewportVesselCount: 0,
        renderedVesselCount: 0,
      }),
    ).toBe(false);
  });

  it("military/density 模式：视口空态不适用（恒 false）", () => {
    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "military",
        allVesselsAvailable: true,
        viewportVesselCount: 0,
        renderedVesselCount: 0,
      }),
    ).toBe(false);
    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "density",
        allVesselsAvailable: true,
        viewportVesselCount: 0,
        renderedVesselCount: 0,
      }),
    ).toBe(false);
  });

  it("viewportVesselCount 缺失时回退 renderedVesselCount 判定", () => {
    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "all",
        allVesselsAvailable: true,
        viewportVesselCount: undefined,
        renderedVesselCount: 0,
      }),
    ).toBe(true);
    expect(
      isAisViewportEmptyStateActive({
        effectiveMode: "all",
        allVesselsAvailable: true,
        viewportVesselCount: undefined,
        renderedVesselCount: 5,
      }),
    ).toBe(false);
  });
});
