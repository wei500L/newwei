import { describe, expect, it } from "vitest";

import {
  buildWarMapOverlayLayout,
  buildWarMapOverlayViewModel,
  resolveOverlayDensity,
  resolveOverlayButtonClassName,
  severityTagColor,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";

const t = ((key: string, options?: Record<string, unknown>) => {
  if (key === "dashboard.charts.warMap.overlay.feedsAttentionHint") {
    return `feeds-attention(${options?.count})`;
  }
  return `⟦${key}⟧`;
}) as WarMapTranslateFn;

const baseViewModelParams = {
  t,
  rawEventsCount: 11,
  rawNewsMarkersCount: 22,
  monitorsCount: 3,
  visibleLayerCount: 7,
  streamStatusLabel: "live",
  streamStatusColor: "green",
  streamMessageRelative: "1 min ago",
  streamMessageExact: "2026-01-05T00:00:00Z",
  streamError: null,
  dataStatusLabel: "fresh",
  dataStatusColor: "blue",
  latestQueryUpdatedRelative: "2 min ago",
  latestQueryUpdatedExact: "2026-01-05T00:00:00Z",
  summaryDataLabel: "window 7d",
  healthyChainCount: 2,
  refreshingChainCount: 1,
  errorChainCount: 0,
  detailedChainStatuses: [
    { key: "chain-a", color: "green", text: "ok", tooltip: "chain a" },
  ],
};

describe("War Map overlay model（FE-批4B characterization）", () => {
  describe("resolveOverlayDensity", () => {
    it("宽度与高度共同决定密度档位", () => {
      expect(resolveOverlayDensity(1200, 700)).toBe("expanded");
      expect(resolveOverlayDensity(800, 500)).toBe("compact");
      expect(resolveOverlayDensity(800, 400)).toBe("minimal");
      expect(resolveOverlayDensity(700, 500)).toBe("minimal");
      expect(resolveOverlayDensity(400, 300)).toBe("minimal");
    });
  });

  describe("buildWarMapOverlayLayout", () => {
    it("expanded 密度下宽度按比例收敛于上限", () => {
      const layout = buildWarMapOverlayLayout({
        wrapperWidth: 1600,
        wrapperHeight: 900,
        overlayDensity: "expanded",
        hasNonFatalErrors: false,
      });
      expect(layout.controlsPanelWidth).toBe(360);
      expect(layout.legendPanelWidth).toBe(340);
      expect(layout.overlayRailWidth).toBe(272);
      expect(layout.showActionLabels).toBe(true);
      expect(layout.overlayTopClassName).toBe("top-4");
    });

    it("hasNonFatalErrors 时顶部偏移为 top-20", () => {
      const layout = buildWarMapOverlayLayout({
        wrapperWidth: 1600,
        wrapperHeight: 900,
        overlayDensity: "expanded",
        hasNonFatalErrors: true,
      });
      expect(layout.overlayTopClassName).toBe("top-20");
    });

    it("compact 密度：面板宽度下限与 showActionLabels=false", () => {
      const layout = buildWarMapOverlayLayout({
        wrapperWidth: 1000,
        wrapperHeight: 600,
        overlayDensity: "compact",
        hasNonFatalErrors: false,
      });
      expect(layout.controlsPanelWidth).toBe(288);
      expect(layout.showActionLabels).toBe(false);
      expect(layout.inspectorPanelWidth).toBeLessThanOrEqual(320);
    });

    it("minimal 密度：rail 与面板贴近 wrapper 宽度", () => {
      const layout = buildWarMapOverlayLayout({
        wrapperWidth: 500,
        wrapperHeight: 400,
        overlayDensity: "minimal",
        hasNonFatalErrors: false,
      });
      expect(layout.overlayRailWidth).toBeLessThanOrEqual(280);
      expect(layout.overlayRailWidth).toBeGreaterThanOrEqual(220);
      expect(layout.showActionLabels).toBe(false);
    });

    it("standalone 布局产生底部抽屉高度，embedded 为 0", () => {
      const standalone = buildWarMapOverlayLayout({
        wrapperWidth: 1200,
        wrapperHeight: 800,
        overlayDensity: "expanded",
        hasNonFatalErrors: false,
        layoutVariant: "standalone",
      });
      expect(standalone.standaloneDrawerHeight).toBeGreaterThan(400);
      const embedded = buildWarMapOverlayLayout({
        wrapperWidth: 1200,
        wrapperHeight: 800,
        overlayDensity: "expanded",
        hasNonFatalErrors: false,
        layoutVariant: "embedded",
      });
      expect(embedded.standaloneDrawerHeight).toBe(0);
    });
  });

  describe("buildWarMapOverlayViewModel", () => {
    it("controlsSectionMeta 五节标签与描述来自 t()", () => {
      const vm = buildWarMapOverlayViewModel(baseViewModelParams);
      expect(Object.keys(vm.controlsSectionMeta)).toEqual(
        ["overview", "view", "transport", "feeds", "legend"],
      );
      expect(vm.controlsSectionMeta.view.label).toBe(
        "⟦dashboard.charts.warMap.overlay.view⟧",
      );
    });

    it("controlsTabs 三页签（view/transport/feeds），无 attention 时 feeds 无徽标", () => {
      const vm = buildWarMapOverlayViewModel(baseViewModelParams);
      expect(vm.controlsTabs.map((tab) => tab.key)).toEqual([
        "view",
        "transport",
        "feeds",
      ]);
      const feeds = vm.controlsTabs.find((tab) => tab.key === "feeds");
      expect(feeds?.attentionLabel).toBeUndefined();
      expect(feeds?.attentionTooltip).toBeUndefined();
    });

    it("errorChainCount > 0 时 feeds 页签出现 attention 徽标与 tooltip", () => {
      const vm = buildWarMapOverlayViewModel({
        ...baseViewModelParams,
        errorChainCount: 4,
      });
      const feeds = vm.controlsTabs.find((tab) => tab.key === "feeds");
      expect(feeds?.attentionLabel).toBe(
        "⟦dashboard.charts.warMap.overlay.feedsAttention⟧",
      );
      expect(feeds?.attentionTone).toBe("warning");
      expect(feeds?.attentionTooltip).toBe("feeds-attention(4)");
    });

    it("overviewMetricCards：signals/news/monitors/layers 顺序与数值", () => {
      const vm = buildWarMapOverlayViewModel(baseViewModelParams);
      expect(vm.overviewMetricCards.map((card) => card.key)).toEqual([
        "signals",
        "news",
        "monitors",
        "layers",
      ]);
      expect(vm.overviewMetricCards[0]?.value).toBe(11);
      expect(vm.overviewMetricCards[3]?.value).toBe(7);
    });

    it("summaryStatusCards：stream/data 状态点颜色映射", () => {
      const vm = buildWarMapOverlayViewModel(baseViewModelParams);
      const stream = vm.summaryStatusCards.find((c) => c.key === "stream");
      expect(stream?.dotClassName).toContain("bg-emerald-500");
      const data = vm.summaryStatusCards.find((c) => c.key === "data");
      expect(data?.dotClassName).toContain("bg-sky-500");
      // 非常规颜色回落 rose / slate
      const vm2 = buildWarMapOverlayViewModel({
        ...baseViewModelParams,
        streamStatusColor: "red",
        dataStatusColor: "unknown",
      });
      expect(
        vm2.summaryStatusCards.find((c) => c.key === "stream")?.dotClassName,
      ).toContain("bg-rose-500");
      expect(
        vm2.summaryStatusCards.find((c) => c.key === "data")?.dotClassName,
      ).toContain("bg-slate-400");
    });

    it("feedSummaryCards：healthy/refreshing/issues 计数", () => {
      const vm = buildWarMapOverlayViewModel(baseViewModelParams);
      expect(vm.feedSummaryCards.map((c) => [c.key, c.value])).toEqual([
        ["healthy", 2],
        ["refreshing", 1],
        ["issues", 0],
      ]);
    });

    it("overviewDataTagLabel 优先最近更新相对时间", () => {
      const vm = buildWarMapOverlayViewModel(baseViewModelParams);
      expect(vm.overviewDataTagLabel).toBe("2 min ago");
      const vm2 = buildWarMapOverlayViewModel({
        ...baseViewModelParams,
        latestQueryUpdatedRelative: null,
      });
      expect(vm2.overviewDataTagLabel).toBe(
        "⟦dashboard.charts.warMap.overlay.awaitingRefresh⟧",
      );
    });

    it("stream tooltip 优先精确时间，否则回落 streamError", () => {
      const vm = buildWarMapOverlayViewModel(baseViewModelParams);
      expect(vm.summaryStatusCards[0]?.tooltip).toContain(
        "⟦dashboard.charts.warMap.overlay.latestStreamUpdate⟧",
      );
      const vm2 = buildWarMapOverlayViewModel({
        ...baseViewModelParams,
        streamMessageExact: null,
        streamError: "SSE dropped",
      });
      expect(vm2.summaryStatusCards[0]?.tooltip).toBe("SSE dropped");
    });
  });

  describe("resolveOverlayButtonClassName", () => {
    it("四种 tone 的 class 前缀与 iconOnly/extra 组合", () => {
      const neutral = resolveOverlayButtonClassName();
      expect(neutral).toContain("!bg-white");
      const active = resolveOverlayButtonClassName({ tone: "active" });
      expect(active).toContain("!bg-slate-900");
      const ghost = resolveOverlayButtonClassName({ tone: "ghost" });
      expect(ghost).toContain("!bg-transparent");
      const link = resolveOverlayButtonClassName({ tone: "link" });
      expect(link).toContain("!text-xs");
      expect(resolveOverlayButtonClassName({ iconOnly: true })).toContain(
        "!min-w-8 !px-0",
      );
      expect(
        resolveOverlayButtonClassName({ extraClassName: "extra-x" }),
      ).toContain("extra-x");
    });
  });

  describe("severityTagColor", () => {
    it("high/medium/low 映射 red/gold/blue", () => {
      expect(severityTagColor("high")).toBe("red");
      expect(severityTagColor("medium")).toBe("gold");
      expect(severityTagColor("low")).toBe("blue");
    });
  });
});
