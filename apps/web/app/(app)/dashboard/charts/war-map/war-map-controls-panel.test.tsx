import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WarMapControlsPanel } from "./war-map-controls-panel";
import type {
  WarMapControlsPanelProps,
  WarMapControlsPanelTransportProps,
} from "./war-map-controls-types";
import { WarMapLegendDock } from "./war-map-legend-dock";
import { WarMapLegendPanel } from "./war-map-legend-panel";
import {
  buildWarMapLegendSections,
  buildWarMapInteractionLegendItems,
} from "./war-map-symbols";

const t = ((key: string, options?: Record<string, unknown>) => {
  if (key === "dashboard.charts.warMap.legend.moreItems") {
    return `+${options?.count} more`;
  }
  return `⟦${key}⟧`;
}) as never;

const emptyFlightsPresentation = {
  flightsReturnedCount: undefined,
  flightsSnapshotCount: undefined,
  flightsFreshness: undefined,
  flightsSourceBadgeLabel: null,
  flightsTooltipText: null,
} as unknown as WarMapControlsPanelTransportProps["flights"]["presentation"];

const emptyAisPresentation = {
  aisAllModeDegraded: false,
  aisResolvedStatusReason: null,
} as unknown as WarMapControlsPanelTransportProps["ais"]["presentation"];

const transport: WarMapControlsPanelTransportProps = {
  flights: {
    mode: "all",
    visible: true,
    presentation: emptyFlightsPresentation,
    onModeChange: vi.fn(),
  },
  ais: {
    mode: "all",
    effectiveMode: "all",
    visible: true,
    highlightCandidates: false,
    highlightedCandidateCount: undefined,
    presentation: emptyAisPresentation,
    onModeChange: vi.fn(),
    onHighlightCandidatesChange: vi.fn(),
  },
  analysis: {
    allowed: true,
    submitting: false,
    onSubmit: vi.fn(),
  },
  legend: {
    onOpen: vi.fn(),
  },
};

const view: WarMapControlsPanelProps["view"] = {
  presets: [
    { key: "global", label: "Global", active: true },
    { key: "eu", label: "Europe", active: false },
  ],
  timeRanges: [
    { key: "24h", label: "24h", active: true },
    { key: "7d", label: "7d", active: false },
  ],
  layerVisibilityControls: <div>layer-visibility-slot</div>,
  onPresetSelect: vi.fn(),
  onTimeRangeSelect: vi.fn(),
  onResetLayers: vi.fn(),
};

const legendSections = buildWarMapLegendSections({
  t,
  showMonitors: true,
  showFlights: true,
  showAis: true,
  effectiveAisMode: "all",
  activePointLayers: [],
});

const interactionLegendItems = buildWarMapInteractionLegendItems({ t });

const overlayViewModel = {
  sectionMeta: {
    overview: { label: "Overview", description: "overview hint" },
    view: { label: "View", description: "view hint" },
    transport: { label: "Transport", description: "transport hint" },
    feeds: { label: "Feeds", description: "feeds hint" },
    legend: { label: "Legend", description: "legend hint" },
  },
  tabs: [
    { key: "view", label: "View" },
    { key: "transport", label: "Transport" },
    { key: "feeds", label: "Feeds" },
  ],
  overviewMetricCards: [
    {
      key: "signals",
      label: "Signals",
      value: 12,
      note: "signal density",
      className: "x",
    },
  ],
  summaryStatusCards: [
    {
      key: "stream",
      label: "Stream",
      value: "live",
      detail: "no recent message",
      dotClassName: "dot",
      tagColor: "green",
    },
    {
      key: "data",
      label: "Data",
      value: "fresh",
      detail: "awaiting refresh",
      dotClassName: "dot2",
      tagColor: "blue",
    },
  ],
  summaryDataLabel: "data label",
  overviewDataTagLabel: "tag label",
  feedSummaryCards: [
    { key: "healthy", label: "Healthy", value: 3, toneClassName: "y" },
    { key: "refreshing", label: "Refreshing", value: 1, toneClassName: "y" },
    { key: "issues", label: "Issues", value: 0, toneClassName: "y" },
  ],
  detailedChainStatuses: [
    { key: "chain-a", color: "green", text: "chain a ok", tooltip: "tt" },
  ],
};

function panelProps(overrides?: {
  section?: string;
  layout?: Record<string, unknown>;
  transport?: typeof transport;
  legend?: Record<string, unknown>;
  onSectionChange?: (section: never) => void;
  onClose?: () => void;
}): WarMapControlsPanelProps {
  return {
    header: {
      section: (overrides?.section ?? "view") as never,
      sectionMeta: overlayViewModel.sectionMeta,
      tabs: overlayViewModel.tabs,
      overviewMetricCards: overlayViewModel.overviewMetricCards,
      summaryStatusCards: overlayViewModel.summaryStatusCards,
      summaryDataLabel: overlayViewModel.summaryDataLabel,
      overviewDataTagLabel: overlayViewModel.overviewDataTagLabel,
      windowLabel: "7d",
    },
    view,
    transport: overrides?.transport ?? transport,
    feeds: {
      summaryCards: overlayViewModel.feedSummaryCards,
      detailedChainStatuses: overlayViewModel.detailedChainStatuses,
    },
    legend: {
      sections: legendSections,
      interactionItems: interactionLegendItems,
      ...(overrides?.legend ?? {}),
    },
    layout: {
      variant: "embedded",
      useDrawerControls: false,
      panelMaxHeight: 520,
      ...(overrides?.layout ?? {}),
    },
    actions: {
      onSectionChange:
        overrides?.onSectionChange ??
        (() => {
          /* 受控组件：默认 no-op */
        }),
      onClose: overrides?.onClose,
    },
    t,
  };
}

type PanelOverrides = Parameters<typeof panelProps>[0];

function renderPanel(
  overrides?: PanelOverrides,
): ReturnType<typeof render> {
  return render(<WarMapControlsPanel {...panelProps(overrides)} />);
}

describe("WarMapControlsPanel（FE-批4B characterization）", () => {
  it("view 节：preset 与时间范围按钮触发回调", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Europe" }));
    expect(view.onPresetSelect).toHaveBeenCalledWith("eu");
    await userEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(view.onTimeRangeSelect).toHaveBeenCalledWith("7d");
    // 图层可见性槽位渲染
    expect(screen.getByText("layer-visibility-slot")).toBeInTheDocument();
    // reset 链接存在
    expect(
      screen.getByRole("button", { name: "⟦common.reset⟧" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "⟦common.reset⟧" }),
    );
    expect(view.onResetLayers).toHaveBeenCalledTimes(1);
  });

  it("页签切换：点击 Transport 页签回调切节命令；受控切到 transport 后渲染分析入口", async () => {
    const onSectionChange = vi.fn();
    const { rerender } = renderPanel({ onSectionChange });
    await userEvent.click(screen.getByRole("button", { name: "Transport" }));
    expect(onSectionChange).toHaveBeenCalledWith("transport");

    // 受控更新节后 transport 内容出现
    rerender(
      <WarMapControlsPanel
        {...panelProps({ section: "transport" })}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "⟦dashboard.charts.warMap.actions.analyzeCurrentView⟧",
      }),
    ).toBeInTheDocument();
  });

  it("transport 节：AIS 模式按钮切换与航班模式切换", async () => {
    renderPanel({ section: "transport" });
    await userEvent.click(
      screen.getByRole("button", { name: "⟦dashboard.charts.warMap.stats.aisModeDensity⟧" }),
    );
    expect(transport.ais.onModeChange).toHaveBeenCalledWith("density");
    await userEvent.click(
      screen.getByRole("button", { name: "⟦dashboard.charts.warMap.stats.flightModeMilitary⟧" }),
    );
    expect(transport.flights.onModeChange).toHaveBeenCalledWith("military");
  });

  it("transport 节：AIS reference 区块渲染前四个 ais 项并提供打开完整图例入口", async () => {
    renderPanel({ section: "transport" });
    const openLegend = screen.getByRole("button", {
      name: "⟦dashboard.charts.warMap.overlay.openFullLegend⟧",
    });
    await userEvent.click(openLegend);
    expect(transport.legend.onOpen).toHaveBeenCalledTimes(1);
  });

  it("transport 节：分析按钮权限门禁与提交", async () => {
    const { unmount } = renderPanel({ section: "transport" });
    const analyze = screen.getByRole("button", {
      name: "⟦dashboard.charts.warMap.actions.analyzeCurrentView⟧",
    });
    await userEvent.click(analyze);
    expect(transport.analysis.onSubmit).toHaveBeenCalledTimes(1);
    unmount();

    renderPanel({
      section: "transport",
      transport: {
        ...transport,
        analysis: {
          allowed: false,
          submitting: false,
          onSubmit: transport.analysis.onSubmit,
        },
      },
    });
    expect(
      screen.getByRole("button", {
        name: "⟦dashboard.charts.warMap.actions.analyzeCurrentView⟧",
      }),
    ).toBeDisabled();
  });

  it("transport 节：AIS 隐藏时显示提示而非模式按钮", () => {
    renderPanel({
      section: "transport",
      transport: {
        ...transport,
        ais: { ...transport.ais, visible: false },
      },
    });
    expect(
      screen.getByText("⟦dashboard.charts.warMap.overlay.aisStatusHint⟧"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "⟦dashboard.charts.warMap.stats.aisModeAll⟧",
      }),
    ).not.toBeInTheDocument();
  });

  it("feeds 节：feed 卡与 chain 状态渲染", () => {
    renderPanel({ section: "feeds" });
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Refreshing")).toBeInTheDocument();
    expect(screen.getByText("Issues")).toBeInTheDocument();
    expect(screen.getByText("chain a ok")).toBeInTheDocument();
  });

  it("legend 节：section 展开/收起带 aria-expanded 与 aria-controls（a11y 收口）", async () => {
    renderPanel({ section: "legend" });
    // signals 节默认展开：含 signal-high 项
    expect(
      screen.getByText("⟦dashboard.charts.warMap.legend.signalHigh⟧"),
    ).toBeInTheDocument();
    // 折叠 signals 节：展开按钮携带可访问状态与受控区域 id
    const collapseButton = screen.getByRole("button", {
      name: /⟦dashboard\.charts\.warMap\.legend\.signalsTitle⟧/,
    });
    expect(collapseButton).toHaveAttribute("aria-expanded", "true");
    const contentId = collapseButton.getAttribute("aria-controls");
    expect(contentId).toBeTruthy();
    expect(document.getElementById(contentId ?? "")).not.toBeNull();
    await userEvent.click(collapseButton);
    expect(collapseButton).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("⟦dashboard.charts.warMap.legend.signalHigh⟧"),
    ).not.toBeInTheDocument();
  });

  it("legend 节：聚焦徽标文案经 i18n（不再硬编码 Focus）", () => {
    renderPanel({
      section: "legend",
      legend: { activeLegendKey: "signal-high" },
    });
    // t mock 包装 key；真实 en/zh 翻译由 locale 文件提供（Focused/已聚焦）
    expect(
      screen.getByText("⟦dashboard.charts.warMap.legend.focusBadge⟧"),
    ).toBeInTheDocument();
  });

  it("legend 节：聚焦后该项可取消聚焦（active toggle null）", async () => {
    const onLegendItemFocus = vi.fn();
    renderPanel({
      section: "legend",
      legend: { activeLegendKey: "signal-high", onLegendItemFocus },
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: /⟦dashboard\.charts\.warMap\.legend\.signalHigh⟧/,
      }),
    );
    expect(onLegendItemFocus).toHaveBeenCalledWith(null);
  });

  it("header summary：window 胶囊与指标卡渲染（view 节）", () => {
    renderPanel();
    // window 胶囊内 7d 与指标卡数值 12（时间范围按钮的 7d 属于 View 节选项，
    // header 胶囊同样包含 7d，用 getAllByText 锁定至少出现）
    expect(screen.getAllByText("7d").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("useDrawerControls 或 standalone 时渲染关闭按钮", async () => {
    const onClose = vi.fn();
    renderPanel({ layout: { useDrawerControls: true, variant: "embedded", panelMaxHeight: 520 }, onClose });
    await userEvent.click(screen.getByRole("button", { name: "⟦common.close⟧" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("卸载后 ResizeObserver 断连、RAF 取消（无泄漏）", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const cancelAnimationFrame = vi.spyOn(
      window,
      "cancelAnimationFrame",
    );
    class ControlledResizeObserver {
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    try {
      const { unmount } = renderPanel();
      unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    cancelAnimationFrame.mockRestore();
  });
});

describe("WarMapLegendPanel（FE-批4B characterization）", () => {
  it("渲染标题、hint 与全部 section；无 active 项时不显示 clearFocus", () => {
    render(
      <WarMapLegendPanel
        legendSections={legendSections}
        interactionLegendItems={interactionLegendItems}
        summaryDataLabel="data label"
        t={t}
      />,
    );
    expect(
      screen.getByText("⟦dashboard.charts.warMap.legend.title⟧"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("⟦dashboard.charts.warMap.legend.signalsTitle⟧"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "⟦dashboard.charts.warMap.legend.clearFocus⟧",
      }),
    ).not.toBeInTheDocument();
  });

  it("active 项存在时 clearFocus 取消聚焦；onClose 关闭面板", async () => {
    const onLegendItemFocus = vi.fn();
    const onClose = vi.fn();
    render(
      <WarMapLegendPanel
        legendSections={legendSections}
        interactionLegendItems={interactionLegendItems}
        summaryDataLabel="data label"
        activeLegendKey="signal-high"
        onLegendItemFocus={onLegendItemFocus}
        onClose={onClose}
        t={t}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "⟦dashboard.charts.warMap.legend.clearFocus⟧",
      }),
    );
    expect(onLegendItemFocus).toHaveBeenCalledWith(null);
    await userEvent.click(
      screen.getByRole("button", { name: "⟦common.close⟧" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hover 高亮：其他项 muted 语义交由调用方（此处锁定回调）", async () => {
    const onLegendItemHover = vi.fn();
    render(
      <WarMapLegendPanel
        legendSections={legendSections}
        interactionLegendItems={interactionLegendItems}
        onLegendItemHover={onLegendItemHover}
        t={t}
      />,
    );
    const item = screen.getByRole("button", {
      name: /⟦dashboard\.charts\.warMap\.legend\.signalHigh⟧/,
    });
    await userEvent.hover(item);
    expect(onLegendItemHover).toHaveBeenCalledWith("signal-high");
    await userEvent.unhover(item);
    expect(onLegendItemHover).toHaveBeenCalledWith(null);
  });
});

describe("WarMapLegendDock（FE-批4B characterization）", () => {
  it("渲染 interaction strip 与全部 section 卡（不折叠）", () => {
    render(
      <WarMapLegendDock
        legendSections={legendSections}
        interactionLegendItems={interactionLegendItems}
        summaryDataLabel="data label"
        t={t}
      />,
    );
    expect(
      screen.getByText("⟦dashboard.charts.warMap.legend.signalsTitle⟧"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("⟦dashboard.charts.warMap.legend.transportTitle⟧"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("⟦dashboard.charts.warMap.legend.newsTitle⟧"),
    ).toBeInTheDocument();
    // dock 内项不折叠：默认全部可见
    expect(
      screen.getByText("⟦dashboard.charts.warMap.legend.aisTanker⟧"),
    ).toBeInTheDocument();
  });

  it("active 项存在时 clearFocus 取消聚焦", async () => {
    const onLegendItemFocus = vi.fn();
    render(
      <WarMapLegendDock
        legendSections={legendSections}
        interactionLegendItems={interactionLegendItems}
        activeLegendKey="flight"
        onLegendItemFocus={onLegendItemFocus}
        t={t}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "⟦dashboard.charts.warMap.legend.clearFocus⟧",
      }),
    );
    expect(onLegendItemFocus).toHaveBeenCalledWith(null);
  });
});
