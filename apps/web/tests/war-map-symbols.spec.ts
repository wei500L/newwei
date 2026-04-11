import { describe, expect, it } from "vitest";

import {
  buildWarMapInteractionLegendItems,
  buildWarMapLegendSections,
  buildWarMapQuickLegendItems,
  coerceHexColor,
  formatWarMapClusterCountLabel,
  getWarMapDeckIcon,
  getWarMapLegendSvgMarkup,
  getQuickLegendVisibility,
  matchesWarMapLegendItem,
  selectVisibleQuickLegendItems,
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
      transportState: {
        aisPrimary: {
          note: "Aggregated only",
          countLabel: "0",
          tone: "degraded",
        },
      },
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
    expect(densityItems.find((item) => item.key === "ais-density")).toEqual(
      expect.objectContaining({
        note: "Aggregated only",
        countLabel: "0",
        tone: "degraded",
      }),
    );

    const allItems = buildWarMapQuickLegendItems({
      t,
      showMonitors: false,
      showFlights: true,
      showAis: true,
      effectiveAisMode: "all",
      transportState: {
        flights: {
          note: "Zoom in for live aircraft markers.",
          countLabel: "0",
          tone: "degraded",
        },
      },
    });
    expect(allItems.map((item) => item.key)).toContain("flight");
    expect(allItems.map((item) => item.key)).toContain("ais-vessel-generic");
    expect(allItems.find((item) => item.key === "flight")).toEqual(
      expect.objectContaining({
        note: "Zoom in for live aircraft markers.",
        countLabel: "0",
        tone: "degraded",
      }),
    );
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
      transportState: {
        sectionStatusLabel: "Aggregated only",
        sectionStatusTone: "warning",
        sectionStatusHint: "AIS vessel snapshots are unavailable.",
        flights: {
          note: "Snapshot stale",
          countLabel: "0",
          tone: "degraded",
        },
      },
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
      "transport",
      "news",
      "other-point-layers",
    ]);
    expect(sections.find((section) => section.key === "transport")).toEqual(
      expect.objectContaining({
        defaultExpanded: true,
        statusLabel: "Aggregated only",
        statusTone: "warning",
        statusHint: "AIS vessel snapshots are unavailable.",
      }),
    );
    expect(
      sections
        .find((section) => section.key === "transport")
        ?.items.map((item) => item.key),
    ).toContain("ais-vessel-cargo");
    expect(
      sections
        .find((section) => section.key === "transport")
        ?.items.find((item) => item.key === "flight"),
    ).toEqual(
      expect.objectContaining({
        note: "Snapshot stale",
        countLabel: "0",
        tone: "degraded",
      }),
    );
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

  it("builds interaction legend samples separately from semantic sections", () => {
    const items = buildWarMapInteractionLegendItems({ t });

    expect(items).toEqual([
      expect.objectContaining({
        key: "hover",
        state: "hover",
        label: "Hover preview",
      }),
      expect.objectContaining({
        key: "selected",
        state: "selected",
        label: "Pinned focus",
      }),
      expect.objectContaining({
        key: "cluster",
        state: "cluster",
        countLabel: "12",
        label: "Cluster",
      }),
    ]);
  });

  it("shows the quick legend only on expanded and compact overlays", () => {
    expect(getQuickLegendVisibility("expanded")).toBe(true);
    expect(getQuickLegendVisibility("compact")).toBe(true);
    expect(getQuickLegendVisibility("minimal")).toBe(false);
  });

  it("keeps flight and AIS transport cues visible in compact quick legend", () => {
    const items = buildWarMapQuickLegendItems({
      t,
      showMonitors: true,
      showFlights: true,
      showAis: true,
      effectiveAisMode: "all",
    });

    const compactLegend = selectVisibleQuickLegendItems({
      density: "compact",
      items,
    });

    expect(compactLegend.visibleItems.map((item) => item.key)).toContain(
      "flight",
    );
    expect(compactLegend.visibleItems.map((item) => item.key)).toContain(
      "ais-vessel-generic",
    );
    expect(compactLegend.visibleItems).toHaveLength(6);
    expect(compactLegend.hiddenCount).toBe(2);
  });

  it("renders deck icons as data URLs and legend icons as inline SVG", () => {
    const deckIcon = getWarMapDeckIcon({
      symbolKey: "signal-high",
      state: "hover",
    });
    expect(deckIcon.url.startsWith("data:image/svg+xml")).toBe(true);
    expect(decodeURIComponent(deckIcon.url)).toContain('r="8.8"');

    const legendIcon = getWarMapLegendSvgMarkup({
      symbolKey: "signal-high",
      state: "selected",
    });
    expect(legendIcon.startsWith("<svg")).toBe(true);
    expect(legendIcon).toContain("<circle");
    expect(legendIcon).toContain('r="9.15"');
    expect(legendIcon).not.toContain("data:image");
  });

  it("renders specialized cluster and warning markups", () => {
    const clusterIcon = getWarMapLegendSvgMarkup({
      symbolKey: "signal-medium",
      state: "cluster",
    });
    expect(clusterIcon).toContain('r="7.55"');
    expect(clusterIcon).toContain("<path");
    expect(clusterIcon).toContain('cy="12.35"');

    const warningIcon = getWarMapLegendSvgMarkup({
      symbolKey: "ais-disruption-high",
      state: "default",
    });
    expect(warningIcon).toContain("M12 5.55 17.1 16.3H6.9Z");
    expect(warningIcon).toContain("fill=");
  });

  it("uses family-aware interaction states for transport symbols", () => {
    const flightSelected = getWarMapLegendSvgMarkup({
      symbolKey: "flight",
      state: "selected",
    });
    expect(flightSelected).toContain("<rect");
    expect(flightSelected).not.toContain('r="9.15"');

    const vesselHover = getWarMapLegendSvgMarkup({
      symbolKey: "ais-vessel-cargo",
      state: "hover",
    });
    expect(vesselHover).toContain("<rect");
    expect(vesselHover).toContain('rx="4.4"');
  });

  it("formats cluster labels to stay compact inside the bubble", () => {
    expect(formatWarMapClusterCountLabel(1)).toBe("1");
    expect(formatWarMapClusterCountLabel(12)).toBe("12");
    expect(formatWarMapClusterCountLabel(128)).toBe("128");
    expect(formatWarMapClusterCountLabel(1000)).toBe("999+");
    expect(formatWarMapClusterCountLabel(Number.NaN)).toBe("");
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
