import { describe, expect, it } from "vitest";

import {
  buildWarMapOverlayLayout,
  buildWarMapOverlayViewModel,
  resolveOverlayDensity,
} from "../app/(app)/dashboard/charts/war-map/war-map-overlay-model";

const t = (
  _key: string,
  options?: { defaultValue?: string; [key: string]: unknown },
) =>
  typeof options?.defaultValue === "string"
    ? options.defaultValue.replace(/\{\{(\w+)\}\}/g, (_match, token) => {
        const value = options[token];
        return value == null ? `{{${token}}}` : String(value);
      })
    : _key;

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
      overlayRailWidth: 252,
      overlayPanelMaxHeight: 372,
      controlsPanelWidth: 336,
      legendPanelWidth: 308,
      controlsDrawerHeight: 468,
      standaloneDrawerHeight: 0,
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
      overlayRailWidth: 208,
      overlayPanelMaxHeight: 340,
      controlsPanelWidth: 288,
      legendPanelWidth: 280,
      controlsDrawerHeight: 400,
      standaloneDrawerHeight: 0,
      inspectorPanelHeight: 220,
      inspectorPanelWidth: 320,
      showActionLabels: false,
    });
  });

  it("adds standalone legend dock and drawer sizing without changing embedded widths", () => {
    expect(
      buildWarMapOverlayLayout({
        wrapperWidth: 1400,
        wrapperHeight: 900,
        overlayDensity: "expanded",
        hasNonFatalErrors: false,
        layoutVariant: "standalone",
      }),
    ).toEqual({
      overlayTopClassName: "top-4",
      overlayRailWidth: 252,
      overlayPanelMaxHeight: 520,
      controlsPanelWidth: 336,
      legendPanelWidth: 308,
      controlsDrawerHeight: 640,
      standaloneDrawerHeight: 486,
      inspectorPanelHeight: 380,
      inspectorPanelWidth: 360,
      showActionLabels: true,
    });
  });

  it("builds tabs, cards, and empty-state status labels for the controls panel", () => {
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
      dataStatusLabel: "Awaiting first refresh",
      dataStatusColor: "default",
      latestQueryUpdatedRelative: null,
      latestQueryUpdatedExact: null,
      summaryDataLabel: "Awaiting first refresh",
      healthyChainCount: 2,
      refreshingChainCount: 1,
      errorChainCount: 0,
      detailedChainStatuses: [],
    });

    expect(viewModel.controlsTabs.map((tab) => tab.key)).toEqual([
      "view",
      "transport",
      "feeds",
    ]);
    expect(viewModel.controlsSectionMeta.overview.label).toBe("Overview");
    expect(viewModel.controlsTabs.some((tab) => tab.key === "overview")).toBe(
      false,
    );
    expect(viewModel.overviewMetricCards.map((card) => card.value)).toEqual([
      12, 7, 3, 5,
    ]);
    expect(viewModel.summaryDataLabel).toBe("Awaiting first refresh");
    expect(viewModel.overviewDataTagLabel).toBe("Awaiting refresh");
    expect(viewModel.summaryStatusCards[0]?.tooltip).toContain(
      "Latest stream update",
    );
    expect(
      viewModel.controlsTabs.find((tab) => tab.key === "feeds")?.attentionLabel,
    ).toBeUndefined();
    expect(viewModel.feedSummaryCards.map((card) => card.value)).toEqual([
      2, 1, 0,
    ]);
  });

  it("adds a feeds attention label when ingestion issues exist", () => {
    const viewModel = buildWarMapOverlayViewModel({
      t,
      rawEventsCount: 4,
      rawNewsMarkersCount: 2,
      monitorsCount: 1,
      visibleLayerCount: 3,
      streamStatusLabel: "Lagging",
      streamStatusColor: "gold",
      streamMessageRelative: null,
      streamMessageExact: null,
      streamError: null,
      dataStatusLabel: "Awaiting first refresh",
      dataStatusColor: "default",
      latestQueryUpdatedRelative: null,
      latestQueryUpdatedExact: null,
      summaryDataLabel: "Awaiting first refresh",
      healthyChainCount: 1,
      refreshingChainCount: 1,
      errorChainCount: 2,
      detailedChainStatuses: [],
    });

    expect(
      viewModel.controlsTabs.find((tab) => tab.key === "feeds"),
    ).toMatchObject({
      attentionLabel: "Issues",
      attentionTone: "warning",
      attentionTooltip: "Affected feed chains: 2",
    });
    expect(viewModel.summaryStatusCards[0]?.detail).toBe(
      "No stream update yet",
    );
    expect(viewModel.feedSummaryCards.map((card) => card.value)).toEqual([
      1, 1, 2,
    ]);
  });
});
