import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { WarMapOverlayRail } from "./war-map-overlay-rail";
import type { WarMapOverlayRailProps } from "./war-map-overlay-rail";
import {
  buildWarMapQuickLegendItems,
  type WarMapLegendItem,
} from "./war-map-symbols";

const t = ((key: string, options?: Record<string, unknown>) => {
  if (key === "dashboard.charts.warMap.legend.moreItems") {
    return `+${options?.count} more`;
  }
  return `⟦${key}⟧`;
}) as never;

const quickLegendItems: WarMapLegendItem[] = buildWarMapQuickLegendItems({
  t,
  showMonitors: true,
  showFlights: true,
  showAis: true,
  effectiveAisMode: "all",
});

const summaryStatusCards: WarMapOverlayRailProps["summaryStatusCards"] = [
  {
    key: "stream",
    label: "Stream",
    value: "live",
    detail: "no recent message",
    dotClassName: "bg-emerald-500",
    tagColor: "green",
    tooltip: "stream tooltip",
  },
  {
    key: "data",
    label: "Data",
    value: "fresh",
    detail: "awaiting",
    dotClassName: "bg-sky-500",
    tagColor: "blue",
    tooltip: "data tooltip",
  },
];

function renderRail(
  overrides?: Partial<WarMapOverlayRailProps>,
): ReturnType<typeof render> {
  const props: WarMapOverlayRailProps = {
    overlayRailRef: createRef<HTMLDivElement>(),
    overlayDensity: "expanded",
    layoutVariant: "embedded",
    overlayTopClassName: "top-4",
    overlayRailWidth: 272,
    useDrawerControls: false,
    summaryStatusCards,
    summaryDataLabel: "data label",
    refreshingMapData: false,
    showActionLabels: true,
    openOverlayPanel: null,
    quickLegendItems,
    onRefresh: vi.fn(),
    onToggleControls: vi.fn(),
    onToggleLegend: vi.fn(),
    controlsPanel: <div>controls-panel-slot</div>,
    legendPanel: <div>legend-panel-slot</div>,
    t,
    ...overrides,
  };
  return render(<WarMapOverlayRail {...props} />);
}

describe("WarMapOverlayRail（FE-批4B characterization）", () => {
  it("状态摘要：stream/data 卡片与 summaryDataLabel 展示", () => {
    renderRail();
    expect(screen.getByText("Stream")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("Data")).toBeInTheDocument();
    expect(screen.getByText("data label")).toBeInTheDocument();
  });

  it("refresh 按钮触发 onRefresh", async () => {
    const onRefresh = vi.fn();
    renderRail({ onRefresh });
    await userEvent.click(
      screen.getByRole("button", { name: /⟦dashboard\.actions\.fetchLatest⟧/ }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("controls 开关：aria-expanded 表达激活态并触发回调", async () => {
    const onToggleControls = vi.fn();
    const { rerender } = renderRail({
      onToggleControls,
      openOverlayPanel: "controls",
    });
    const controlsButton = screen.getByRole("button", {
      name: "⟦dashboard.charts.warMap.overlay.controls⟧",
    });
    expect(controlsButton).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(controlsButton);
    expect(onToggleControls).toHaveBeenCalledTimes(1);

    rerender(<WarMapOverlayRail {...railProps({ openOverlayPanel: null })} />);
    expect(
      screen.getByRole("button", {
        name: "⟦dashboard.charts.warMap.overlay.controls⟧",
      }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("embedded 无面板打开时：quick legend 展示且带 legend 打开按钮", () => {
    renderRail();
    expect(
      screen.getByText("⟦dashboard.charts.warMap.legend.quickLegendCompactHint⟧"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "⟦dashboard.charts.warMap.legend.title⟧" }),
    ).toBeInTheDocument();
    // quick legend 项（expanded 上限 7）+ hidden count 按钮语义
    const moreButtons = screen.queryAllByRole("button", {
      name: /\+3 more/,
    });
    expect(moreButtons.length).toBeLessThanOrEqual(1);
  });

  it("quick legend 项点击触发聚焦，hover/leave 触发 hover 回调", async () => {
    const onLegendItemFocus = vi.fn();
    const onLegendItemHover = vi.fn();
    renderRail({ onLegendItemFocus, onLegendItemHover });
    const firstItem = screen.getByRole("button", {
      name: /⟦dashboard\.charts\.warMap\.legend\.signalHigh⟧/,
    });
    await userEvent.hover(firstItem);
    expect(onLegendItemHover).toHaveBeenCalledWith("signal-high");
    await userEvent.unhover(firstItem);
    expect(onLegendItemHover).toHaveBeenCalledWith(null);
    await userEvent.click(firstItem);
    expect(onLegendItemFocus).toHaveBeenCalledWith("signal-high");
  });

  it("已有 active 项时点击同项取消聚焦（null）", async () => {
    const onLegendItemFocus = vi.fn();
    renderRail({
      activeLegendKey: "signal-high",
      onLegendItemFocus,
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: /⟦dashboard\.charts\.warMap\.legend\.signalHigh⟧/,
      }),
    );
    expect(onLegendItemFocus).toHaveBeenCalledWith(null);
  });

  it("面板打开时 quick legend 隐藏，legend 工具按钮出现", () => {
    renderRail({ openOverlayPanel: "controls" });
    expect(
      screen.queryByText(
        "⟦dashboard.charts.warMap.legend.quickLegendCompactHint⟧",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "⟦dashboard.charts.warMap.legend.title⟧" }),
    ).toBeInTheDocument();
  });

  it("activePanel：embedded 桌面无 Drawer 时渲染 controlsPanel 槽位", () => {
    renderRail({ openOverlayPanel: "controls" });
    expect(screen.getByText("controls-panel-slot")).toBeInTheDocument();
    expect(screen.queryByText("legend-panel-slot")).not.toBeInTheDocument();
  });

  it("activePanel：legend 面板打开时渲染 legendPanel 槽位", () => {
    renderRail({ openOverlayPanel: "legend" });
    expect(screen.getByText("legend-panel-slot")).toBeInTheDocument();
    expect(screen.queryByText("controls-panel-slot")).not.toBeInTheDocument();
  });

  it("minimal 密度：摘要降级为紧凑 Tag + data 胶囊，quick legend 不展示", () => {
    renderRail({ overlayDensity: "minimal" });
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("data label")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "⟦dashboard.charts.warMap.legend.quickLegendCompactHint⟧",
      ),
    ).not.toBeInTheDocument();
  });

  it("standalone 布局：无 quick legend、无 legend 工具按钮，无 activePanel", () => {
    renderRail({ layoutVariant: "standalone", openOverlayPanel: "controls" });
    expect(
      screen.queryByText(
        "⟦dashboard.charts.warMap.legend.quickLegendCompactHint⟧",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "⟦dashboard.charts.warMap.legend.title⟧" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("controls-panel-slot")).not.toBeInTheDocument();
  });

  it("useDrawerControls：面板不由 rail 承载（activePanel 为空）", () => {
    renderRail({ useDrawerControls: true, openOverlayPanel: "controls" });
    expect(screen.queryByText("controls-panel-slot")).not.toBeInTheDocument();
  });

  it("hidden count > 0 时显示 more 按钮并触发 onToggleLegend", async () => {
    const onToggleLegend = vi.fn();
    // 基础 8 项 + 3 附加项 = 11 项 > expanded 上限 7 → hidden 4
    const manyItems: WarMapLegendItem[] = [
      ...quickLegendItems,
      {
        key: "extra-1",
        symbolKey: "generic-point",
        label: "extra one",
      },
      {
        key: "extra-2",
        symbolKey: "generic-point",
        label: "extra two",
      },
      {
        key: "extra-3",
        symbolKey: "generic-point",
        label: "extra three",
      },
    ];
    renderRail({ quickLegendItems: manyItems, onToggleLegend });
    const moreButton = screen.getByRole("button", { name: "+4 more" });
    await userEvent.click(moreButton);
    expect(onToggleLegend).toHaveBeenCalledTimes(1);
  });

  it("refreshing 状态：refresh 按钮显示 loading 语义", () => {
    renderRail({ refreshingMapData: true });
    expect(
      document.querySelector(".ant-btn-loading"),
    ).not.toBeNull();
  });
});

function railProps(overrides?: Partial<WarMapOverlayRailProps>) {
  return {
    overlayRailRef: createRef<HTMLDivElement>(),
    overlayDensity: "expanded" as const,
    layoutVariant: "embedded" as const,
    overlayTopClassName: "top-4",
    overlayRailWidth: 272,
    useDrawerControls: false,
    summaryStatusCards,
    summaryDataLabel: "data label",
    refreshingMapData: false,
    showActionLabels: true,
    openOverlayPanel: null,
    quickLegendItems,
    onRefresh: vi.fn(),
    onToggleControls: vi.fn(),
    onToggleLegend: vi.fn(),
    controlsPanel: <div>controls-panel-slot</div>,
    legendPanel: <div>legend-panel-slot</div>,
    t,
    ...overrides,
  };
}
