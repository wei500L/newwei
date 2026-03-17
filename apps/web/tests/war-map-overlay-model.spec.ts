import { describe, expect, it } from "vitest";

import {
  buildWarMapOverlayLayout,
  buildWarMapOverlayViewModel,
  resolveOverlayDensity,
} from "../app/(app)/dashboard/charts/war-map/war-map-overlay-model";

const t = (_key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? _key;

describe("war-map overlay model", () => {
  it("resolves density from container breakpoints", () => {
    expect(resolveOverlayDensity(1100, 560)).toBe("expanded");
    expect(resolveOverlayDensity(900, 520)).toBe("compact");
    expect(resolveOverlayDensity(759, 520)).toBe("minimal");
  });

  it("builds desktop overlay layout sizing by density", () => {
    expect(
      buildWarMapOverlayLayout({
        wrapperWidth: 1400,
        wrapperHeight: 600,
        overlayDensity: "expanded",
        hasNonFatalErrors: false,
      }),
    ).toEqual({
      overlayTopClassName: "top-4",
      overlayRailWidth: 360,
      overlayPanelMaxHeight: 264,
      controlsPanelWidth: 320,
      inspectorPanelHeight: 312,
      inspectorPanelWidth: 360,
      showActionLabels: true,
    });

    expect(
      buildWarMapOverlayLayout({
        wrapperWidth: 800,
        wrapperHeight: 500,
        overlayDensity: "compact",
        hasNonFatalErrors: true,
      }),
    ).toEqual({
      overlayTopClassName: "top-20",
      overlayRailWidth: 300,
      overlayPanelMaxHeight: 220,
      controlsPanelWidth: 300,
      inspectorPanelHeight: 220,
      inspectorPanelWidth: 320,
      showActionLabels: false,
    });
  });

  it("builds tabs, cards, and pending data labels for the controls panel", () => {
    const viewModel = buildWarMapOverlayViewModel({
      t,
      rawEventsCount: 12,
      rawNewsMarkersCount: 7,
      monitorsCount: 3,
      visibleLayerCount: 5,
      streamStatusLabel: "Live",
      streamStatusColor: "green",
      streamMessageRelative: "2m ago",
      streamMessageExact: "Mar 17, 2026, 16:00",
      streamError: null,
      dataStatusLabel: "Waiting for first data",
      dataStatusColor: "default",
      latestQueryUpdatedRelative: null,
      latestQueryUpdatedExact: null,
      summaryDataLabel: "Waiting for data",
      healthyChainCount: 2,
      refreshingChainCount: 1,
      errorChainCount: 0,
      detailedChainStatuses: [],
    });

    expect(viewModel.controlsTabs.map((tab) => tab.key)).toEqual([
      "overview",
      "view",
      "transport",
      "feeds",
      "legend",
    ]);
    expect(viewModel.overviewMetricCards.map((card) => card.value)).toEqual([
      12,
      7,
      3,
      5,
    ]);
    expect(viewModel.summaryDataLabel).toBe("Waiting for data");
    expect(viewModel.overviewDataTagLabel).toBe("Pending");
    expect(viewModel.summaryStatusCards[0]?.tooltip).toContain("Stream message");
    expect(viewModel.feedSummaryCards.map((card) => card.value)).toEqual([
      2,
      1,
      0,
    ]);
  });
});
