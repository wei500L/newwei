import { describe, expect, it } from "vitest";

import {
  buildWarMapLegendSections,
  buildWarMapQuickLegendItems,
  coerceHexColor,
  getQuickLegendVisibility,
  matchesWarMapLegendItem,
} from "../app/(app)/dashboard/charts/war-map/war-map-symbols";

const t = (key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key;

describe("war-map symbols", () => {
  it("normalizes theme colors to hex", () => {
    expect(coerceHexColor("#abc")).toBe("#aabbcc");
    expect(coerceHexColor("rgb(15, 23, 42)")).toBe("#0f172a");
    expect(coerceHexColor("bad-value", "#123456")).toBe("#123456");
  });

  it("builds quick legend items from the active AIS mode", () => {
    const densityItems = buildWarMapQuickLegendItems({
      t,
      showMonitors: true,
      showFlights: false,
      showAis: true,
      effectiveAisMode: "density",
    });
    expect(densityItems.map((item) => item.key)).toEqual([
      "signal-high",
      "signal-medium",
      "signal-low",
      "news-geocoded",
      "monitor",
      "ais-density",
      "ais-disruption",
    ]);

    const allItems = buildWarMapQuickLegendItems({
      t,
      showMonitors: false,
      showFlights: true,
      showAis: true,
      effectiveAisMode: "all",
    });
    expect(allItems.map((item) => item.key)).toContain("flight");
    expect(allItems.map((item) => item.key)).toContain("ais-vessel-generic");
    expect(
      allItems.find((item) => item.key === "ais-vessel-generic")?.note,
    ).toBe("Color shows vessel category");
  });

  it("builds full legend sections including active point overlays", () => {
    const sections = buildWarMapLegendSections({
      t,
      showMonitors: true,
      showFlights: true,
      showAis: true,
      effectiveAisMode: "all",
      activePointLayers: [
        {
          key: "techHQs",
          label: "Tech HQs",
          accentColor: "#ec4899",
        },
      ],
    });

    expect(sections.map((section) => section.key)).toEqual([
      "signals",
      "news",
      "transport",
      "states",
      "other-point-layers",
    ]);
    expect(
      sections
        .find((section) => section.key === "transport")
        ?.items.map((item) => item.key),
    ).toContain("ais-vessel-cargo");
    expect(
      sections.find((section) => section.key === "other-point-layers")?.items,
    ).toEqual([
      {
        key: "techHQs",
        symbolKey: "generic-point",
        accentColor: "#ec4899",
        label: "Tech HQs",
        matchLayerIds: ["techHQs"],
      },
    ]);
  });

  it("shows the quick legend only on expanded and compact overlays", () => {
    expect(getQuickLegendVisibility("expanded")).toBe(true);
    expect(getQuickLegendVisibility("compact")).toBe(true);
    expect(getQuickLegendVisibility("minimal")).toBe(false);
  });

  it("matches legend entries to symbol families and active point layers", () => {
    expect(
      matchesWarMapLegendItem(
        {
          symbolKey: "ais-disruption-high",
          matchSymbolKeys: [
            "ais-disruption-high",
            "ais-disruption-medium",
            "ais-disruption-low",
          ],
        },
        { symbolKey: "ais-disruption-low" },
      ),
    ).toBe(true);
    expect(
      matchesWarMapLegendItem(
        {
          symbolKey: "generic-point",
          matchLayerIds: ["techHQs"],
        },
        { symbolKey: "generic-point", layerId: "techHQs" },
      ),
    ).toBe(true);
    expect(
      matchesWarMapLegendItem(
        {
          symbolKey: "flight",
          matchSymbolKeys: ["flight"],
        },
        { symbolKey: "signal-low" },
      ),
    ).toBe(false);
  });
});
