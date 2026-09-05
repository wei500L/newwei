import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { WarMapOverlayRail } from "./war-map-overlay-rail";
import type { WarMapOverlayRailProps } from "./war-map-overlay-rail-types";
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

const summaryStatusCards: WarMapOverlayRailProps["summary"]["statusCards"] = [
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

function railProps(overrides?: {
  openPanel?: WarMapOverlayRailProps["layout"]["openPanel"];
  layout?: Partial<WarMapOverlayRailProps["layout"]>;
  quickLegend?: Partial<WarMapOverlayRailProps["quickLegend"]>;
  onRefresh?: () => void;
  onToggleControls?: () => void;
  onToggleLegend?: () => void;
  onItemFocus?: (key: string | null) => void;
  onItemHover?: (key: string | null) => void;
  refreshing?: boolean;
}): WarMapOverlayRailProps {
  return {
    overlayRailRef: createRef<HTMLDivElement>(),
    layout: {
      density: "expanded",
      variant: "embedded",
      topClassName: "top-4",
      railWidth: 272,
      useDrawerControls: false,
      showActionLabels: true,
      openPanel: overrides?.openPanel ?? null,
      ...overrides?.layout,
    },
    summary: {
      statusCards: summaryStatusCards,
      dataLabel: "data label",
    },
    refreshing: overrides?.refreshing ?? false,
    quickLegend: {
      items: quickLegendItems,
      ...overrides?.quickLegend,
    },
    actions: {
      onRefresh: overrides?.onRefresh ?? vi.fn(),
      onToggleControls: overrides?.onToggleControls ?? vi.fn(),
      onToggleLegend: overrides?.onToggleLegend ?? vi.fn(),
    },
    panels: {
      controls: <div>controls-panel-slot</div>,
      legend: <div>legend-panel-slot</div>,
    },
    t,
  };
}

function renderRail(
  overrides?: Parameters<typeof railProps>[0],
): ReturnType<typeof render> {
  const props = railProps({
    ...overrides,
    quickLegend: {
      ...overrides?.quickLegend,
      onItemFocus: overrides?.onItemFocus ?? undefined,
      onItemHover: overrides?.onItemHover ?? undefined,
    },
  });
  // re-apply focus/hover after spread of defaults
  const full: WarMapOverlayRailProps = {
    ...props,
    quickLegend: {
      ...props.quickLegend,
      onItemFocus: overrides?.onItemFocus,
      onItemHover: overrides?.onItemHover,
    },
  };
  return render(<WarMapOverlayRail {...full} />);
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
      openPanel: "controls",
    });
    const controlsButton = screen.getByRole("button", {
      name: "⟦dashboard.charts.warMap.overlay.controls⟧",
    });
    expect(controlsButton).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(controlsButton);
    expect(onToggleControls).toHaveBeenCalledTimes(1);

    rerender(<WarMapOverlayRail {...railProps({ openPanel: null })} />);
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
    // 8 项 > expanded 上限 7 → hidden 1（+1 more 不应误显示为其它数量）
    expect(
      screen.queryByRole("button", { name: "+2 more" }),
    ).not.toBeInTheDocument();
  });

  it("quick legend 项点击触发聚焦，hover/leave 触发 hover 回调", async () => {
    const onItemFocus = vi.fn();
    const onItemHover = vi.fn();
    renderRail({ onItemFocus, onItemHover });
    const firstItem = screen.getByRole("button", {
      name: /⟦dashboard\.charts\.warMap\.legend\.signalHigh⟧/,
    });
    await userEvent.hover(firstItem);
    expect(onItemHover).toHaveBeenCalledWith("signal-high");
    await userEvent.unhover(firstItem);
    expect(onItemHover).toHaveBeenCalledWith(null);
    await userEvent.click(firstItem);
    expect(onItemFocus).toHaveBeenCalledWith("signal-high");
  });

  it("已有 active 项时点击同项取消聚焦（null）", async () => {
    const onItemFocus = vi.fn();
    renderRail({
      quickLegend: { activeKey: "signal-high" },
      onItemFocus,
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: /⟦dashboard\.charts\.warMap\.legend\.signalHigh⟧/,
      }),
    );
    expect(onItemFocus).toHaveBeenCalledWith(null);
  });

  it("面板打开时 quick legend 隐藏，legend 工具按钮出现", () => {
    renderRail({ openPanel: "controls" });
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
    renderRail({ openPanel: "controls" });
    expect(screen.getByText("controls-panel-slot")).toBeInTheDocument();
    expect(screen.queryByText("legend-panel-slot")).not.toBeInTheDocument();
  });

  it("activePanel：legend 面板打开时渲染 legendPanel 槽位", () => {
    renderRail({ openPanel: "legend" });
    expect(screen.getByText("legend-panel-slot")).toBeInTheDocument();
    expect(screen.queryByText("controls-panel-slot")).not.toBeInTheDocument();
  });

  it("minimal 密度：摘要降级为紧凑 Tag + data 胶囊，quick legend 不展示", () => {
    renderRail({ layout: { density: "minimal" } });
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("data label")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "⟦dashboard.charts.warMap.legend.quickLegendCompactHint⟧",
      ),
    ).not.toBeInTheDocument();
  });

  it("standalone 布局：无 quick legend、无 legend 工具按钮，无 activePanel", () => {
    renderRail({ layout: { variant: "standalone" }, openPanel: "controls" });
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
    renderRail({ layout: { useDrawerControls: true }, openPanel: "controls" });
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
    renderRail({
      quickLegend: { items: manyItems },
      onToggleLegend,
    });
    const moreButton = screen.getByRole("button", { name: "+4 more" });
    await userEvent.click(moreButton);
    expect(onToggleLegend).toHaveBeenCalledTimes(1);
  });

  it("refreshing 状态：refresh 按钮显示 loading 语义", () => {
    renderRail({ refreshing: true });
    expect(document.querySelector(".ant-btn-loading")).not.toBeNull();
  });
});
